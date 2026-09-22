-- GetYourGuide-style supplier cancellation flow.
--
-- 1) Structured cancellation fields on Booking: reason code + category
--    (OPERATIONAL / FORCE_MAJEURE / CUSTOMER_REQUESTED), who initiated the
--    cancel, the structured cancellation-rate flag, the 25%-of-retail
--    cancellation fee, an authoritative refundStatus (so a failed Stripe
--    refund can never be stamped REFUNDED), T&C audit trail, and the 48h
--    customer choice window (reschedule OR full refund).
-- 2) SupplierCharge ledger: cancellation fees created on operational
--    cancels, netted off the supplier's next payout request.
-- 3) Two new notification types (rate-threshold breach, choice window).

-- ── Booking: structured cancellation columns ───────────────────────────────
ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "cancellationCode" TEXT,
  ADD COLUMN IF NOT EXISTS "cancellationCategory" TEXT,
  ADD COLUMN IF NOT EXISTS "cancellationOrigin" TEXT,
  ADD COLUMN IF NOT EXISTS "countsTowardRate" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "cancellationFee" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "refundStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "cancellationAgreedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancellationEvidenceUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "cancellationChoiceDeadline" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "customerChoice" TEXT,
  ADD COLUMN IF NOT EXISTS "customerChoiceAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "proposedTravelDate" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Booking_cancellationChoiceDeadline_idx"
  ON "Booking"("cancellationChoiceDeadline");

CREATE INDEX IF NOT EXISTS "Booking_refundStatus_idx"
  ON "Booking"("refundStatus");

-- ── SupplierCharge: 25%-of-retail cancellation fee ledger ──────────────────
CREATE TABLE IF NOT EXISTS "SupplierCharge" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "reason" TEXT NOT NULL DEFAULT 'SUPPLIER_CANCELLATION_FEE',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "payoutRequestId" TEXT,
    "settledAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierCharge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SupplierCharge_supplierId_idx" ON "SupplierCharge"("supplierId");
CREATE INDEX IF NOT EXISTS "SupplierCharge_status_idx" ON "SupplierCharge"("status");
CREATE INDEX IF NOT EXISTS "SupplierCharge_supplierId_status_idx" ON "SupplierCharge"("supplierId", "status");
CREATE INDEX IF NOT EXISTS "SupplierCharge_bookingId_idx" ON "SupplierCharge"("bookingId");
CREATE INDEX IF NOT EXISTS "SupplierCharge_payoutRequestId_idx" ON "SupplierCharge"("payoutRequestId");

ALTER TABLE "SupplierCharge"
  ADD CONSTRAINT "SupplierCharge_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "SupplierCharge_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "SupplierCharge_payoutRequestId_fkey"
    FOREIGN KEY ("payoutRequestId") REFERENCES "PayoutRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Notification types ─────────────────────────────────────────────────────
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CANCELLATION_RATE_ALERT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CANCELLATION_CHOICE_REQUIRED';
