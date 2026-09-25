-- Restore Mobile Money as a supported payout method (Ghana MoMo: MTN, Telecel,
-- AT). This reverses 20260814_remove_mobile_money, which dropped the enum value
-- and the two columns.
--
-- Additive and safe: PostgreSQL 16 permits ALTER TYPE ... ADD VALUE inside a
-- transaction as long as the new value is not used in the same transaction, so
-- `prisma migrate deploy` runs this normally (same pattern as
-- 20260916100000_add_travioafrica_role).

ALTER TYPE "PayoutMethodType" ADD VALUE IF NOT EXISTS 'MOBILE_MONEY';

ALTER TABLE "PayoutMethod" ADD COLUMN IF NOT EXISTS "mobileProvider" TEXT;
ALTER TABLE "PayoutMethod" ADD COLUMN IF NOT EXISTS "mobileNumber" TEXT;
