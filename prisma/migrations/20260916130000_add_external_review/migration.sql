-- CreateTable
CREATE TABLE "ExternalReview" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformUrl" TEXT NOT NULL,
    "externalId" TEXT,
    "authorName" TEXT,
    "authorPhoto" TEXT,
    "rating" DOUBLE PRECISION,
    "title" TEXT,
    "text" TEXT,
    "reviewDate" TIMESTAMP(3),
    "language" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "displayed" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ExternalReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalReview_tourId_platform_externalId_key" ON "ExternalReview"("tourId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "ExternalReview_tourId_idx" ON "ExternalReview"("tourId");

-- CreateIndex
CREATE INDEX "ExternalReview_tourId_displayed_reviewDate_idx" ON "ExternalReview"("tourId", "displayed", "reviewDate");

-- AddForeignKey
ALTER TABLE "ExternalReview" ADD CONSTRAINT "ExternalReview_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: Add externalReviewUrls to Tour
ALTER TABLE "Tour" ADD COLUMN "externalReviewUrls" JSONB;