-- "Delete for me": per-user message hiding for the chat. A message hidden by
-- one participant stays visible to everyone else and its attachments are kept.
-- Additive only — no existing rows are touched.
CREATE TABLE "ChatMessageHide" (
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hiddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageHide_pkey" PRIMARY KEY ("messageId", "userId")
);

-- Foreign key to Message (cascade so deleting a message removes its hides).
ALTER TABLE "ChatMessageHide"
    ADD CONSTRAINT "ChatMessageHide_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Lookup by user (used to filter a user's hidden messages).
CREATE INDEX "ChatMessageHide_userId_idx" ON "ChatMessageHide" ("userId");
