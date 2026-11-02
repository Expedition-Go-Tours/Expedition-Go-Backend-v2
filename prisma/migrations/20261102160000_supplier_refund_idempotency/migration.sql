-- Retry-safe filing and a stronger active-request guard.
--
-- A supplier can lose the response after a request was written and retry. The
-- idempotency key lets that retry return the first request instead of a 409.
-- The active index also covers EXECUTING so a second request cannot be filed
-- while the first is being executed, not only while it is pending.

ALTER TABLE "SupplierRefundRequest"
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "SupplierRefundRequest_idempotencyKey_key"
  ON "SupplierRefundRequest"("idempotencyKey");

DROP INDEX IF EXISTS "SupplierRefundRequest_one_pending_per_booking";

CREATE UNIQUE INDEX "SupplierRefundRequest_one_active_per_booking"
  ON "SupplierRefundRequest"("bookingId")
  WHERE "status" IN ('PENDING_APPROVAL', 'EXECUTING');
