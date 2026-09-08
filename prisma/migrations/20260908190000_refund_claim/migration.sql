-- CreateEnum
CREATE TYPE "RefundClaimType" AS ENUM ('FULL', 'PARTIAL');

-- CreateEnum
CREATE TYPE "RefundClaimStatus" AS ENUM ('SUBMITTED', 'SUPPLIER_APPROVED', 'SUPPLIER_DECLINED', 'RELEASED', 'ADMIN_DECLINED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "RefundClaim" (
    "id" TEXT NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "type" "RefundClaimType" NOT NULL DEFAULT 'FULL',
    "requestedAmount" DECIMAL(10, 2),
    "status" "RefundClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedAmount" DECIMAL(10, 2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefundClaim_claimNumber_key" ON "RefundClaim"("claimNumber");

-- CreateIndex
CREATE INDEX "RefundClaim_bookingId_idx" ON "RefundClaim"("bookingId");

-- CreateIndex
CREATE INDEX "RefundClaim_customerId_idx" ON "RefundClaim"("customerId");

-- CreateIndex
CREATE INDEX "RefundClaim_supplierId_idx" ON "RefundClaim"("supplierId");

-- CreateIndex
CREATE INDEX "RefundClaim_status_idx" ON "RefundClaim"("status");

-- AddForeignKey
ALTER TABLE "RefundClaim" ADD CONSTRAINT "RefundClaim_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
