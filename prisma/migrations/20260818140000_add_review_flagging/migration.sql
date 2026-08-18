-- Supplier review flagging: record who flagged a review, their detail, and when.
ALTER TABLE "Review"
ADD COLUMN "flaggedBy" TEXT,
ADD COLUMN "flagComment" TEXT,
ADD COLUMN "flaggedAt" TIMESTAMP(3);
