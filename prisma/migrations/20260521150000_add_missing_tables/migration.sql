-- Add missing enums, tables, and models that were added to schema.prisma
-- without corresponding migrations.

-- ================================
-- 1. MISSING ENUMS
-- ================================

DO $$ BEGIN
  CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PayoutMethodType" AS ENUM ('BANK_TRANSFER', 'MOBILE_MONEY', 'PAYPAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ================================
-- 2. MISSING TABLES
-- ================================

-- PayoutMethod
CREATE TABLE IF NOT EXISTS "PayoutMethod" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "type" "PayoutMethodType" NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "bankName" TEXT,
    "bankAddress" TEXT,
    "bankCountry" TEXT,
    "accountName" TEXT,
    "accountNumber" TEXT,
    "routingNumber" TEXT,
    "swiftCode" TEXT,
    "iban" TEXT,
    "sortCode" TEXT,
    "branchCode" TEXT,
    "mobileProvider" TEXT,
    "mobileNumber" TEXT,
    "paypalEmail" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayoutMethod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayoutMethod_supplierId_idx" ON "PayoutMethod" ("supplierId");

-- TourSecondaryTheme
CREATE TABLE IF NOT EXISTS "TourSecondaryTheme" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    CONSTRAINT "TourSecondaryTheme_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TourSecondaryTheme_tourId_theme_key" ON "TourSecondaryTheme" ("tourId", "theme");
CREATE INDEX IF NOT EXISTS "TourSecondaryTheme_theme_idx" ON "TourSecondaryTheme" ("theme");
CREATE INDEX IF NOT EXISTS "TourSecondaryTheme_tourId_idx" ON "TourSecondaryTheme" ("tourId");

-- Payout
CREATE TABLE IF NOT EXISTS "Payout" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "commissionAmount" DECIMAL(10,2) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "processedAt" TIMESTAMP(3),
    "processedBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "payoutMethodId" TEXT,
    "paymentMethod" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Payout_supplierId_idx" ON "Payout" ("supplierId");
CREATE INDEX IF NOT EXISTS "Payout_status_idx" ON "Payout" ("status");
CREATE INDEX IF NOT EXISTS "Payout_createdAt_idx" ON "Payout" ("createdAt");
CREATE INDEX IF NOT EXISTS "Payout_bookingId_idx" ON "Payout" ("bookingId");
CREATE INDEX IF NOT EXISTS "Payout_payoutMethodId_idx" ON "Payout" ("payoutMethodId");

-- Event
CREATE TABLE IF NOT EXISTS "Event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "resource" TEXT,
    "resourceId" TEXT,
    "properties" JSONB NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Event_name_idx" ON "Event" ("name");
CREATE INDEX IF NOT EXISTS "Event_userId_idx" ON "Event" ("userId");
CREATE INDEX IF NOT EXISTS "Event_resource_resourceId_idx" ON "Event" ("resource", "resourceId");
CREATE INDEX IF NOT EXISTS "Event_createdAt_idx" ON "Event" ("createdAt");
CREATE INDEX IF NOT EXISTS "Event_name_createdAt_idx" ON "Event" ("name", "createdAt");
CREATE INDEX IF NOT EXISTS "Event_userId_name_createdAt_idx" ON "Event" ("userId", "name", "createdAt");

-- ================================
-- 3. FOREIGN KEY CONSTRAINTS
-- ================================

-- PayoutMethod -> User
DO $$ BEGIN
  ALTER TABLE "PayoutMethod" ADD CONSTRAINT "PayoutMethod_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- TourSecondaryTheme -> Tour
DO $$ BEGIN
  ALTER TABLE "TourSecondaryTheme" ADD CONSTRAINT "TourSecondaryTheme_tourId_fkey"
    FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Payout -> User
DO $$ BEGIN
  ALTER TABLE "Payout" ADD CONSTRAINT "Payout_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Payout -> Booking
DO $$ BEGIN
  ALTER TABLE "Payout" ADD CONSTRAINT "Payout_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Payout -> PayoutMethod
DO $$ BEGIN
  ALTER TABLE "Payout" ADD CONSTRAINT "Payout_payoutMethodId_fkey"
    FOREIGN KEY ("payoutMethodId") REFERENCES "PayoutMethod"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
