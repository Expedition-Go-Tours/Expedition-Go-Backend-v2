# Stays inventory: the race, the fix, and the relational model that should follow

## Scope

This document covers the supplier-created reservation path
(`POST /api/v1/travioghana/supplier/stays/bookings`), which is the only writer to
`StayBooking` today. There is no customer-facing checkout for Stays yet.

It records two things:

1. the focused fix applied to the existing model (shipped in this branch);
2. the relational inventory redesign that would remove the class of bug
   entirely (documented, **not implemented**).

## Current model

Inventory is split across three places:

| Storage | Shape | Problem |
| --- | --- | --- |
| `StayProperty.data` (JSON) | `rooms[]` with `id`, `count`, `price`; `ratePlans[]` with `roomId`, `price` | Not constrained, not joinable, edited as one blob |
| `StayAvailabilityOverride` | `(propertyId, roomId, date)` unique; `count`, `closed`, `price`, `minStay` | Correct per-date shape, but only `closed` was honoured |
| `StayBooking` | `(propertyId, roomId, checkIn, checkOut, status)` | No uniqueness or exclusion constraint preventing overlapping sales |

A stay occupies every night in `[checkIn, checkOut)`. Availability for a night is:

```
capacity(night) = override.count if present else room.count
occupied(night) = count of NEW / CONFIRMED / CHECKED_IN bookings overlapping that night
available(night) = capacity(night) - occupied(night)
```

## The two defects that were fixed

### 1. Read-then-write race

`createBooking` did:

```
count overlapping bookings   (connection A)
… decide …
create booking               (connection B)
```

Two requests arriving together could both read `0 of 1 rooms booked` and both
insert. The count and the insert were not part of the same transaction, and
nothing serialised writers for the same room.

### 2. Ignored per-date overrides

The controller fetched `StayAvailabilityOverride` but only acted on `closed`.
`count`, `price` and `minStay` were loaded and discarded. Consequences:

- a supplier could cut a date to one room and the endpoint would still sell the
  room's base count;
- a date priced at 250 GHS was charged the room's 120 GHS rate;
- a three-night minimum on a date did not stop a two-night booking;
- revenue and supplier payout were computed from the wrong amount.

## The fix

Implemented in `src/brands/ghana/staysBookingsController.js`.

### Advisory lock, per room

```sql
SELECT 1 AS locked
FROM (SELECT pg_advisory_xact_lock(4242::int, hashtext('<propertyId>:<roomId>')::int)) AS lock
```

- Transaction-scoped: released on commit or rollback, with no cleanup path to
  forget.
- Keyed on `(propertyId, roomId)`, so bookings for different rooms proceed in
  parallel.
- `pg_advisory_xact_lock` returns `void`, which Prisma cannot deserialize. The
  subquery selects a constant so the row type is `Int` while the lock still runs.
  This failure mode was observed in the database test suite, not theorised.
- Taken with `tx.$queryRawUnsafe(sql, ...values)` rather than the tagged
  `tx.$queryRaw`. `jest.setup.js` rewrites tagged raw queries onto the **root**
  client to work around a Prisma-under-Jest quirk; through that rewrite a
  "transaction" statement executes in autocommit, where an `_xact_` lock is
  released as soon as the statement returns. That silently reopened the race in
  tests while production behaved correctly — a green suite on a broken invariant
  is worse than a red one. `$queryRawUnsafe` is not rewritten and stays bound to
  `tx`, and its values are still positional parameters (`$1`, `$2`), so no SQL is
  interpolated.

### Read Committed, not Serializable

The obvious choice is `Serializable`. It was implemented first and rejected:

- the lock already provides mutual exclusion;
- Serializable also aborts the **waiting** transaction, because the snapshot it
  captured *before* acquiring the lock is stale by the time it proceeds
  (`P2034`, "could not serialize access due to concurrent update");
- the result was one wasted attempt and a `prisma:error` log line per concurrent
  booking, for a guarantee the lock already provides.

`ReadCommitted` means every statement after the lock sees the state the previous
holder committed. That is precisely the semantics this algorithm needs.

