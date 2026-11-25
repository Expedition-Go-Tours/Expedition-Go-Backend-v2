-- Restaurant homepage data: stored booking demand and brand-scoped offers.
--
-- Purely additive. demandScore/highDemand are written only by the batch stats
-- job (never on a request) and the public DTO exposes the boolean, not the
-- score. Offers are scoped per brand because one venue can be listed on more
-- than one storefront with different promotions.

-- AlterTable
ALTER TABLE "restaurant_venues"
  ADD COLUMN "demandScore" DOUBLE PRECISION,
  ADD COLUMN "highDemand" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "restaurant_venue_offers" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "discountType" TEXT NOT NULL,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "promoCode" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "terms" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_venue_offers_brand_isActive_startsAt_endsAt_idx"
  ON "restaurant_venue_offers"("brand", "isActive", "startsAt", "endsAt");

CREATE INDEX "restaurant_venue_offers_venueId_brand_isActive_idx"
  ON "restaurant_venue_offers"("venueId", "brand", "isActive");

-- AddForeignKey
ALTER TABLE "restaurant_venue_offers" ADD CONSTRAINT "restaurant_venue_offers_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
