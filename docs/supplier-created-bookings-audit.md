# Supplier-Created Bookings — Implementation Audit & Design

Audit of the real code paths (not their names) before changing anything. The
companion `supplier-created-bookings-ui-audit.md` covers the UI contract.

## 1. How a booking exists today (verified in code)

| Stage | Where it actually happens |
|---|---|
| Pricing | `tourHelpers.calculateTourPrice(tour, travelers, date, time, …)` — the single pricing engine (options, tiers, offers, promos) |
| Commission | `stripeHelpers.calculateCommission(total)` — server-side rate |
| Inventory | `availabilityCore.evaluateBookingAvailability(tx, tour, date, time, travelers, { excludeBookingId, optionScope })` — called INSIDE a transaction after locking the tour row (`SELECT … FOR UPDATE`), respects overrides, slots, per-group inventory, cutoffs |
| Creation | `bookingController` checkout path: booking + number, `paymentStatus: 'PENDING'` (pay-now) or pay-later semantics |
| Money | `paymentStatus` (PENDING/PROCESSING/SUCCEEDED/FAILED/CANCELLED/REFUNDED) + Stripe intent id |
| Attribution | `Booking.source` (GHANA/EXPEDITION/TRAVIO) = which STOREFRONT, not who created it |
| Payout | `payoutRuns.selectEligibleBookings` + `financeHelpers.payoutBookingsWhere({ payoutStatus })` → `InvoiceItem` (`bookingId @unique`) → payout requests; `SupplierCharge` rows are OPEN charges netted off the next payout request |
| Cancellation | `supplierCancellation.cancelBySupplier` + `bookingRefundState` + Stripe refund helpers |

## 2. The boundaries that must not be crossed

1. **`payoutStatus` is the money gate.** `payoutBookingsWhere` filters on it; a
   supplier-created booking whose cash the supplier already holds must never
   become `ELIGIBLE`, or the platform pays them twice.
2. **`paymentStatus = SUCCEEDED` means a PLATFORM-collected payment.** An
   offline cash collection must never set it — everything that reads it
   (payout eligibility, review prompts, emails) assumes a real charge.
3. **`InvoiceItem.bookingId @unique`** means one invoice line per booking; a
   supplier-created booking must not be invoiced as platform revenue.
4. **`customerId` is NOT NULL** — walk-ins have no account. Every consumer of
   `booking.customerId` must be audited before it becomes optional.

## 3. Design

### Schema (additive, one explicit migration)
- `Booking.origin` — enum `MARKETPLACE | SUPPLIER_CREATED`, `@default(MARKETPLACE)`.
  Historical rows are correct by default; `source` keeps meaning storefront.
- `Booking.customerId` → optional; new `BookingGuest` (name, phone, email,
  notes) linked `@optional`. No fake users, no email-based auto-attachment.
- `BookingCollection` — one row per money event: amount (Decimal, same
  precision as the rest of the model), currency, method (CASH / MOBILE_MONEY /
  BANK_TRANSFER / POS / OTHER), status (RECORDED / REVERSED), collectedAt,
  recordedById, externalRef, note, `@unique([bookingId, idempotencyKey])`.
- `BookingIdempotencyKey` — `@unique([supplierId, key])`, stores the canonical
  request hash + resulting booking id; replay returns the original, a different
  body returns 409.
- Indexes: `Booking(origin)`, `BookingCollection(bookingId)`,
  `BookingCollection(supplierId, collectedAt)`.

### Money & commission
- Collections are recorded, never marked as platform payments.
- Commission follows the **existing** `SupplierCharge` mechanism (the same path
  the cancellation fee uses): an OPEN charge netted off the supplier's next
  payout request. No second settlement ledger.
- Policy is server-side config, snapshotted onto the booking; a waiver is an
  explicit, audited action. The supplier never chooses the rate.
- Commission applies to money actually COLLECTED, not to unpaid reservations.

### Payout & invoices
- `payoutBookingsWhere` and the invoice sweep explicitly exclude
  `origin = 'SUPPLIER_CREATED'` (they are not platform-collected revenue).
- Their financial truth lives in `BookingCollection` + `SupplierCharge`, and is
  surfaced in the finance UI as "Recorded as collected" / "you owe …".