### Retry wrapper

```
attempt 1..3 on: P2034, 40001, 40P01, "write conflict", "deadlock detected"
```

Serialization failures and deadlocks are expected under load. The retry re-runs
the whole transaction, including re-reading the property, so a supplier edit or
archive between attempts is respected. Three attempts is generous: a retry only
happens when another booking for the same room committed inside the same few
milliseconds. Exhausting them surfaces the error rather than hiding it.

### Booking number allocated before the transaction

`generateBookingNumber('TRG-S')` bumps one `bookingCounter` row per
`(prefix, year)`. Inside the transaction, that single row becomes a conflict
point for **every** booking — including bookings for unrelated rooms.

It now runs before the transaction. A rolled-back attempt leaves an unused
number, which is a cosmetic gap in the sequence, not a correctness problem. The
alternative is serialising all Stays bookings through one counter row.

### Per-night validation

`validateStayNights` walks each night in `[checkIn, checkOut)` and applies, in
order:

| Check | Source | Error |
| --- | --- | --- |
| closed | `override.closed` | `Those dates are blocked for this room (<date> is closed)` |
| minimum stay | `override.minStay` vs total nights | `A minimum stay of N night(s) applies on <date>` |
| remaining inventory | `override.count ?? room.count` vs occupied count | `No rooms are available for <date>` |
| nightly price | `override.price ?? plan.price ?? room.price` | `A valid nightly price is required … (<date>)` |

Totals are summed per night across the stay, so a two-night booking with one
override night is priced as `base + override`. Rounding happens once, at the
end, to two decimals.

An absent or `null` override value means "no override", never "zero" or "free".
`count: 0` **is** an override and means zero inventory.

A caller-supplied `amount` still wins when it is a positive finite number, but
the server now has a correct computed total to fall back on and the validation
runs regardless.

## What this does not fix

The fix makes the existing model safe under concurrency. It does not make it
expressive:

- Room count lives in a JSON blob; changing it is a full property write with no
  history and no constraint.
- There is no database-level guarantee that two bookings cannot overlap, so any
  future writer (a customer checkout, an admin import) must remember to take the
  same advisory lock. Nothing enforces it.
- The lock key is a hash of two string ids. Hash collisions are astronomically
  unlikely at this scale but are not impossible; they would only cause a
  spurious wait, never an oversell.
- `StayBooking` stores `roomName` and `ratePlanName` as denormalised strings.
  That is intentional for historical pricing, but it means room renames are not
  queryable as history.

## Relational inventory redesign (proposed, out of scope)

### Target schema

```prisma
model StayRoom {
  id         String   @id @default(cuid())
  propertyId String
  property   StayProperty @relation(fields: [propertyId], references: [id], onDelete: Cascade)
  name       String
  roomKind   String?
  totalCount Int      @default(1)   // base inventory
  basePrice  Decimal  @db.Decimal(10, 2)
  active     Boolean  @default(true)

  ratePlans  StayRatePlan[]
  days       StayInventoryDay[]
  bookings   StayBooking[]

  @@index([propertyId])
}

model StayRatePlan {
  id        String  @id @default(cuid())
  roomId    String
  room      StayRoom @relation(fields: [roomId], references: [id], onDelete: Cascade)
  name      String
  price     Decimal @db.Decimal(10, 2)
  minStay   Int?
  active    Boolean @default(true)
}

/// One row per room per date that deviates from base inventory/price.
/// Absence of a row means "use StayRoom.totalCount / StayRoom.basePrice".
model StayInventoryDay {
  id        String   @id @default(cuid())
  roomId    String
  room      StayRoom @relation(fields: [roomId], references: [id], onDelete: Cascade)
  date      DateTime @db.Date
  count     Int?     // null = inherit; 0 = closed for sale
  price     Decimal? @db.Decimal(10, 2)
  minStay   Int?
  closed    Boolean  @default(false)
  version   Int      @default(0)   // optimistic concurrency for edits

  @@unique([roomId, date])
  @@index([roomId, date])
}
```

`StayBooking` gains `roomId` as a real foreign key and keeps the denormalised
name and price for audit.

