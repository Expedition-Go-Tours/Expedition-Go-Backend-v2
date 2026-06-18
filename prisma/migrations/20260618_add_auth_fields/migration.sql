-- Add auth & refresh token fields to User model, make firebaseUid nullable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordHash"  TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "authProvider"  TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "refreshToken"  TEXT;
ALTER TABLE "User" ALTER COLUMN "firebaseUid" DROP NOT NULL;
