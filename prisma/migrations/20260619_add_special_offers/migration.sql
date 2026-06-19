-- CreateEnum
CREATE TYPE "SpecialOfferType" AS ENUM ('LIMITED_TIME', 'EARLY_BIRD', 'LAST_MINUTE');

-- CreateEnum
CREATE TYPE "SpecialOfferCapacityType" AS ENUM ('UNLIMITED', 'CAPPED');

-- CreateEnum
CREATE TYPE "SpecialOfferTimeSlotMode" AS ENUM ('ALL_DAYS', 'SPECIFIC_WEEKDAYS');

-- CreateEnum
CREATE TYPE "OverrideStatus" AS ENUM ('AVAILABLE', 'LIMITED', 'FULL', 'BLOCKED');

-- CreateTable
CREATE TABLE "SpecialOffer" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "offerType" "SpecialOfferType" NOT NULL,
    "discountPercentage" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "capacityType" "SpecialOfferCapacityType" NOT NULL DEFAULT 'UNLIMITED',
    "maxSpots" INTEGER,
    "spotsSold" INTEGER NOT NULL DEFAULT 0,
    "timeSlotMode" "SpecialOfferTimeSlotMode" NOT NULL DEFAULT 'ALL_DAYS',
    "specificWeekdays" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialOfferTarget" (
    "id" TEXT NOT NULL,
    "specialOfferId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "tourOptionKey" TEXT,
    "tourOptionLabel" TEXT,

    CONSTRAINT "SpecialOfferTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TourDateOverride" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "OverrideStatus" NOT NULL DEFAULT 'AVAILABLE',
    "capacity" INTEGER,
    "timeSlotOverrides" JSONB,
    "notes" TEXT,

    CONSTRAINT "TourDateOverride_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "appliedOfferId" TEXT;

-- CreateIndex
CREATE INDEX "SpecialOffer_supplierId_idx" ON "SpecialOffer"("supplierId");
CREATE INDEX "SpecialOffer_isActive_startDate_endDate_idx" ON "SpecialOffer"("isActive", "startDate", "endDate");
CREATE INDEX "SpecialOffer_offerType_idx" ON "SpecialOffer"("offerType");

-- CreateIndex
CREATE INDEX "SpecialOfferTarget_tourId_idx" ON "SpecialOfferTarget"("tourId");
CREATE INDEX "SpecialOfferTarget_tourOptionKey_idx" ON "SpecialOfferTarget"("tourOptionKey");
CREATE UNIQUE INDEX "SpecialOfferTarget_specialOfferId_tourId_tourOptionKey_key" ON "SpecialOfferTarget"("specialOfferId", "tourId", "tourOptionKey");

-- CreateIndex
CREATE UNIQUE INDEX "TourDateOverride_tourId_date_key" ON "TourDateOverride"("tourId", "date");
CREATE INDEX "TourDateOverride_tourId_date_idx" ON "TourDateOverride"("tourId", "date");

-- AddForeignKey
ALTER TABLE "SpecialOffer" ADD CONSTRAINT "SpecialOffer_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialOfferTarget" ADD CONSTRAINT "SpecialOfferTarget_specialOfferId_fkey" FOREIGN KEY ("specialOfferId") REFERENCES "SpecialOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpecialOfferTarget" ADD CONSTRAINT "SpecialOfferTarget_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TourDateOverride" ADD CONSTRAINT "TourDateOverride_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
