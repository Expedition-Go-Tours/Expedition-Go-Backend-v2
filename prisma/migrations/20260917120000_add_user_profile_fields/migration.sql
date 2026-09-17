-- AlterTable: profile fields backing the Account Settings page
-- (date of birth + location). IF NOT EXISTS so a partially-applied run is safe.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dateOfBirth" DATE;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "zipCode" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "homeAirport" TEXT;