### Guarantees the schema can provide

1. **Referential integrity.** A booking cannot reference a room that does not
   exist, and deleting a room cannot orphan bookings.
2. **Per-date uniqueness.** `@@unique([roomId, date])` makes double-editing the
   same day impossible.
3. **Optimistic conflict detection on edits.** `version` lets a stale supplier
   calendar save fail instead of overwriting a concurrent change.
4. **A single occupied count per night.** With `count` on a row, availability can
   be computed with one aggregate:

   ```sql
   SELECT d.date,
          COALESCE(d.count, r."totalCount") - COUNT(b.id) AS available
   FROM "StayRoom" r
   JOIN "StayInventoryDay" d ON d."roomId" = r.id
   LEFT JOIN "StayBooking" b
     ON b."roomId" = r.id
    AND b.status IN ('NEW','CONFIRMED','CHECKED_IN')
    AND d.date >= b."checkIn" AND d.date < b."checkOut"
   GROUP BY d.date, d.count, r."totalCount"
   ```

   That query is index-friendly and removes the application-side per-night loop
   for availability *reads*. The write path still needs the advisory lock (or an
   `EXCLUDE` constraint for single-unit rooms), because a read can always race a
   write.

5. **History.** A price change is a new `StayInventoryDay` row, not a mutation of
   a JSON blob.

### Migration path

1. Add the three tables and `StayBooking.roomId` (nullable) in one migration.
2. Backfill from `StayProperty.data` JSON:

   ```
   for each property:
     for each data.rooms[]: insert StayRoom (id = room.id)
     for each data.ratePlans[]: insert StayRatePlan
     for each StayAvailabilityOverride: insert StayInventoryDay
   for each StayBooking: set roomId where (propertyId, roomId) resolves
   ```

   The existing `roomId` string on `StayBooking` already matches the JSON room id,
   so the join is direct.

3. Run both models in parallel behind a feature flag:
   - reads from the relational tables;
   - writes to both, with the advisory lock still held.
4. Compare results for a full business cycle (counts, prices, availability).
5. Switch writes to relational only; drop the JSON rooms/ratePlans arrays from
   new property payloads.
6. Drop `StayAvailabilityOverride` and make `StayBooking.roomId` non-null.

Each step is reversible until step 6. No step requires a data-loss
`prisma db push`; every step is a reviewed migration file.

### Why it is not in this change

- Inventory is a correctness fix; a schema redesign is a product/ops project.
- Backfilling live supplier properties needs a dry-run report and a rollback
  plan, not just a migration file.
- The API payload (`property.data.rooms`) is consumed by the supplier dashboard.
  Changing it is a coordinated frontend release.
- The current fix already removes the oversell and pricing defects. The
  relational model buys clarity, constraints and better reads, not immediate
  safety.

## Tests

| Suite | What it proves |
| --- | --- |
| `__tests__/api/staysInventory.test.js` (real PostGIS) | 5 concurrent requests for a 1-room property produce exactly one 201 and four 400s; per-date count, price, minStay and closed all bind; legacy and canonical prefixes behave identically |
| `__tests__/unit/staysOperations.test.js` | Per-date price override totals; zero-inventory date rejected; minStay rejected; closed night rejected; booking number still assigned |
| `__tests__/unit/staysBootstrap.test.js` | The booking route is served by the Stays app without the Platform process |

The concurrency assertion is the important one: it fails against the previous
implementation (five 201s) and passes now. The suite logs an expected
`prisma:error … write conflict` at `info` level when a retry occurs; that is the
retry path working, not a test failure.

## Operational notes

- The advisory lock namespace is `4242`. It is arbitrary but must stay stable:
  changing it would allow old and new processes to hold different locks for the
  same room during a rolling restart.
- Transaction timeouts are `maxWait: 10s`, `timeout: 15s`. A booking request that
  waits longer than that fails with a Prisma timeout rather than hanging a
  connection indefinitely.
- If a future writer is added, it must take the same lock **inside the same
  transaction** as its insert. Documenting the lock is not enough; the schema
  redesign above is the durable answer.
