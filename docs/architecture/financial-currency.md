# Financial currency: the GHS/USD inconsistency

## Finding

The backend has no single answer to "what currency is this amount?". Different
code paths assume different defaults, and one reporting path adds amounts from
different currencies together. Nothing here is a payment-processing bug today —
commission is a percentage and payouts are grouped by currency — but the
inconsistency produces wrong numbers on a supplier dashboard and silently
disables one money control.

Currency is stored per booking (`Booking.currency`, `StayBooking.currency`) and
per payout object (`PayoutRequest.currency`, `StayPayoutRequest.currency`). Those
are correct. The problem is everything that **defaults** or **aggregates**.

## Evidence

### Defaults disagree within the same product

| Location | Default | Applies to |
| --- | --- | --- |
| `src/brands/ghana/staysController.js:115` | `GHS` | new Stays property |
| `src/brands/ghana/staysController.js:273` (calendar response) | `GHS` | availability calendar |
| `src/brands/ghana/staysBookingsController.js:341` | `GHS` | supplier-created stay booking |
| `src/core/services/supplierApplicationPayload.js:203` | `GHS` | bank-transfer payout method |
| `src/core/services/supplierApplicationPayload.js:222` | `GHS` | mobile-money payout method |
| `src/core/services/supplierApplicationPayload.js:214` | `USD` | PayPal payout method |
| `src/core/services/storefront.js:70` | `USD` | Tours pricing |
| `src/core/domain/admin.js:64` | `USD` | admin revenue aggregate |
| `src/brands/ghana/staysFinanceController.js:51,112,276,368,410,522` | `USD` | finance rows missing a currency |

The same supplier application function assigns `GHS` to a Ghanaian bank account
and `USD` to a PayPal account. That may be a deliberate product decision, but it
is not written down anywhere, and it means one supplier can hold payout methods
in two currencies with no rule about which one a payout uses.

### Reporting used to add currencies together

`src/brands/ghana/staysAnalyticsController.js`:

- `getAnalyticsSummary` (line ~112) calls
  `stayBooking.aggregate({ _sum: { amount: true } })` with **no `groupBy:
  currency`**.
- `getPropertyAnalytics` (line ~152) does the same per property.

If a supplier has one GHS booking and one USD booking, the dashboard reports
`amount_ghs + amount_usd` as "total earnings". The number is meaningless and
looks authoritative.

`staysFinanceController.getSummary` has the same shape:

- line 112 picks `bookings.find(b => b.currency)?.currency || 'USD'` — the
  **first** booking's currency labels the whole balance;
- `sum(available)` and `sum(pending)` then add every booking regardless of its
  currency;
- `inReview` sums `StayPayoutRequest.amount` across currencies too.

So `availableBalance: { amount: 5400 }` with `currency: 'GHS'` can include USD
bookings.

The payout **request** path was already correct: `createPayoutRequest`
refuses to combine currencies and tells the supplier to request each separately.
That made the dashboard/summary inconsistency worse: the UI showed a combined
balance and the request then failed.

**Fixed on 2026-11-16.** `getAnalytics`, `getAnalyticsSummary`,
`getPropertyAnalytics`, `getMonthlyRevenue`, `getSummary` and `getEarnings` now
group every amount by currency. The legacy scalar fields are scoped to one
primary currency (the largest bucket; finance prefers available balance); the
full split is returned in `currencies`; `mixedCurrencies` flags a split.
`__tests__/api/staysCurrencyReporting.test.js` creates one GHS and one USD
booking and asserts that no response contains a mixed total.

### A refund control can be silently disabled

`refundClaimController.js` implements two-person approval for refunds at or above
a configurable threshold. `releaseThreshold` (line 189) accepts either a scalar
or a per-currency map:

```js
const key = String(currency || 'USD').toUpperCase();
const value = parsed[key] ?? parsed.default;
if (value == null) return null;   // fixed: was 0, which disabled the control
```

and the caller treats `0` as "control disabled":

```js
if (!threshold || amount < threshold) return { proceed: true };
```

Consequences:

- A scalar threshold of `500` is applied to GHS and USD identically, so a
  500 GHS refund (~USD 35) needs two approvals while a 500 USD refund also does.
  The policy is currency-blind.
- A map configured as `{"USD": 500}` and nothing else **used to** return `0`
  for a GHS claim, which turned the second approval off. It now returns `null`,
  so the caller falls back to the built-in threshold. The scalar-versus-map
  policy is still a configuration decision.

