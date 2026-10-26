-- CreateEnum
CREATE TYPE "StayPropertyStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "StayProperty" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Untitled property',
    "type" TEXT,
    "city" TEXT,
    "country" TEXT DEFAULT 'Ghana',
    "status" "StayPropertyStatus" NOT NULL DEFAULT 'DRAFT',
    "step" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StayAvailabilityOverride" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "price" DECIMAL(10,2),
    "minStay" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayAvailabilityOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StayProperty_supplierId_status_idx" ON "StayProperty"("supplierId", "status");

-- CreateIndex
CREATE INDEX "StayProperty_supplierId_updatedAt_idx" ON "StayProperty"("supplierId", "updatedAt");

-- CreateIndex
CREATE INDEX "StayProperty_name_idx" ON "StayProperty"("name");

-- CreateIndex
CREATE INDEX "StayAvailabilityOverride_propertyId_date_idx" ON "StayAvailabilityOverride"("propertyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "StayAvailabilityOverride_propertyId_roomId_date_key" ON "StayAvailabilityOverride"("propertyId", "roomId", "date");

-- AddForeignKey
ALTER TABLE "StayProperty" ADD CONSTRAINT "StayProperty_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayAvailabilityOverride" ADD CONSTRAINT "StayAvailabilityOverride_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "StayProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
