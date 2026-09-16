-- Cookie-consent audit trail.
--
-- PECR and the UK GDPR require us to be able to *demonstrate* that consent was
-- given, so every decision is recorded: which categories were agreed, against
-- which policy version, how it was expressed, and when. The visitor's browser
-- remains the source of truth for applying the choice (the eg_consent cookie);
-- this table is the compliance record.
--
-- Purely additive — no relations, so nothing existing is touched. userId is a
-- soft reference; an erasure request should delete the matching rows.
--
-- Written idempotently, matching this repo's convention for additive migrations
-- (see 20260908160000_add_booking_option). The table was originally created by
-- hand to avoid a destructive `db push`, so the IF NOT EXISTS clauses let this
-- migration be recorded in the ledger without re-creating anything.
CREATE TABLE IF NOT EXISTS "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "policyVersion" INTEGER NOT NULL,
    "necessary" BOOLEAN NOT NULL DEFAULT true,
    "functional" BOOLEAN NOT NULL DEFAULT false,
    "analytics" BOOLEAN NOT NULL DEFAULT false,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "policyPath" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ConsentRecord_userId_idx" ON "ConsentRecord"("userId");
CREATE INDEX IF NOT EXISTS "ConsentRecord_decidedAt_idx" ON "ConsentRecord"("decidedAt");
