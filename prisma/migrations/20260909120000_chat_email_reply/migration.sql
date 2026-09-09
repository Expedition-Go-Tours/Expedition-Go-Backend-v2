-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "replyToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_replyToken_key" ON "Conversation"("replyToken");

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "via" TEXT NOT NULL DEFAULT 'app';
ALTER TABLE "Message" ADD COLUMN "senderEmail" TEXT;
ALTER TABLE "Message" ADD COLUMN "inboundMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_inboundMessageId_key" ON "Message"("inboundMessageId");
