-- DropForeignKey
ALTER TABLE "ExternalReview" DROP CONSTRAINT IF EXISTS "ExternalReview_tourId_fkey";

-- DropTable
DROP TABLE IF EXISTS "ExternalReview";

-- AlterTable: remove external review URLs from Tour
ALTER TABLE "Tour" DROP COLUMN IF EXISTS "externalReviewUrls";
