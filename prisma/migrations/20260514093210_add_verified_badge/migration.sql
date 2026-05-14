-- Add verified badge column to Review
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "verified" BOOLEAN NOT NULL DEFAULT true;
