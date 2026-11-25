-- CreateEnum
CREATE TYPE "StayValueAddUnit" AS ENUM ('PER_STAY', 'PER_NIGHT', 'PER_PERSON');

-- CreateTable
CREATE TABLE "StayRestrictionRule" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "weekdays" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roomIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minStay" INTEGER,
    "maxStay" INTEGER,
    "stopSell" BOOLEAN NOT NULL DEFAULT false,
    "closedToArrival" BOOLEAN NOT NULL DEFAULT false,
    "closedToDeparture" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayRestrictionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StayValueAdd" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "unit" "StayValueAddUnit" NOT NULL DEFAULT 'PER_STAY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayValueAdd_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StayRestrictionRule_propertyId_isActive_idx" ON "StayRestrictionRule"("propertyId", "isActive");

-- CreateIndex
CREATE INDEX "StayRestrictionRule_propertyId_startDate_endDate_idx" ON "StayRestrictionRule"("propertyId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "StayValueAdd_propertyId_isActive_sortOrder_idx" ON "StayValueAdd"("propertyId", "isActive", "sortOrder");

-- AddForeignKey
ALTER TABLE "StayRestrictionRule" ADD CONSTRAINT "StayRestrictionRule_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "StayProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayValueAdd" ADD CONSTRAINT "StayValueAdd_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "StayProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
