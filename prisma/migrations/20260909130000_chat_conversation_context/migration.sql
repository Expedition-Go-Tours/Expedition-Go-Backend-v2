-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "bookingId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "bookingNumber" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "tourTitle" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_bookingId_idx" ON "Conversation"("bookingId");
