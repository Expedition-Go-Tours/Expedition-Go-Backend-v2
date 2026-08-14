-- Remove MOBILE_MONEY from PayoutMethodType and drop the unused mobile fields.
-- Mobile money payouts are no longer supported. Delete any leftover rows first
-- so the enum type rebuild below cannot fail on a stale value.

DELETE FROM "PayoutMethod" WHERE "type" = 'MOBILE_MONEY';

ALTER TABLE "PayoutMethod" DROP COLUMN IF EXISTS "mobileProvider";
ALTER TABLE "PayoutMethod" DROP COLUMN IF EXISTS "mobileNumber";

CREATE TYPE "PayoutMethodType_new" AS ENUM ('BANK_TRANSFER', 'PAYPAL');
ALTER TABLE "PayoutMethod" ALTER COLUMN "type" TYPE "PayoutMethodType_new" USING ("type"::text::"PayoutMethodType_new");
DROP TYPE "PayoutMethodType";
ALTER TYPE "PayoutMethodType_new" RENAME TO "PayoutMethodType";
