-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "stripeCheckoutSessionId" TEXT;

-- CreateIndex
CREATE INDEX "Booking_stripeCheckoutSessionId_idx" ON "Booking"("stripeCheckoutSessionId");