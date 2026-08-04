-- AlterTable
ALTER TABLE "Tour" ADD COLUMN     "draftContent" JSONB,
ADD COLUMN     "draftReviewNote" TEXT,
ADD COLUMN     "draftReviewedAt" TIMESTAMP(3),
ADD COLUMN     "draftStatus" TEXT,
ADD COLUMN     "draftSubmittedAt" TIMESTAMP(3);
