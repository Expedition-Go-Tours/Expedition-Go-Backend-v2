-- Email verification audit.
--
-- `emailVerified` already existed but nothing ever set it. The verified-claim
-- flow needs both the boolean (the gate) and the timestamp (support/audit).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
