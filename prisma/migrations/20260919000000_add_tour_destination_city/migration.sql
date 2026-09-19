-- Canonical destination city for the homepage "Popular Destinations" rail and
-- place-scoped listings. Derived (see utils/destinationCities.js), so it is
-- backfilled by scripts/backfill-destination-city.js and kept fresh on write.
-- Idempotent (IF NOT EXISTS) so it is safe to re-run.

ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "destinationCity" TEXT;

CREATE INDEX IF NOT EXISTS "Tour_destinationCity_idx" ON "Tour" ("destinationCity");
