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

## 6. What is deliberately NOT here
- No second pricing engine, no second availability engine.
- No Stripe involvement for offline money (a POS charge collected outside the
  platform is an offline collection, not a Stripe payment).
- No email-based account matching for guests.
