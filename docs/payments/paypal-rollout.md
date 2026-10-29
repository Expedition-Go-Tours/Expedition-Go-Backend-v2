# PayPal — rollout notes

PayPal is the second payment provider, sitting beside Stripe rather than replacing
it. Stripe stays the default and the fallback: if PayPal is switched off, missing
or misconfigured, checkout degrades to Stripe and nothing else changes.

Scope for this release:

- one-time, pay-now checkout (`paymentTiming: 'now'`)
- refunds
- Ghana and Expedition storefronts
- USD only

Explicitly **not** in scope (they stay Stripe-only): pay-later charges, saved
cards, supplier payment links, supplier payouts and booking-modification
top-ups.

---

## Schema

All additive. No column is renamed or retyped, so the migration is safe to apply
to a live database with in-flight bookings:

| Change | Notes |
| --- | --- |
| `PaymentProvider` enum | `STRIPE` (default), `PAYPAL` |
| `Booking.paymentProvider` | default `STRIPE`; legacy rows keep it |
| `Booking.paypalOrderId` / `paypalCaptureId` (unique) | capture id is the refund anchor |
| `Booking.paypalRefundId` / `paypalRefundStatus` | pending refunds are polled by the sweep |
| `CheckoutDraft.paymentProvider` / `paypalOrderId` (unique) | lets the webhook resolve the draft |
| `BookingPaymentAttempt.paymentProvider`, `paypalOrderId`, `paypalCaptureId`, `paypalRefundId` | |
| `BookingPaymentReconciliation.paymentProvider`, `paypalCaptureId` (unique), `paypalRefundId` | |
| `BookingPaymentReconciliation.stripePaymentIntentId` | now nullable (a PayPal row has no PaymentIntent) |
| `PaypalEvent` | webhook inbox, deduped on `paypalEventId` |

Migration: `prisma/migrations/20261029120000_add_paypal_payments/migration.sql`.

---

## Environment

```
PAYPAL_ENABLED=false            # kill switch for NEW checkouts only
PAYPAL_MODE=sandbox             # sandbox | live
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
PAYPAL_BRANDS=                  # e.g. ghana,expedition
```

Two flags, deliberately:

- `PAYPAL_ENABLED` gates **new checkouts only**. Webhook verification, the
  capture sweep and pending-refund reconciliation keep working while it is off,
  so in-flight money still settles.
- `PAYPAL_BRANDS` gates **which storefronts** offer it. A brand that is not
  enrolled silently falls back to Stripe.

PayPal needs credentials (`PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET`) for
anything to work, including reading a capture during reconciliation.

---

## Rollout order

1. **Deploy the migration.** It is additive and touches no Stripe column.
2. **Create a PayPal app** (Developer Dashboard → My Apps & Credentials →
   sandbox, then live). Copy the client id/secret. In the live app, set the
   redirect URL list to include
   `https://travioghana.com/booking/paypal/return` and
   `https://expeditiongotours.com/booking/paypal/return`.
