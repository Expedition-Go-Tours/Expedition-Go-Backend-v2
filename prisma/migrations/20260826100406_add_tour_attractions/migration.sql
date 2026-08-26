-- AlterTable: Add attractions column to Tour
ALTER TABLE "Tour" ADD COLUMN "attractions" TEXT[] NOT NULL DEFAULT '{}';

-- CreateIndex: GIN index for array containment queries
CREATE INDEX "Tour_attractions_idx" ON "Tour" USING GIN ("attractions");

-- Backfill: Extract unique attraction names from productContent.locations[].name
UPDATE "Tour" SET "attractions" = (
  SELECT COALESCE(
    array_agg(DISTINCT elem->>'name') FILTER (WHERE elem->>'name' IS NOT NULL AND elem->>'name' != ''),
    '{}'
  )
  FROM jsonb_array_elements("productContent"->'locations') AS elem
  WHERE elem->>'name' IS NOT NULL AND elem->>'name' != ''
);
