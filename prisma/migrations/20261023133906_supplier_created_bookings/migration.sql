-- CreateEnum
CREATE TYPE "BookingOrigin" AS ENUM ('MARKETPLACE', 'SUPPLIER_CREATED');

-- CreateEnum
CREATE TYPE "CollectionMethod" AS ENUM ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'POS', 'OTHER');

-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('RECORDED', 'REVERSED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "guestId" TEXT,
ADD COLUMN     "origin" "BookingOrigin" NOT NULL DEFAULT 'MARKETPLACE',
ALTER COLUMN "customerId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "BookingGuest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingGuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingCollection" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "method" "CollectionMethod" NOT NULL,
    "status" "CollectionStatus" NOT NULL DEFAULT 'RECORDED',
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT NOT NULL,
    "externalRef" TEXT,
    "evidenceRef" TEXT,
    "note" TEXT,
    "reversesId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingIdempotencyKey" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingGuest_email_idx" ON "BookingGuest"("email");

-- CreateIndex
CREATE INDEX "BookingGuest_phone_idx" ON "BookingGuest"("phone");

-- CreateIndex
CREATE INDEX "BookingCollection_bookingId_collectedAt_idx" ON "BookingCollection"("bookingId", "collectedAt");

-- CreateIndex
CREATE INDEX "BookingCollection_supplierId_collectedAt_idx" ON "BookingCollection"("supplierId", "collectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingCollection_bookingId_idempotencyKey_key" ON "BookingCollection"("bookingId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BookingIdempotencyKey_createdAt_idx" ON "BookingIdempotencyKey"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingIdempotencyKey_supplierId_key_key" ON "BookingIdempotencyKey"("supplierId", "key");

-- CreateIndex
CREATE INDEX "Booking_origin_createdAt_idx" ON "Booking"("origin", "createdAt");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "BookingGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCollection" ADD CONSTRAINT "BookingCollection_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCollection" ADD CONSTRAINT "BookingCollection_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCollection" ADD CONSTRAINT "BookingCollection_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCollection" ADD CONSTRAINT "BookingCollection_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "BookingCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingIdempotencyKey" ADD CONSTRAINT "BookingIdempotencyKey_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
