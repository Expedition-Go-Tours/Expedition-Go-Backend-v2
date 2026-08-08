-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "KeywordRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "SpecialOffer" ADD COLUMN "discountType" "DiscountType" NOT NULL DEFAULT 'PERCENTAGE',
ADD COLUMN "fixedDiscountValue" DOUBLE PRECISION,
ADD COLUMN "earlyBirdAdvanceDays" INTEGER,
ADD COLUMN "lastMinuteWindowHours" INTEGER,
ADD COLUMN "promoCode" TEXT,
ADD COLUMN "minQuantity" INTEGER,
ADD COLUMN "minSpendAmount" DOUBLE PRECISION,
ADD COLUMN "maxRedemptionsPerCustomer" INTEGER,
ADD COLUMN "stackable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN "valueForMoneyRating" INTEGER,
ADD COLUMN "guideRating" INTEGER,
ADD COLUMN "meetingRating" INTEGER,
ADD COLUMN "travelMonth" TEXT;

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN "discounts" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN "appliedOfferId" TEXT;

-- CreateTable
CREATE TABLE "WishlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordRequest" (
    "id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "KeywordRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpecialOffer_promoCode_key" ON "SpecialOffer"("promoCode");

-- CreateIndex
CREATE UNIQUE INDEX "WishlistItem_userId_tourId_key" ON "WishlistItem"("userId", "tourId");

-- CreateIndex
CREATE INDEX "WishlistItem_userId_addedAt_idx" ON "WishlistItem"("userId", "addedAt");

-- CreateIndex
CREATE INDEX "WishlistItem_tourId_idx" ON "WishlistItem"("tourId");

-- CreateIndex
CREATE INDEX "KeywordRequest_supplierId_idx" ON "KeywordRequest"("supplierId");

-- CreateIndex
CREATE INDEX "KeywordRequest_status_idx" ON "KeywordRequest"("status");

-- CreateIndex
CREATE INDEX "KeywordRequest_keyword_idx" ON "KeywordRequest"("keyword");

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordRequest" ADD CONSTRAINT "KeywordRequest_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
