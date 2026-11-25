-- CreateEnum
CREATE TYPE "ProductDomain" AS ENUM ('STAYS', 'EXPERIENCES');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "domain" "ProductDomain" NOT NULL DEFAULT 'EXPERIENCES',
ADD COLUMN     "propertyId" TEXT,
ADD COLUMN     "stayBookingId" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "domain" "ProductDomain" NOT NULL DEFAULT 'EXPERIENCES';

-- CreateIndex
CREATE INDEX "Conversation_domain_idx" ON "Conversation"("domain");

-- CreateIndex
CREATE INDEX "Conversation_stayBookingId_idx" ON "Conversation"("stayBookingId");

-- CreateIndex
CREATE INDEX "Conversation_propertyId_idx" ON "Conversation"("propertyId");

-- CreateIndex
CREATE INDEX "Notification_domain_idx" ON "Notification"("domain");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_stayBookingId_fkey" FOREIGN KEY ("stayBookingId") REFERENCES "StayBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "StayProperty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
