-- AlterTable: Add search fields to Attraction model
ALTER TABLE "Attraction" ADD COLUMN "town" TEXT,
ADD COLUMN "region" TEXT,
ADD COLUMN "category" TEXT,
ADD COLUMN "aliases" TEXT,
ADD COLUMN "priority" TEXT DEFAULT 'Standard',
ADD COLUMN "placeType" TEXT;

-- CreateIndex: Search indexes
CREATE INDEX "Attraction_region_idx" ON "Attraction"("region");
CREATE INDEX "Attraction_category_idx" ON "Attraction"("category");
CREATE INDEX "Attraction_town_idx" ON "Attraction"("town");
