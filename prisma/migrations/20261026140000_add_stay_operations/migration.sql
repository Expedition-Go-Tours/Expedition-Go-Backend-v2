-- CreateEnum
CREATE TYPE "StayBookingStatus" AS ENUM ('NEW', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "StayOfferType" AS ENUM ('LIMITED_TIME', 'EARLY_BIRD', 'LAST_MINUTE');

-- CreateTable
CREATE TABLE "StayBooking" (
    "id" TEXT NOT NULL,
    "bookingNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomId" TEXT,
    "roomName" TEXT,
    "ratePlanId" TEXT,
    "ratePlanName" TEXT,
    "customerId" TEXT,
    "guestName" TEXT NOT NULL,
    "guestEmail" TEXT,
    "guestPhone" TEXT,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "nights" INTEGER NOT NULL,
    "guests" INTEGER NOT NULL DEFAULT 1,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "status" "StayBookingStatus" NOT NULL DEFAULT 'NEW',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "origin" "BookingOrigin" NOT NULL DEFAULT 'SUPPLIER_CREATED',
    "specialRequests" TEXT,
    "cancellationReason" TEXT,
    "cancellationNote" TEXT,
    "refundAmount" DECIMAL(10,2),
    "countsTowardRate" BOOLEAN,
    "commissionRate" DECIMAL(5,4) NOT NULL DEFAULT 0.1500,
    "platformCommission" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "supplierPayout" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "payoutStatus" "BookingPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StayOffer" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "offerType" "StayOfferType" NOT NULL,
    "discountType" "DiscountType" NOT NULL DEFAULT 'PERCENTAGE',
    "discountPercentage" INTEGER NOT NULL DEFAULT 10,
    "fixedDiscountValue" DOUBLE PRECISION,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "capacityType" "SpecialOfferCapacityType" NOT NULL DEFAULT 'UNLIMITED',
    "maxSpots" INTEGER,
    "spotsSold" INTEGER NOT NULL DEFAULT 0,
    "timeSlotMode" "SpecialOfferTimeSlotMode" NOT NULL DEFAULT 'ALL_DAYS',
    "specificWeekdays" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "earlyBirdAdvanceDays" INTEGER,
    "lastMinuteWindowHours" INTEGER,
    "promoCode" TEXT,
    "minQuantity" INTEGER,
    "minSpendAmount" DOUBLE PRECISION,
    "maxRedemptionsPerCustomer" INTEGER,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StayOfferTarget" (
    "id" TEXT NOT NULL,
    "stayOfferId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "propertyName" TEXT,
    "roomId" TEXT,
    "roomLabel" TEXT,

    CONSTRAINT "StayOfferTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StayReview" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "bookingId" TEXT,
    "customerId" TEXT,
    "guestName" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "text" TEXT,
    "reply" TEXT,
    "repliedAt" TIMESTAMP(3),
    "status" "ReviewStatus" NOT NULL DEFAULT 'APPROVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StayBooking_bookingNumber_key" ON "StayBooking"("bookingNumber");

-- CreateIndex
CREATE INDEX "StayBooking_supplierId_status_idx" ON "StayBooking"("supplierId", "status");

-- CreateIndex
CREATE INDEX "StayBooking_propertyId_checkIn_idx" ON "StayBooking"("propertyId", "checkIn");

-- CreateIndex
CREATE INDEX "StayBooking_bookingNumber_idx" ON "StayBooking"("bookingNumber");

-- CreateIndex
CREATE INDEX "StayBooking_customerId_idx" ON "StayBooking"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "StayOffer_promoCode_key" ON "StayOffer"("promoCode");

-- CreateIndex
CREATE INDEX "StayOffer_supplierId_idx" ON "StayOffer"("supplierId");

-- CreateIndex
CREATE INDEX "StayOffer_isActive_startDate_endDate_idx" ON "StayOffer"("isActive", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "StayOffer_offerType_idx" ON "StayOffer"("offerType");

-- CreateIndex
CREATE INDEX "StayOfferTarget_propertyId_idx" ON "StayOfferTarget"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "StayOfferTarget_stayOfferId_propertyId_roomId_key" ON "StayOfferTarget"("stayOfferId", "propertyId", "roomId");

-- CreateIndex
CREATE UNIQUE INDEX "StayReview_bookingId_key" ON "StayReview"("bookingId");

-- CreateIndex
CREATE INDEX "StayReview_supplierId_status_idx" ON "StayReview"("supplierId", "status");

-- CreateIndex
CREATE INDEX "StayReview_propertyId_idx" ON "StayReview"("propertyId");

-- CreateIndex
CREATE INDEX "StayReview_rating_idx" ON "StayReview"("rating");

-- AddForeignKey
ALTER TABLE "StayBooking" ADD CONSTRAINT "StayBooking_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayBooking" ADD CONSTRAINT "StayBooking_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "StayProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayBooking" ADD CONSTRAINT "StayBooking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayOffer" ADD CONSTRAINT "StayOffer_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayOfferTarget" ADD CONSTRAINT "StayOfferTarget_stayOfferId_fkey" FOREIGN KEY ("stayOfferId") REFERENCES "StayOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayOfferTarget" ADD CONSTRAINT "StayOfferTarget_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "StayProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayReview" ADD CONSTRAINT "StayReview_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayReview" ADD CONSTRAINT "StayReview_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "StayProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayReview" ADD CONSTRAINT "StayReview_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "StayBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayReview" ADD CONSTRAINT "StayReview_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
