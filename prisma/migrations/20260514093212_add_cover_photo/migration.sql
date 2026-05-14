-- Add cover photo field to Tour
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "coverPhoto" TEXT;
