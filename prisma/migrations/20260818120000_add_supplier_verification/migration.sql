-- ============================================================
-- Supplier Registration & Quality Control
-- Adds supplier types, per-document verification + expiry,
-- vehicles, guides, verification history, and an EXPIRED status.
-- ============================================================

-- AlterEnum: new supplier lifecycle statuses
ALTER TYPE "SupplierStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- AlterEnum: new supplier-facing notification types
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DOCUMENT_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DOCUMENT_EXPIRY_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DOCUMENT_EXPIRED';

-- AlterEnum: new admin-facing notification types
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'DOCUMENT_EXPIRING';
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'DOCUMENT_EXPIRED';

-- New enum: supplier registration categories
CREATE TYPE "SupplierType" AS ENUM (
  'TOUR_GUIDE',
  'TOUR_COMPANY',
  'ACCOMMODATION_PROVIDER',
  'TRANSPORTATION_PROVIDER',
  'VEHICLE_OPERATOR',
  'OTHER_SERVICE_PROVIDER'
);

-- New enum: document categories
CREATE TYPE "DocumentType" AS ENUM (
  'GHANA_CARD',
  'NATIONAL_ID',
  'TOUR_GUIDE_LICENCE',
  'DRIVERS_LICENCE',
  'BUSINESS_CERTIFICATE',
  'GTA_CERTIFICATE',
  'PROOF_OF_ADDRESS',
  'PROFILE_PHOTO',
  'PASSENGER_TRANSPORT_LICENCE',
  'VEHICLE_REGISTRATION',
  'VEHICLE_OWNERSHIP',
  'VEHICLE_ROADWORTHINESS',
  'VEHICLE_INSURANCE',
  'OTHER'
);

-- New enum: per-document verification status
CREATE TYPE "DocumentStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'REPLACEMENT_REQUESTED',
  'EXPIRED'
);

-- New enum: which entity a document/event belongs to
CREATE TYPE "VerificationTarget" AS ENUM (
  'SUPPLIER',
  'VEHICLE',
  'GUIDE'
);

CREATE TYPE "VehicleStatus" AS ENUM (
  'PENDING',
  'VERIFIED',
  'REJECTED'
);

CREATE TYPE "GuideStatus" AS ENUM (
  'PENDING',
  'VERIFIED',
  'REJECTED'
);

-- SupplierProfile: add supplier type column (backfilled to TOUR_COMPANY)
ALTER TABLE "SupplierProfile"
ADD COLUMN "supplierType" "SupplierType" NOT NULL DEFAULT 'TOUR_COMPANY';

-- Table: SupplierDocument (one row per uploaded file)
CREATE TABLE "SupplierDocument" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "ownerType" "VerificationTarget" NOT NULL DEFAULT 'SUPPLIER',
  "ownerId" TEXT,
  "type" "DocumentType" NOT NULL,
  "url" TEXT NOT NULL,
  "filename" TEXT,
  "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
  "expiryDate" TIMESTAMP(3),
  "reviewNote" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierDocument_pkey" PRIMARY KEY ("id")
);

-- Table: VerificationEvent (immutable verification history)
CREATE TABLE "VerificationEvent" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "entityType" "VerificationTarget" NOT NULL DEFAULT 'SUPPLIER',
  "entityId" TEXT,
  "action" TEXT NOT NULL,
  "actorId" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VerificationEvent_pkey" PRIMARY KEY ("id")
);

-- Table: Vehicle
CREATE TABLE "Vehicle" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "make" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "year" INTEGER,
  "registrationNumber" TEXT NOT NULL,
  "photos" TEXT[],
  "status" "VehicleStatus" NOT NULL DEFAULT 'PENDING',
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- Table: Guide
CREATE TABLE "Guide" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "userId" TEXT,
  "fullName" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "status" "GuideStatus" NOT NULL DEFAULT 'PENDING',
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Guide_pkey" PRIMARY KEY ("id")
);

-- Foreign keys + indexes
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "SupplierProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VerificationEvent" ADD CONSTRAINT "VerificationEvent_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "SupplierProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "SupplierProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Guide" ADD CONSTRAINT "Guide_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "SupplierProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "SupplierDocument_supplierId_status_idx" ON "SupplierDocument"("supplierId", "status");
CREATE INDEX "SupplierDocument_ownerType_ownerId_idx" ON "SupplierDocument"("ownerType", "ownerId");
CREATE INDEX "SupplierDocument_status_expiryDate_idx" ON "SupplierDocument"("status", "expiryDate");
CREATE INDEX "SupplierDocument_type_idx" ON "SupplierDocument"("type");

CREATE INDEX "VerificationEvent_supplierId_createdAt_idx" ON "VerificationEvent"("supplierId", "createdAt");
CREATE INDEX "VerificationEvent_entityType_entityId_idx" ON "VerificationEvent"("entityType", "entityId");

CREATE INDEX "Vehicle_supplierId_status_idx" ON "Vehicle"("supplierId", "status");
CREATE INDEX "Vehicle_registrationNumber_idx" ON "Vehicle"("registrationNumber");

CREATE INDEX "Guide_supplierId_status_idx" ON "Guide"("supplierId", "status");