Status: the parsing fix is merged and covered by
`__tests__/unit/refundClaimPayout.test.js`.

## What is *not* wrong

- `calculateCommission` (`src/core/services/stripeHelpers.js:667`) is a ratio,
  not an amount. It is currency-neutral and needs no change.
- Payment intents are created in the booking's own currency.
- Payout requests carry a single currency and refuse mixed input.
- Accounting columns (`amount`, `platformCommission`, `supplierPayout`) are
  `Decimal`, not floats.

## Proposed resolution

### 1. Make currency explicit at creation

- Keep GHS as the default **only** for Ghana-branded Stays properties, and make
  it an explicit value in the property payload rather than a silent fallback.
- When a booking is created, take the currency from the property, and reject the
  request if the property has no currency rather than inventing one.
- Replace `row.currency || 'USD'` in finance/reporting with `row.currency ||
  property.currency`; a missing currency on a money row should be a data error,
  not a default.

### 2. Never aggregate across currencies — implemented

The Stays analytics and finance summaries now group by currency. Each response
keeps its legacy scalar fields for the primary currency and adds:

```json
{
  "currency": "GHS",
  "mixedCurrencies": true,
  "currencies": [
    { "currency": "GHS", "grossBookingValue": 3200 },
    { "currency": "USD", "grossBookingValue": 410 }
  ]
}
```

Finance uses `supplierPayout` for its buckets; analytics uses `amount`. The
dashboard should show one line per currency, and label the scalar as the primary
currency rather than "total". A frontend that ignores `currencies` still sees a
correct single-currency figure, never a mixed sum.

### 3. Fail closed on the refund threshold

- If a currency map is configured, require an exact key or an explicit
  `default`. A missing key must return `null` (misconfigured); the caller then
  falls back to the built-in threshold instead of treating the claim as
  below-threshold and releasing it on one admin's click.
- Status: the parsing fix is implemented in `fix/refund-threshold-currency`
  (`releaseThreshold` returns `null` for a missing key, with tests). The
  currency map itself is still a configuration decision — see the default below.
- Set the shipped default as a map keyed by the currencies actually in use:
  `{"USD": 500, "GHS": 6000}` — roughly equivalent at current rates, and
  reviewable as policy.
- Log when a currency is missing from the map, so the gap is visible before a
  large refund hits it.

### 4. Decide the payout-method rule

Pick one and document it:

- **Option A (recommended):** the payout currency is the supplier's settlement
  currency, and every payout method must match it. A supplier with GHS
  settlement cannot attach a USD PayPal account.
- **Option B:** multiple payout methods may exist in different currencies, and a
  payout request specifies the method; the request currency must equal the
  method currency. This is more flexible and more code.

Option A matches how the payout request already behaves and requires validation
at method creation, not a new money-flow model.

### 5. Add a `currency` invariant test — implemented

`__tests__/api/staysCurrencyReporting.test.js` creates one GHS and one USD
booking for the same supplier and asserts:

- `getAnalyticsSummary` and `getAnalytics` return two buckets, with the headline
  scoped to one currency;
- property and monthly revenue expose `revenueByCurrency` / `series`;
- `getSummary` and `getEarnings` return one bucket per currency;
- `createPayoutRequest` continues to refuse a mixed selection (covered by the
  existing finance tests).

## Migration

No schema change is required for steps 1–4. The sequence:

1. Deploy the stricter validation (reject missing currency on new properties and
   bookings). Existing rows are untouched.
2. Deploy grouped aggregates. The dashboard must accept the new shape; return
   the old shape behind a query flag during the frontend release if needed.
3. Backfill `currency` on rows where it is null, using the property's currency;
   report anything still null for manual review.
4. Fix the refund threshold configuration (`admin settings`) and deploy the
   fail-closed behaviour. Verify with a small GHS claim in staging or against the
   test database.

Step 3 is the only one that touches production data, and it is an `UPDATE` with a
reviewed predicate — not a destructive migration.

## Decision needed

The product question is not technical: **should a supplier be able to settle in
more than one currency?** If yes, Option B and grouped reporting are both
required. If no, Option A plus grouped reporting is sufficient, and the current
`GHS`/`USD` split inside `supplierApplicationPayload.js` should be reduced to a
single settlement currency per supplier.

Reporting no longer mixes currencies. What is still undecided is the
**settlement and payout-method rule**: whether a supplier may hold methods in
more than one currency, and which currency a payout request must use. The code
should not add amounts from different currencies while that decision is pending.
