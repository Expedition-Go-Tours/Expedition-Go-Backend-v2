-- AlterTable: Add AI enrichment fields to Tour
ALTER TABLE "Tour" ADD COLUMN "aiPrimaryCategory" TEXT,
ADD COLUMN "aiSecondaryCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "aiMoodTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "aiActivityLevel" TEXT,
ADD COLUMN "aiConfidence" DOUBLE PRECISION,
ADD COLUMN "aiScoredAt" TIMESTAMPTZ,
ADD COLUMN "aiProcessingStatus" TEXT NOT NULL DEFAULT 'PENDING';

-- CreateTable: TourImageAnalysis
CREATE TABLE "TourImageAnalysis" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "aiLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aiQualityScore" DOUBLE PRECISION,
    "aiSubjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aiDescription" TEXT,
    "aiCategoryHint" TEXT,
    "attractionRelevance" JSONB,
    "primaryAttraction" TEXT,
    "aiModelVersion" TEXT,
    "aiProcessedAt" TIMESTAMPTZ,
    "aiRetryCount" INTEGER NOT NULL DEFAULT 0,
    "aiStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TourImageAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: TourImageAnalysis
CREATE UNIQUE INDEX "TourImageAnalysis_imageUrl_key" ON "TourImageAnalysis"("imageUrl");
CREATE INDEX "TourImageAnalysis_tourId_idx" ON "TourImageAnalysis"("tourId");
CREATE INDEX "TourImageAnalysis_aiStatus_idx" ON "TourImageAnalysis"("aiStatus");

-- AddForeignKey: TourImageAnalysis -> Tour
ALTER TABLE "TourImageAnalysis" ADD CONSTRAINT "TourImageAnalysis_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: HomepageSectionCache
CREATE TABLE "HomepageSectionCache" (
    "id" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'GH',
    "data" JSONB NOT NULL,
    "computedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "HomepageSectionCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: HomepageSectionCache
CREATE UNIQUE INDEX "HomepageSectionCache_sectionKey_region_key" ON "HomepageSectionCache"("sectionKey", "region");

-- CreateTable: Attraction
CREATE TABLE "Attraction" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "heroImage" TEXT,
    "heroImageSource" TEXT,
    "heroImageTourId" TEXT,
    "imageRelevance" DOUBLE PRECISION,
    "tourCount" INTEGER NOT NULL DEFAULT 0,
    "avgRating" DOUBLE PRECISION,
    "totalBookings" INTEGER NOT NULL DEFAULT 0,
    "startingPrice" DOUBLE PRECISION,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastComputedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Attraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Attraction
CREATE UNIQUE INDEX "Attraction_name_key" ON "Attraction"("name");
CREATE UNIQUE INDEX "Attraction_slug_key" ON "Attraction"("slug");
CREATE INDEX "Attraction_status_idx" ON "Attraction"("status");
CREATE INDEX "Attraction_isFeatured_idx" ON "Attraction"("isFeatured");
CREATE INDEX "Attraction_tourCount_idx" ON "Attraction"("tourCount");
