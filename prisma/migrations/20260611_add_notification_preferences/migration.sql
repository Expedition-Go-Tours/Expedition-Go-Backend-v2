-- Add notificationPreferences JSON field to User model
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notificationPreferences" JSONB;
