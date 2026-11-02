-- Supplier-initiated refunds on delivered trips.
--
-- Purely additive: one enum, one table, one FK to Booking. No existing column
-- is touched. The balance movement is NOT modelled here — execution writes a
-- SupplierCharge row (reason 'SUPPLIER_REFUND'), which the existing payout and
-- invoice machinery already nets off.

CREATE TYPE "SupplierRefundRequestStatus" AS ENUM (
  'PENDING_APPROVAL',
  'EXECUTING',
  'COMPLETED',
  'REJECTED',
  'WITHDRAWN',
  'FAILED'
);

CREATE TABLE "SupplierRefundRequest" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "SupplierRefundRequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "payload" JSONB NOT NULL,
    "preview" JSONB,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "executedBy" TEXT,
    "executedAt" TIMESTAMP(3),
    "refundReference" TEXT,
    "refundedAmount" DECIMAL(10,2),
    "chargeId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierRefundRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierRefundRequest_requestNumber_key"
    ON "SupplierRefundRequest"("requestNumber");

-- One open request per booking at a time. A partial index is the only way to
-- express "at most one PENDING row per booking" in Postgres; the unique
-- constraint on the pair alone would forbid legitimate follow-up partials
-- after the first one settles.
CREATE UNIQUE INDEX "SupplierRefundRequest_one_pending_per_booking"
    ON "SupplierRefundRequest"("bookingId")
    WHERE "status" = 'PENDING_APPROVAL';

CREATE INDEX "SupplierRefundRequest_status_createdAt_idx"
    ON "SupplierRefundRequest"("status", "createdAt");
CREATE INDEX "SupplierRefundRequest_bookingId_status_idx"
    ON "SupplierRefundRequest"("bookingId", "status");
CREATE INDEX "SupplierRefundRequest_supplierId_createdAt_idx"
    ON "SupplierRefundRequest"("supplierId", "createdAt");

ALTER TABLE "SupplierRefundRequest"
    ADD CONSTRAINT "SupplierRefundRequest_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupplierRefundRequest"
    ADD CONSTRAINT "SupplierRefundRequest_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "SupplierRefundRequest_supplierId_idx"
    ON "SupplierRefundRequest"("supplierId");
