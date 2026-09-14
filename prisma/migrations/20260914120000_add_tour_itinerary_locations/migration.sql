-- AlterTable: add itinerary city/region columns to Tour.
-- These hold EVERY itinerary stop's city/region (not just the first, which is
-- what "city"/"region" hold), so a search for a town or region can surface a
-- tour that merely visits it.
ALTER TABLE "Tour" ADD COLUMN "itineraryCities" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Tour" ADD COLUMN "itineraryRegions" TEXT[] NOT NULL DEFAULT '{}';

-- CreateIndex: GIN indexes for array containment/overlap queries
CREATE INDEX "Tour_itineraryCities_idx" ON "Tour" USING GIN ("itineraryCities");
CREATE INDEX "Tour_itineraryRegions_idx" ON "Tour" USING GIN ("itineraryRegions");

-- Backfill: unique city values from productContent.locations[].city
UPDATE "Tour" SET "itineraryCities" = (
  SELECT COALESCE(
    array_agg(DISTINCT elem->>'city') FILTER (WHERE elem->>'city' IS NOT NULL AND elem->>'city' != ''),
    '{}'
  )
  FROM jsonb_array_elements("productContent"->'locations') AS elem
  WHERE elem->>'city' IS NOT NULL AND elem->>'city' != ''
);

-- Backfill: unique region values from productContent.locations[].region
UPDATE "Tour" SET "itineraryRegions" = (
  SELECT COALESCE(
    array_agg(DISTINCT elem->>'region') FILTER (WHERE elem->>'region' IS NOT NULL AND elem->>'region' != ''),
    '{}'
  )
  FROM jsonb_array_elements("productContent"->'locations') AS elem
  WHERE elem->>'region' IS NOT NULL AND elem->>'region' != ''
);