3. **Create the webhook** in the PayPal app pointing at
   `https://apiv1.travioafrica.com/api/webhooks/paypal` (Ghana) and
   `https://api.expeditiongotours.com/api/webhooks/paypal` (Expedition) —
   both host the same API. Subscribe at minimum to:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.PENDING`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `PAYMENT.CAPTURE.REVERSED`

   Copy the **webhook id** into `PAYPAL_WEBHOOK_ID` — verification fails
   without it.
4. **Sandbox run.** Set the sandbox credentials, then:

   ```bash
   npm run test:paypal:sandbox
   ```

   This creates an order, captures it, reads it back, refunds it and polls the
   refund to completion, without touching a browser. It refuses to run unless
   `PAYPAL_MODE=sandbox`.
5. **Full end-to-end** in sandbox: start a checkout with
   `paymentProvider: "paypal"`, approve on the PayPal page, confirm the return
   page produces exactly one Booking, then cancel it and confirm the refund.
   Repeat with the webhook path forced (do not call the return route) to prove
   the webhook settles on its own.
6. **Switch to live.** Set `PAYPAL_MODE=live`, real credentials, a live webhook
   id and the live webhook URL. Still leave `PAYPAL_ENABLED=false`.
7. **Enable**: set `PAYPAL_ENABLED=true` and `PAYPAL_BRANDS=ghana,expedition`.
   Leave Stripe as the storefront default and offer PayPal as an explicit choice.

### Backing out

Set `PAYPAL_ENABLED=false`. New checkouts immediately use Stripe. Nothing
already captured is affected — webhooks, the cleanup sweep and refund
reconciliation all keep running, so in-flight PayPal bookings still settle and
can still be refunded.

---

## Storefront wiring

Two repos, same components, different endpoint prefixes:

| Repo | Brand | Endpoints |
| --- | --- | --- |
| `TravioGhana-Store` | travioghana.com | `/api/travioghana/*` |
| `Expedition-Go-Lite` | expeditiongotours.com | `/api/expedition/*` |

Endpoints added for the UI (both brands):

| Endpoint | Purpose |
| --- | --- |
| `GET /payments/capabilities?currency=&timing=` | Public. Tells the storefront which payment methods it may offer, derived from **the same predicate checkout uses** (`paypalAvailability` ← `resolveProvider`), so the UI can never advertise a method the server would then swap for Stripe. Returns `{ paypal: { available, reason, currencies, mode }, stripe: { available } }`. |
| `GET /checkout/paypal/approval/:orderId` | Re-issues the hosted approval link for an open hold (page refresh mid-flow), to the signed-in owner only. PayPal returns `rel: "approve"` on a plain order read, so nothing is stored for this. |

How the storefront uses them:

1. **`PaymentDetailsStep`** asks `usePaymentCapabilities('USD', 'now')` and
   renders a *Card* / *PayPal* choice only when `paypal.available` — when it is
   unavailable the option is **hidden**, not shown disabled (no "Coming soon"
   badge), and `selectedMethod` falls back to `card` on its own.
2. **`handleBook`** sends `paymentProvider: 'paypal' | 'stripe'` for pay-now only
   (pay-later is always a card), then **branches on the response**, not on what
   it asked for: `payment.provider === 'paypal' && approvalUrl` → full-page
   `window.location.assign`. That is what makes the server's silent fallback to
   Stripe safe.
3. **`/booking/paypal/return`** (exact path — the backend hardcodes it in
   `return_url`) reads `?token=`, captures once, and handles: signed-out →
   login and back, `200` → confirmation, `202` → keep polling
   `by-paypal-order`, `402/409` → the backend's own message, terminal hold →
   an honest "refunded / expired" panel. It never declares success itself.
4. **`BookingConfirmationPage?paypal_order=`** polls the PayPal counterpart of
   `by-session` (same response shape), then redirects to the canonical
   `/booking/confirmation/:bookingId`.
5. **`CheckoutPage`** detects `draft.payment.provider === 'paypal'` (a PayPal
   draft has no `clientSecret`) and renders *Continue to PayPal* / *Confirming
   your payment* instead of falling into the "Checkout unavailable" state.

> Note: the Ghana backend has no `GET /checkout/draft/:id` route — Ghana's
> pay-now flow still uses Stripe's hosted Checkout, so `TravioGhana-Store`'s
> `CheckoutPage` is unreachable there today. Its PayPal branch is written and
> compiled for parity with Expedition, which does serve that route.

---

## How a payment settles

```
checkout ─► acquireHold (CheckoutDraft, HOLDING, seats reserved)
        └► PayPal create order ─► approvalUrl
                                    │
       customer approves ───────────┤
                                    │
   return route: capture ───────────┤        webhook: PAYMENT.CAPTURE.COMPLETED
                                    ▼
                        settlePaypalOrder(orderId)
                                    │
                  ┌─────────────────┴─────────────────┐
                  │ materializeHold(draft, session,    │
                  │   null, {provider, captureId})     │
                  └───────────────────────────────────┘
```

`materializeHold` is the single booking-creation path, guarded by a tour row
lock and a `HOLDING` status check, so the return route and the webhook can race
each other and only one creates a Booking. Both send the customer, the supplier
and the admin through the same `notifyBookingsSettled` path Stripe uses.

Money that arrives when it cannot become a booking is **never** silently kept:

| Situation | Action |
| --- | --- |
| capture arrives after the hold expired | full auto-refund, draft `REFUNDED` |
| amount or currency differs from the frozen price | full auto-refund, reason `AMOUNT_MISMATCH` |
| capacity gone (oversold) | full auto-refund, reason `BOOKING_TERMINAL` |
| no draft matches the capture | recorded as `UNMAPPED_PAYMENT` / `UNMATCHED`, `#sales` alerted — **not** auto-refunded, a human decides |

Every refund uses a deterministic idempotency key
(`paypal-auto-refund-<captureId>`, `paypal-refund-<bookingId>-<amount>-<reason>`),
so a replayed webhook or a retry after a timeout cannot refund twice.

---

## Refunds

Call `refundBookingPayment(booking, amountMinor, opts)` — never Stripe or PayPal
directly. It reads `booking.paymentProvider` and routes accordingly, returning a
Stripe-shaped result so callers stay unchanged.

PayPal refunds can settle asynchronously. A `PENDING` refund stores its id on
`Booking.paypalRefundId` / `paypalRefundStatus`, and
`reconcilePendingPaypalRefunds()` (run from the pay-later sweep) polls it to a
terminal state and marks the booking `REFUNDED` only when PayPal says so.

---

## What is intentionally Stripe-only

- **Pay-later / reserve-now-pay-later** — needs a card on file, which PayPal has
  no equivalent for here.
- **Booking-modification top-ups** — a price increase needs a fresh payer
  approval; the modify route returns a 400 telling the customer to contact
  support.
- **Supplier payment links, Connect payouts** — Stripe Connect only.

---

## Observability

- `#sales` receives a payment-received embed on settlement, a refund embed on
  refunds, and an **unmapped-payment** alert for any capture no booking owns.
- `logActivity` records `payment.paypal.settled`, `payment.paypal.unmapped` and
  `payment.paypal.late_capture_refunded`.
- `PaypalEvent` keeps every delivery (including failures, with the error) so a
  lost webhook can be re-driven from the retry queue
  (`process-paypal-webhook` job).

---

## Verification

These run against the real PayPal sandbox (they move sandbox money):

| Command | What it proves |
| --- | --- |
| `npm run test:paypal:sandbox` | order create → capture → read → refund → refund settles |
| `npm run probe:paypal:webhook` | the webhook is mounted with a raw body and gated by PayPal's own verification call |
| `npm run probe:paypal-hold-sweep` | an unapproved PayPal hold is released by the expiry sweep, and a fresh one is left alone |
| `npm run test:e2e:paypal` | full storefront flow: checkout → capture → one Booking tagged `PAYPAL` with no Stripe ids → repeat capture is a no-op → poll endpoint → refund → `REFUNDED` |

Endpoints, against a running server:

| Check | Result |
| --- | --- |
| `GET /payments/capabilities` (both brands) | `available:true` for USD now; `unsupported_timing` for `timing=later`; `unsupported_currency` for `GHS`; no credentials in the payload |
| `GET /checkout/paypal/approval/:orderId` | owner → `approvalUrl` from PayPal's `rel: "approve"`; unknown order → 404; no token → 401 |

Storefront, driven in a real browser (Playwright) against the local backend:

- the *Pay with* choice renders **with the capabilities response**, and the
  "Coming soon" badge is gone;
- choosing PayPal switches the button to **"Pay with PayPal"**;
- the `POST …/checkout/confirm` body carries `"paymentProvider":"paypal"`;
- the response branch navigates the browser to
  `https://www.sandbox.paypal.com/checkoutnow?token=…`.

Tests: backend `npx jest` (4,045 passed), `eslint src` (0 errors);
`TravioGhana-Store` vitest 1,287 passed + `tsc`/`vite build` clean;
`Expedition-Go-Lite` vitest 1,108 passed + `tsc`/`vite build` clean.

`test:e2e:paypal` needs a human to approve the order on PayPal's page, so it
takes `--await-approval` (default 5 minutes, `PAYPAL_APPROVAL_TIMEOUT_MS` to
change) and prints the URL to click. It writes its token/order id to
`$TMPDIR/paypal-e2e-state.json` so a run can be resumed against the same order
with `E2E_RESUME_ORDER_ID` instead of starting a second checkout.

---

## Open items

- [x] Sandbox credentials provisioned and stored in `.env` (sandbox app only —
      the same pair returns 401 against the live host).
- [x] Sandbox webhook created: `3H327050B38880631` →
      `https://apiv1.travioafrica.com/api/webhooks/paypal`
      (6 events). The **live** app still needs its own webhook id per host, and
      each API host needs its own: `api.travioghana.com`,
      `api.expeditiongotours.com`, `apiv1.travioafrica.com`.
- [ ] Capture + refund of a real sandbox order (needs a sandbox buyer login to
      approve the order).
- [ ] Confirm the PayPal business account can receive **USD** and withdraw it
      (the whole catalogue is USD, so a GHS wallet would break settlement).
- [ ] PayPal identifiers are stripped from supplier- and customer-facing
      responses by `sanitizeBookings`; admin tools see the raw rows.
