-- Per-platform external review aggregate used by homepage ranking, plus the
-- denormalized combined rating/count on Tour.
-- Idempotent (IF NOT EXISTS) so it is safe to re-run.

-- CreateTable
CREATE TABLE IF NOT EXISTS "TourExternalReviewStat" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rating" DECIMAL(3,2),
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "distribution" JSONB,
    "productId" TEXT,
    "productUrl" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TourExternalReviewStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TourExternalReviewStat_tourId_source_key" ON "TourExternalReviewStat"("tourId", "source");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TourExternalReviewStat_tourId_idx" ON "TourExternalReviewStat"("tourId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TourExternalReviewStat_source_idx" ON "TourExternalReviewStat"("source");

-- AddForeignKey
ALTER TABLE "TourExternalReviewStat" DROP CONSTRAINT IF EXISTS "TourExternalReviewStat_tourId_fkey";
ALTER TABLE "TourExternalReviewStat" ADD CONSTRAINT "TourExternalReviewStat_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: denormalized combined review stats on Tour
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "combinedRating" DECIMAL(3,2);
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "combinedReviewCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Tour_combinedRating_idx" ON "Tour"("combinedRating");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Tour_combinedReviewCount_idx" ON "Tour"("combinedReviewCount");

-- Seed the combined columns from the internal stats for existing rows so the
-- homepage never ranks on an empty combined value. The external sync then
-- folds in TripAdvisor / GetYourGuide totals.
UPDATE "Tour"
SET "combinedRating" = "averageRating",
    "combinedReviewCount" = "reviewCount"
WHERE "combinedReviewCount" = 0
  AND "reviewCount" > 0;
