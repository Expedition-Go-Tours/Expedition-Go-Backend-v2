# Saved-booking edits: Expedition-Go-Lite vs TravioGhana-Store

Date: 2026-10-21
Scope: editing a **saved** booking from the customer dashboard — pickup
location, participants, date and time (quote → apply → discard), plus the
gating/error states around them. Pre-checkout draft editing and supplier-side
pickup edits are out of scope.

## Verdict

Both storefronts expose the **same** edit surface and both are wired to the
same backend controller. Lite is functionally complete; the differences are
presentational (Lite lacks Ghana's supplier name and its cancelled-booking
details block). The edit flows themselves are byte-identical, so every bug
found and fixed below affected both brands.

## How the surface is wired (identical in both apps)

| Step | Storefront | API |
| --- | --- | --- |
| Booking list / detail | `/dashboard/bookings` → `BookingHistory` → `BookingWorkspace` | `GET /expedition/bookings/:id` |
| Pickup editor | `/booking/:id/pickup` → `BookingPickupPage` | `PATCH /expedition/bookings/:id/pickup` |
| Edit trip | `/dashboard/bookings/:id/modify` → `BookingModifyPage` | `POST …/modify/quote`, `PATCH …/modify`, `POST …/modify/:changeId/discard` |

Both brands share `makeStorefrontController` (`src/core/storefront.js`) and the
same validation/pricing modules (`expeditionValidation.js`, `geoUtils.js`,
`bookingModify.js`). Only the route prefix differs (`/expedition` vs
`/travioghana`, mounted in `src/brands/<brand>/routes.js`).

Deployed-route smoke (`https://api.expeditiongotours.com`): all four expedition
edit routes return **401** (route exists, auth required), as does Ghana pickup.
The historical "every link 404s" problem was Ghana-only and is already fixed in
source.

## File-by-file differences (Lite vs Ghana)

| File | Difference |
| --- | --- |
| `src/pages/BookingModifyPage.tsx` | **Byte-identical** |
| `src/pages/BookingPickupPage.tsx` | **Byte-identical** |
| `src/lib/pickupZone.ts` | Identical logic; only the header comment names a different backend repo |
| `src/hooks/useExpeditionBookings.ts` | Brand prefix (`/expedition` ↔ `/travioghana`) and Ghana-only GA4 fields (`gaClientId`, `analyticsConsent`). All edit hooks are otherwise the same. |
| `src/components/booking/BookingWorkspace.tsx` | Ghana passes `supplierName` into recommended-tour cards; Ghana renders a **cancelled-booking details** block (cancellation reason, cancelled-at, refund status). Lite has neither. |

### Worth backporting to Lite?

- **Cancelled-booking details** — yes, if Lite customers can cancel. Without it,
  a cancelled booking shows no reason and no refund state in the dashboard. It
  is ~20 lines and already styled (`ws-cancel-details`), but it also needs the
  `cancellationReason` / `cancelledAt` / `refundStatus` fields in the detail
  payload (already returned by the shared API). Not done here because it is a
  product decision, not a defect in editing.
- **`supplierName` on recommended tours** — cosmetic; only affects the
  "you might also like" cards.

## Confirmed defects and fixes

All fixes are in the backend (shared by both brands); the two client-side fixes
were applied to **both** storefronts to keep the client/server verdict aligned.

### 1. `skipValidation` silently discarded the customer's address (critical)

`updateBookingPickupSchema` accepted
`{ skipValidation: true }` as its **first** union branch. Zod strips unknown
keys, so `{ mode, skipValidation: true, address }` matched that branch and lost
`mode` + `address`. The storefront sends exactly that shape for out-of-zone
addresses, so the traveller's location was stored as blank and the supplier
never saw it.

Fix: the literal branch is now `z.strictObject(...)`
(`src/core/services/expeditionValidation.js`), so payloads with extra fields
fall through to the full branch.

### 2. "Arrange later" failed on tours without pickup configuration

`resolvePickupSelection` returned `{ ok: true, pickup: null }` when a tour had
no zones; `normalizePickupSnapshot` then returned `null` and `PATCH …/pickup`
answered **400 "Invalid pickup selection"**. Customers on such tours could not
use "Arrange pickup later" at all.

Fix: an explicit `skipValidation` now produces a deferred snapshot (with any
address the customer typed) for both area- and point-based tours
(`src/core/services/geoUtils.js`).

