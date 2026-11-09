-- Same-day customer cancellation requests.
--
-- On the activity date the free-cancellation window has closed. The customer
-- can ask to cancel, but the supplier decides. Approval cancels with no refund;
-- rejection leaves the booking active. One request per booking, tracked on the
-- booking row so the list/detail payloads carry it without a join.
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "customerCancellationStatus" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "customerCancellationReason" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "customerCancellationNote" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "customerCancellationRequestedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "customerCancellationDecidedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "customerCancellationDecidedBy" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "customerCancellationDecisionNote" TEXT;

CREATE INDEX IF NOT EXISTS "Booking_customerCancellationStatus_idx"
  ON "Booking"("customerCancellationStatus");

-- Notification types for the supplier's approval and the customer's outcome.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOMER_CANCELLATION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOMER_CANCELLATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOMER_CANCELLATION_DECLINED';
