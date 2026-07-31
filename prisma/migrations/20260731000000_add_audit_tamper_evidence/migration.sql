-- Tamper evidence: hash chain on AuditLog
ALTER TABLE "AuditLog"
  ADD COLUMN "prevHash" TEXT,
  ADD COLUMN "hash" TEXT;

-- Index for chain lookups
CREATE INDEX IF NOT EXISTS "AuditLog_hash_idx" ON "AuditLog"("hash");

-- Archive table (cold storage for rotated logs)
CREATE TABLE "AuditLogArchive" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "userEmail" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "action" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "resourceId" TEXT,
  "oldValues" JSONB,
  "newValues" JSONB,
  "metadata" JSONB,
  "prevHash" TEXT,
  "hash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditLogArchive_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuditLogArchive_userId_idx" ON "AuditLogArchive"("userId");
CREATE INDEX IF NOT EXISTS "AuditLogArchive_action_idx" ON "AuditLogArchive"("action");
CREATE INDEX IF NOT EXISTS "AuditLogArchive_resource_idx" ON "AuditLogArchive"("resource");
CREATE INDEX IF NOT EXISTS "AuditLogArchive_archivedAt_idx" ON "AuditLogArchive"("archivedAt");
CREATE INDEX IF NOT EXISTS "AuditLogArchive_createdAt_idx" ON "AuditLogArchive"("createdAt");
