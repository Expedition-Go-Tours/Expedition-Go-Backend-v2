-- Customer self-service "modify booking" (party size / date / time change with
-- Stripe top-up or partial refund). Extends BookingChange into the audit + money
-- ledger for a modification, including the parked-until-paid top-up lifecycle.

ALTER TABLE "BookingChange"
  ADD COLUMN IF NOT EXISTS "kind" TEXT,
  ADD COLUMN IF NOT EXISTS "delta" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "paymentIntentId" TEXT,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'APPLIED',
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "BookingChange_paymentIntentId_key"
  ON "BookingChange"("paymentIntentId");

CREATE INDEX IF NOT EXISTS "BookingChange_bookingId_status_idx"
  ON "BookingChange"("bookingId", "status");

-- Existing rows predate the lifecycle columns — backfill so history queries
-- and the top-up reconciliation never assume nulls where a value is expected.
UPDATE "BookingChange" SET "status" = 'APPLIED', "updatedAt" = "createdAt" WHERE "status" IS NULL OR "updatedAt" IS NULL;
