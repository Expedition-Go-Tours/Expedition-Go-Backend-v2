-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "offerName" TEXT;
ALTER TABLE "Booking" ADD COLUMN "offerPromoCode" TEXT;
ALTER TABLE "Booking" ADD COLUMN "offerDiscountType" TEXT;
ALTER TABLE "Booking" ADD COLUMN "offerDiscountPct" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "offerDiscountFix" DOUBLE PRECISION;
