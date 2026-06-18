-- Add auth & refresh token fields to User model
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordHash"  TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "authProvider"  TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "refreshToken"  TEXT;
