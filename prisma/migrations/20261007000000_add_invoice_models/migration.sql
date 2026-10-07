-- ── Finance v3: automatic supplier invoicing (GetYourGuide-style) ────────────
-- Adds the Invoice / InvoiceItem tables, the INVOICED booking-payout state,
-- and retires the WEEKLY cadence (migrating any enrolled supplier to
-- TWICE_MONTHLY). The legacy PayoutRequest / Payout tables are untouched and
-- remain read-only history.

-- 1) Data migration FIRST: move every supplier still on WEEKLY (active or
--    pending) to TWICE_MONTHLY so the enum rebuild below cannot fail on a
--    stale value. WEEKLY is no longer offered anywhere.
UPDATE "SupplierProfile" SET "payoutCycle" = 'TWICE_MONTHLY' WHERE "payoutCycle" = 'WEEKLY';
UPDATE "SupplierProfile" SET "payoutCyclePending" = 'TWICE_MONTHLY' WHERE "payoutCyclePending" = 'WEEKLY';

-- 2) Rebuild PayoutCycle without WEEKLY (same pattern as remove_mobile_money).
--    Both SupplierProfile columns are recast before the old type is dropped.
CREATE TYPE "PayoutCycle_new" AS ENUM ('TWICE_MONTHLY', 'MONTHLY');
ALTER TABLE "SupplierProfile" ALTER COLUMN "payoutCycle" TYPE "PayoutCycle_new" USING ("payoutCycle"::text::"PayoutCycle_new");
ALTER TABLE "SupplierProfile" ALTER COLUMN "payoutCyclePending" TYPE "PayoutCycle_new" USING ("payoutCyclePending"::text::"PayoutCycle_new");
DROP TYPE "PayoutCycle";
ALTER TYPE "PayoutCycle_new" RENAME TO "PayoutCycle";

-- 3) BookingPayoutStatus gains the v3 INVOICED lifecycle state. ADD VALUE is
--    safe here: the value is not used inside this migration's transaction.
ALTER TYPE "BookingPayoutStatus" ADD VALUE IF NOT EXISTS 'INVOICED';

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('INVOICED', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "cycle" "PayoutCycle" NOT NULL,
    "cycleStartDate" TIMESTAMP(3) NOT NULL,
    "cycleEndDate" TIMESTAMP(3) NOT NULL,
    "cycleLabel" TEXT NOT NULL,
    "invoicedAt" TIMESTAMP(3) NOT NULL,
    "paymentScheduledAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "reference" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'INVOICED',
    "grossTotal" DECIMAL(10,2) NOT NULL,
    "commissionTotal" DECIMAL(10,2) NOT NULL,
    "netTotal" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "bookingCount" INTEGER NOT NULL,
    "payoutMethodId" TEXT,
    "runKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "grossAmount" DECIMAL(10,2) NOT NULL,
    "platformCommission" DECIMAL(10,2) NOT NULL,
    "supplierPayout" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");
CREATE UNIQUE INDEX "Invoice_runKey_key" ON "Invoice"("runKey");
CREATE INDEX "Invoice_supplierId_status_idx" ON "Invoice"("supplierId", "status");
CREATE INDEX "Invoice_status_invoicedAt_idx" ON "Invoice"("status", "invoicedAt");
CREATE INDEX "Invoice_supplierId_invoicedAt_idx" ON "Invoice"("supplierId", "invoicedAt");
CREATE UNIQUE INDEX "InvoiceItem_bookingId_key" ON "InvoiceItem"("bookingId");
CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_payoutMethodId_fkey" FOREIGN KEY ("payoutMethodId") REFERENCES "PayoutMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;