### 3. Exclusion ("no pickup here") rings were ignored on radius-only areas

`findPickupAreaForAddress` returned as soon as a point/radius area matched,
never consulting `area.exclusions`. Only drawn polygons honoured them. The
client had the identical gap, so both sides agreed — on the wrong answer — and
suppliers' exclusion holes inside a radius zone were bookable.

Fix: radius/name matches now check exclusions before returning, in
`src/core/services/geoUtils.js` and in both storefronts' `src/lib/pickupZone.ts`.

### 4. Excluded addresses were accepted by the edit endpoint

Because `normalizePickupSnapshot` degrades invalid picks to `deferred`, an
address inside an exclusion ring (even with `skipValidation`) was stored
successfully, contradicting the client comment that exclusions are "rejected by
the server". The client blocks them, but the API did not.

Fix: `resolvePickupSelection` now returns an `excluded: true` flag and
`controller.updateMyPickup` answers **400** for it. Out-of-zone addresses
*without* `skipValidation` still degrade gracefully to `deferred` (documented
contract) so a stale geofence never blocks a booking.

### 5. Deferred pickup displayed a false "outside the pickup zone" warning

`BookingWorkspace` fell back to `travelers.location` (the city typed at
checkout) whenever `pickup.address` was empty. For an "arrange later" booking
this rendered `Pickup point: Accra, Ghana` plus the out-of-zone caution, instead
of "Pickup location not yet assigned". Fixed in both storefronts; a deferred
pickup only borrows `travelers.location` when it has no address **and** is not
flagged deferred.

## Tests added / run

Backend:

- `__tests__/unit/geoUtils.test.js` — 6 new cases: exclusion rings on
  radius-only areas (radius + name match), arrange-later on no-config tours
  (area and point), address preserved with `skipValidation`, `excluded` flag.
- `__tests__/unit/expeditionValidation.test.js` — 4 new cases pinning the
  `updateBookingPickupSchema` union (address preserved, bare deferral, named
  area, non-boolean `skipValidation` rejected).
- `scripts/e2e-booking-edit.js` — self-provisioning HTTP+DB end-to-end suite
  (26 checks): registration, pay-later booking, all pickup paths incl. polygon
  / radius / exclusion / deferred / no-config, quote → apply for party + date,
  ledger row, Stripe PI re-price, validation guards, detail refresh, cleanup.
  `E2E_KEEP_BOOKING=1` keeps the booking and writes credentials for UI testing.
  Run with `npm run test:e2e:booking-edit` (needs the local stack; refuses
  non-`sk_test_` Stripe keys; set `RESEND_API_KEY=""` to suppress email).

Storefront (Lite):

- `src/pages/BookingPickupPage.test.tsx` — save payload for "arrange later"
  (`{ skipValidation: true }`), failure handling, and the no-pickup / past-date
  / cancelled gating.
- `src/pages/BookingModifyPage.test.tsx` — quote sends only the changed fields,
  apply sends the same diff, date-only diff, blocked policy, apply failure.
- `src/components/booking/BookingWorkspace.test.tsx` — deferred pickup shows
  "not yet assigned" with no false warning; out-of-zone deferred shows the
  address + caution; saved zone shows the pickup point and "Update pickup".
- `src/lib/pickupZone.test.ts` — exclusion rings on radius-only areas.

Results: Lite `vitest run` **102 files / 973 tests pass**; Lite `tsc -b` clean;
backend unit **168 suites / 3482 tests pass**; backend E2E **all 26 checks
pass**; live browser run of the Lite storefront against the local API saved a
pickup (`East Legon`, 06:45) and a party change (2 → 3 travellers, $178 → $267,
PI re-priced) with the correct DB state.

Ghana: `pickupZone.test.ts` (48 tests) and the full suite pass except two
**pre-existing, unrelated** `googleAnalytics` kill-switch tests that fail on
this machine in isolation (no relation to these files).

## Known nuances (not defects)

- **Area ordering is first-match-wins** across the supplier's list. An address
  can be inside a broad radius zone *and* a specific polygon; whichever area
  comes first wins, on both client and server. Worth documenting for suppliers
  who draw overlapping zones.
- **DB-gated API suites** (`test:api:db`) need `npm run test:db:up`
  (`travio_test` via Docker); they skip cleanly otherwise.
- The backend fixes are in source only. Production already serves the edit
  routes, but defects 1–4 are live until the next backend deploy; the two
  storefront fixes need a storefront deploy.