### Notifications
- Out of the transaction: `enqueueEmail`/`enqueueNotification` after commit
  (the repo's durable queue), never inside it.
- Supplier-facing mail uses the existing relay (`services/supplierContact`) —
  a guest with no email simply gets no customer mail; the relay is never faked.

## 4. Endpoints (Ghana namespace — the deployed frontend's namespace)

`POST   /api/travioghana/supplier/bookings`              create (idempotent)
`POST   /api/travioghana/supplier/bookings/quote`        server-authoritative price
`GET    /api/travioghana/supplier/bookings/:id/collections`  collection history
`POST   /api/travioghana/supplier/bookings/:id/collections`  record a collection
`POST   /api/travioghana/supplier/bookings/:id/refunds`      record an offline refund
`GET    /api/travioghana/supplier/bookings/:id/voucher`      printable confirmation

All behind `protect` + `resolveSupplier` + `requireTeamPermission('bookings.manage')`,
strict zod bodies, no client control of supplier/origin/status/pricing/commission.

## 5. Rollout
Feature flag (server config), **off by default**, enabled per brand and per
supplier. The backend rejects when disabled — never only the button.

| Step | What happens | Rollback |
|---|---|---|
| 0 | Merge. Migration is additive (`origin` defaults to `MARKETPLACE`, `customerId` stays populated for every existing row). Flag reads `false`. | Revert the deploy; nothing behavioural changed. |
| 1 | `npx prisma migrate deploy` on the box during a normal deploy window. | Migration is forward-compatible; revert code only. |
| 2 | Set `feature.supplierCreatedBookings.ghana = true` in the config service (one supplier at a time if desired — gate on `bookings.manage` membership meanwhile). | Set it back to `false`. Every route 403s within the request; already-recorded bookings and collections stay exactly as they are. |
| 3 | Watch: `SupplierCharge` rows with reason `SUPPLIER_COMMISSION`, BookingCollection volume, and payout request totals (they must NOT grow with collections). | — |
| 4 | Commission policy stays `APPLY`; a `WAIVE` is a deliberate per-case config change, recorded on the booking and in the audit log. | — |

**Rollout status (2026-10-23).** Steps 0 and 1 are done in production: the
migration is applied and the code is deployed. Step 2 is also done — the flag
was switched on directly in the `SystemConfig` table, with the same key the
backend reads (`feature.supplierCreatedBookings.ghana = true`). Nothing reloads
config, so the change is live without a restart.

Rollback for step 2: set that key back to `false`. Every create/quote/collection
route 403s within the request; bookings and collections already recorded stay
exactly as they are.

Deploy note: this box has **no CI deploy workflow and no cron** — `git pull`
gets the source onto the box, but the API process only picks it up when
reloaded as `deploy` (`pm2 reload expedition-api`). Never run pm2 as root: a
second daemon under `/root/.pm2` competes with the deploy-owned one.

## 6. Definition of done

Delivered and verified (tests executed, not asserted):

- [x] `docs/supplier-created-bookings-audit.md` + `supplier-created-bookings-ui-audit.md`
- [x] Additive migration; CI's `prisma migrate diff` guard reports no drift
- [x] `customerId` optional + `BookingGuest`; no fake users, no email matching
- [x] `BookingCollection` (partial, refunds, corrections that preserve the
      original) + per-booking idempotency + `Booking.origin`
- [x] One transaction per create: tour row locked → availability → booking +
      guest + snapshot + collection + charge + audit → commit → then mail
- [x] Pricing and commission from the existing engines, snapshotted; the
      client controls neither
- [x] Commission = an OPEN `SupplierCharge` per collection (the cancellation
      fee's ledger), waiver recorded; no charge on unpaid reservations
- [x] `payoutBookingsWhere` (and through it `eligibleBookingsWhere`, payout
      requests and the invoice sweep) excludes `SUPPLIER_CREATED` — proven in
      the worst case by `__tests__/api/supplierCreatedBookings.test.js` #10
- [x] Endpoints behind `bookings.manage` / `bookings.view`, strict zod bodies
- [x] Feature flag, off by default, rejected server-side when off (scenario 12)
- [x] Notifications after commit via the existing queue; a guest with no email
      gets none; relay minted for registered customers, never the real address
- [x] 21 unit + 14 DB-gated API tests, incl. the twelve named scenarios
      (walk-in cash, MoMo reference, unpaid-then-paid, partials, masked
      registered customer, concurrent last-place race, offline refund, waiver,
      receivable, marketplace unchanged, idempotent resubmission, guest data
      protected)
- [x] Wizard + 5 frontend tests; supplier suite 1,019 green, build green

Not in this delivery (honest gaps, none of them silent):

- [ ] Browser-level Playwright flows for the wizard. The twelve scenarios are
      covered end-to-end at the HTTP + database boundary, where the money
      rules live; the UI has component tests but no browser script yet.
- [ ] List/detail presentation of the new state: the `origin` pill, the
      collection block ("Recorded as collected … Outstanding …"), origin and
      collection-state filters, and CSV columns. The wizard and the API carry
      these facts; the list surfaces do not yet show them.
- [ ] `GET /bookings/:id/voucher` (printable confirmation).
- [ ] Per-booking "you owe" line in the finance UI: the commission charge
      exists and is netted off payout requests, but is not yet listed per
      booking on the finance page.

## 7. What is deliberately NOT here
- No second pricing engine, no second availability engine.
- No Stripe involvement for offline money (a POS charge collected outside the
  platform is an offline collection, not a Stripe payment).
- No email-based account matching for guests.
