-- Finance reminder tracking.
--
-- The v3 invoice pipeline told the supplier their payment was scheduled but
-- never told finance it was theirs to send. The generation-time notification
-- now covers that; this column makes the payment-date reminder idempotent so
-- the hourly sweep cannot fire the same reminder twenty-four times.
ALTER TABLE "Invoice" ADD COLUMN "dueReminderSentAt" TIMESTAMP(3);

CREATE INDEX "Invoice_status_paymentScheduledAt_idx"
    ON "Invoice"("status", "paymentScheduledAt");
