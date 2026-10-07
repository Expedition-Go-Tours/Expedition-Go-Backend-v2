-- ── Finance v3: invoice approval gate (maker–checker) ─────────────────────────
-- Finance must approve an invoice before it can be marked paid. The payout
-- path becomes: INVOICED (calendar generated it) -> APPROVED (finance
-- authorized the transfer) -> PAID (bank reference recorded). markInvoicePaid
-- 409s on anything but APPROVED, so nothing can bypass the approval step.
-- Additive only: no existing row changes status (none are past INVOICED yet —
-- the first scheduled run is 2026-10-16).

-- 1) Rebuild the enum with APPROVED in schema order (same pattern as the
--    PayoutCycle rebuild in 20261007000000): a bare ADD VALUE appends at the
--    end, which would drift from prisma/schema.prisma on the next migrate dev.
--    The column default must be dropped first — PG cannot recast a default
--    expression that names the old enum type.
ALTER TABLE "Invoice" ALTER COLUMN "status" DROP DEFAULT;

CREATE TYPE "InvoiceStatus_new" AS ENUM ('INVOICED', 'APPROVED', 'PAID', 'CANCELLED');
ALTER TABLE "Invoice" ALTER COLUMN "status" TYPE "InvoiceStatus_new" USING ("status"::text::"InvoiceStatus_new");
DROP TYPE "InvoiceStatus";
ALTER TYPE "InvoiceStatus_new" RENAME TO "InvoiceStatus";

ALTER TABLE "Invoice" ALTER COLUMN "status" SET DEFAULT 'INVOICED';

-- 2) Who approved it and when — the audit trail for the approve step
--    (paidBy/paidAt record the separate completion step).
ALTER TABLE "Invoice" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "approvedBy" TEXT;

-- 3) Notification types the v3 flow enqueues. INVOICE_GENERATED/INVOICE_PAID
--    were missing from the enum (Prisma rejects the insert and the caller's
--    .catch(() => {}) swallowed it), so suppliers never actually received them.
--    INVOICE_APPROVED is new with the approval gate. Same additive pattern as
--    every other NotificationType migration.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INVOICE_GENERATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INVOICE_PAID';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INVOICE_APPROVED';
