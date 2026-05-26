-- Create AdminNotificationType enum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdminNotificationType') THEN
    CREATE TYPE "AdminNotificationType" AS ENUM (
      'NEW_SUPPLIER_APPLICATION',
      'SUPPLIER_STATUS_CHANGE',
      'REVIEW_NEEDS_MODERATION',
      'PAYOUT_NEEDS_APPROVAL',
      'SYSTEM_ALERT'
    );
  END IF;
END $$;

-- Create AdminNotification table
CREATE TABLE IF NOT EXISTS "AdminNotification" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type "AdminNotificationType" NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB,
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  "acknowledgedAt" TIMESTAMPTZ,
  "acknowledgedBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_admin_notification_type ON "AdminNotification" (type);
CREATE INDEX IF NOT EXISTS idx_admin_notification_acknowledged ON "AdminNotification" (acknowledged);
CREATE INDEX IF NOT EXISTS idx_admin_notification_created_at ON "AdminNotification" ("createdAt");
