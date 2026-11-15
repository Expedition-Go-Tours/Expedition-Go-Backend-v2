-- Value-based two-person control for refund claim releases.
--
-- Above the configured threshold one admin's approval only records the first
-- signature; a different admin must complete the release. The amount is stored
-- alongside so the second approver cannot release a larger sum than the one
-- that was actually approved.
ALTER TABLE "RefundClaim" ADD COLUMN IF NOT EXISTS "firstApprovedById" TEXT;
ALTER TABLE "RefundClaim" ADD COLUMN IF NOT EXISTS "firstApprovedAt" TIMESTAMP(3);
ALTER TABLE "RefundClaim" ADD COLUMN IF NOT EXISTS "firstApprovedAmount" DECIMAL(10, 2);
