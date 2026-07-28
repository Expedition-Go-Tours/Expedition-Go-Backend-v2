-- Add BookingFlow enum
CREATE TYPE "BookingFlow" AS ENUM ('DIRECT', 'EXTERNAL');

-- Add new columns to ExpeditionTour
ALTER TABLE "ExpeditionTour" 
  ADD COLUMN "bookingFlow" "BookingFlow" NOT NULL DEFAULT 'DIRECT',
  ADD COLUMN "externalUrl" TEXT,
  ADD COLUMN "publishedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  ADD COLUMN "publishedAt" TIMESTAMPTZ,
  ADD COLUMN "unpublishedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  ADD COLUMN "unpublishedAt" TIMESTAMPTZ,
  ADD COLUMN "unpublishReason" TEXT,
  ADD COLUMN "syncStatus" TEXT,
  ADD COLUMN "lastSyncAt" TIMESTAMPTZ,
  ADD COLUMN "syncError" TEXT;

-- Change isActive default for new records
ALTER TABLE "ExpeditionTour" 
  ALTER COLUMN "isActive" SET DEFAULT false;

-- Indexes for audit lookups
CREATE INDEX IF NOT EXISTS "ExpeditionTour_publishedById_idx" ON "ExpeditionTour"("publishedById");
CREATE INDEX IF NOT EXISTS "ExpeditionTour_unpublishedById_idx" ON "ExpeditionTour"("unpublishedById");
