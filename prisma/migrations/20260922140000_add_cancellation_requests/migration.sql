-- Supplier cancellation requests — mandatory admin approval gate.
--
-- 1) CancellationRequest table: a supplier's cancel (single or bulk) is parked
--    here as PENDING_APPROVAL when SUPPLIER_CANCEL_REQUIRES_APPROVAL is on —
--    no booking state, no money, no customer email until an admin decides.
--    APPROVING is the short-lived atomic claim that makes approval idempotent
--    (two admins can never double-execute a refund).
-- 2) Supplier in-app/email notification types for the decision.
-- 3) Admin feed notification types for the request + decision.
-- 4) The `cancellations.approve` permission, granted to super_admin and
--    operations_admin. Deploy runs `migrate deploy` only (no seed), so the
--    grant ships here as idempotent SQL; prisma/seed.js carries the same
--    permission for test environments.

-- ── CancellationRequestStatus enum ────────────────────────────────────────
CREATE TYPE "CancellationRequestStatus" AS ENUM
  ('PENDING_APPROVAL', 'APPROVING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED');

-- ── Notification enums ────────────────────────────────────────────────────
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CANCELLATION_REQUEST_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CANCELLATION_REQUEST_REJECTED';
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'SUPPLIER_CANCELLATION_REQUEST';
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'SUPPLIER_CANCELLATION_DECIDED';

-- ── CancellationRequest table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CancellationRequest" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "supplierId" TEXT,
    "batchId" TEXT,
    "status" "CancellationRequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "payload" JSONB NOT NULL,
    "preview" JSONB,
    "stopSellingApplied" BOOLEAN NOT NULL DEFAULT false,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CancellationRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CancellationRequest_status_createdAt_idx"
  ON "CancellationRequest"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "CancellationRequest_bookingId_status_idx"
  ON "CancellationRequest"("bookingId", "status");
CREATE INDEX IF NOT EXISTS "CancellationRequest_supplierId_createdAt_idx"
  ON "CancellationRequest"("supplierId", "createdAt");
CREATE INDEX IF NOT EXISTS "CancellationRequest_batchId_idx"
  ON "CancellationRequest"("batchId");

ALTER TABLE "CancellationRequest"
  ADD CONSTRAINT "CancellationRequest_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── `cancellations.approve` permission + role grants ──────────────────────
INSERT INTO "AdminPermission" ("id", "key", "name", "description", "category", "isSystem", "updatedAt")
VALUES (
  'perm_cancellations_approve',
  'cancellations.approve',
  'Approve Cancellations',
  'Approve or reject supplier cancellation requests',
  'Bookings',
  false,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "AdminRolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "AdminRole" r
CROSS JOIN "AdminPermission" p
WHERE r."name" IN ('super_admin', 'operations_admin')
  AND p."key" = 'cancellations.approve'
ON CONFLICT DO NOTHING;
