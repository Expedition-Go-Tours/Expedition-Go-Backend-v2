-- CreateEnum
CREATE TYPE "StayPromotionKind" AS ENUM ('PROPERTY_DEAL', 'BASIC_DEAL', 'EARLY_BOOKER', 'LAST_MINUTE', 'LATE_ESCAPE');

-- AlterTable
ALTER TABLE "StayOffer" ADD COLUMN     "promotionKind" "StayPromotionKind",
ADD COLUMN     "promotionConfig" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "StayAvailabilityOverride" ADD COLUMN     "ratePlanId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "maxStay" INTEGER,
ADD COLUMN     "closedArrival" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "closedDeparture" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex
DROP INDEX "StayAvailabilityOverride_propertyId_roomId_date_key";

-- CreateIndex
CREATE UNIQUE INDEX "StayAvailabilityOverride_propertyId_roomId_ratePlanId_date_key" ON "StayAvailabilityOverride"("propertyId", "roomId", "ratePlanId", "date");

-- CreateIndex
CREATE INDEX "StayAvailabilityOverride_propertyId_ratePlanId_date_idx" ON "StayAvailabilityOverride"("propertyId", "ratePlanId", "date");
