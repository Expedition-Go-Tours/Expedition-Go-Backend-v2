-- Remove Stripe Connect from the supplier flow
-- Changes:
-- 1. Remove STRIPE_PENDING from SupplierStatus enum
-- 2. Remove stripeAccountId column from SupplierProfile

-- Remove stripeAccountId index and column
DROP INDEX IF EXISTS "SupplierProfile_stripeAccountId_idx";
ALTER TABLE "SupplierProfile" DROP COLUMN IF EXISTS "stripeAccountId";

-- Remove STRIPE_PENDING from SupplierStatus enum
-- Create new enum without STRIPE_PENDING
CREATE TYPE "SupplierStatus_new" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- Drop default before altering column type (can't auto-cast defaults)
ALTER TABLE "SupplierProfile" ALTER COLUMN "status" DROP DEFAULT;

-- Update the column to use the new enum
ALTER TABLE "SupplierProfile" ALTER COLUMN "status" TYPE "SupplierStatus_new" USING ("status"::text::"SupplierStatus_new");

-- Drop old enum and rename new one
DROP TYPE "SupplierStatus";
ALTER TYPE "SupplierStatus_new" RENAME TO "SupplierStatus";

-- Re-add the default value
ALTER TABLE "SupplierProfile" ALTER COLUMN "status" SET DEFAULT 'PENDING';
