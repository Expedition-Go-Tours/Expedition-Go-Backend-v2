-- Restaurant venues: a new vertical beside Tour.
--
-- Purely additive. No existing table, column or index is touched, so this
-- migration cannot change the behaviour of any current query.
--
-- Shape notes that are load-bearing:
--   * A venue is visible only through an ACTIVE per-brand listing.
--   * Reviews are unique per (venue, author, visit month), matching the
--     "one review per visit, one month apart for restaurants" rule.
--   * proofRef is unique: a signed visit invite can be redeemed once.
--   * averageRating is the only displayed rating; externalRating is a labelled
--     per-source headline; rankingScore is internal ordering and is never
--     returned as stars.
--   * rankInCity is the ordinal travellers understand ("#8 of 143 in Osu"),
--     recomputed nightly because it moves when other venues get reviews.

-- CreateEnum
CREATE TYPE "RestaurantVenueStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RestaurantReviewSource" AS ENUM ('TRAVIO_VERIFIED', 'TRAVIO_COMMUNITY', 'IMPORTED');

-- CreateEnum
CREATE TYPE "RestaurantReviewProof" AS ENUM ('BOOKING', 'QR_RECEIPT', 'EMAIL_INVITE');

-- CreateEnum
CREATE TYPE "RestaurantReviewReportClass" AS ENUM ('FAKE', 'CONTESTED');

-- CreateEnum
CREATE TYPE "RestaurantReviewReportStatus" AS ENUM ('OPEN', 'UPHELD', 'DISMISSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReviewStatus" ADD VALUE 'ARCHIVED';
ALTER TYPE "ReviewStatus" ADD VALUE 'REMOVED';

-- CreateTable
CREATE TABLE "restaurant_venues" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RestaurantVenueStatus" NOT NULL DEFAULT 'DRAFT',
    "googlePlaceId" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "addressLine" TEXT,
    "neighbourhood" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT NOT NULL DEFAULT 'Ghana',
    "cuisines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dietary" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priceBand" INTEGER,
    "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hours" JSONB,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
    "phone" TEXT,
    "website" TEXT,
    "description" TEXT,
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coverPhoto" TEXT,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "averageRating" DOUBLE PRECISION,
    "verifiedReviewCount" INTEGER NOT NULL DEFAULT 0,
    "distribution" JSONB,
    "lastReviewAt" TIMESTAMP(3),
    "recentRating" DOUBLE PRECISION,
    "recentReviewCount" INTEGER NOT NULL DEFAULT 0,
    "externalSource" TEXT,
    "externalRating" DOUBLE PRECISION,
    "externalReviewCount" INTEGER NOT NULL DEFAULT 0,
    "combinedRating" DOUBLE PRECISION,
    "combinedReviewCount" INTEGER NOT NULL DEFAULT 0,
    "rankingScore" DOUBLE PRECISION,
    "rankInCity" INTEGER,
    "cityVenueCount" INTEGER,
    "rankComputedAt" TIMESTAMP(3),
    "googleSyncedAt" TIMESTAMP(3),
    "supplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_venue_reviews" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "foodRating" INTEGER,
    "serviceRating" INTEGER,
    "atmosphereRating" INTEGER,
    "valueRating" INTEGER,
    "title" TEXT,
    "body" TEXT,
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "RestaurantReviewSource" NOT NULL DEFAULT 'TRAVIO_COMMUNITY',
    "proofMethod" "RestaurantReviewProof",
    "proofRef" TEXT,
    "visitedAt" TIMESTAMP(3),
    "visitKey" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "moderatedBy" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "flagReason" TEXT,
    "helpfulCount" INTEGER NOT NULL DEFAULT 0,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_venue_listings" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_venue_external_stats" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rating" DECIMAL(3,2),
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "distribution" JSONB,
    "productId" TEXT,
    "productUrl" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_external_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_venue_review_reports" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "reporterUserId" TEXT,
    "reporterRole" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "status" "RestaurantReviewReportStatus" NOT NULL DEFAULT 'OPEN',
    "classification" "RestaurantReviewReportClass",
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_review_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_venues_slug_key" ON "restaurant_venues"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_venues_googlePlaceId_key" ON "restaurant_venues"("googlePlaceId");

-- CreateIndex
CREATE INDEX "restaurant_venues_status_rankingScore_idx" ON "restaurant_venues"("status", "rankingScore" DESC);

-- CreateIndex
CREATE INDEX "restaurant_venues_status_combinedReviewCount_idx" ON "restaurant_venues"("status", "combinedReviewCount" DESC);

-- CreateIndex
CREATE INDEX "restaurant_venues_city_status_rankingScore_idx" ON "restaurant_venues"("city", "status", "rankingScore" DESC);

-- CreateIndex
CREATE INDEX "restaurant_venues_city_rankInCity_idx" ON "restaurant_venues"("city", "rankInCity");

-- CreateIndex
CREATE INDEX "restaurant_venues_latitude_longitude_idx" ON "restaurant_venues"("latitude", "longitude");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_venue_reviews_proofRef_key" ON "restaurant_venue_reviews"("proofRef");

-- CreateIndex
CREATE INDEX "restaurant_venue_reviews_venueId_authorId_createdAt_idx" ON "restaurant_venue_reviews"("venueId", "authorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "restaurant_venue_reviews_venueId_status_createdAt_id_idx" ON "restaurant_venue_reviews"("venueId", "status", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "restaurant_venue_reviews_venueId_status_rating_idx" ON "restaurant_venue_reviews"("venueId", "status", "rating");

-- CreateIndex
CREATE INDEX "restaurant_venue_reviews_status_createdAt_idx" ON "restaurant_venue_reviews"("status", "createdAt");

-- CreateIndex
CREATE INDEX "restaurant_venue_reviews_authorId_createdAt_idx" ON "restaurant_venue_reviews"("authorId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_venue_reviews_venueId_authorId_visitKey_key" ON "restaurant_venue_reviews"("venueId", "authorId", "visitKey");

-- CreateIndex
CREATE INDEX "restaurant_venue_listings_brand_isActive_displayOrder_idx" ON "restaurant_venue_listings"("brand", "isActive", "displayOrder");

-- CreateIndex
CREATE INDEX "restaurant_venue_listings_brand_isActive_isFeatured_idx" ON "restaurant_venue_listings"("brand", "isActive", "isFeatured");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_venue_listings_brand_venueId_key" ON "restaurant_venue_listings"("brand", "venueId");

-- CreateIndex
CREATE INDEX "restaurant_venue_external_stats_venueId_idx" ON "restaurant_venue_external_stats"("venueId");

-- CreateIndex
CREATE INDEX "restaurant_venue_external_stats_source_idx" ON "restaurant_venue_external_stats"("source");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_venue_external_stats_venueId_source_key" ON "restaurant_venue_external_stats"("venueId", "source");

-- CreateIndex
CREATE INDEX "restaurant_venue_review_reports_reviewId_status_idx" ON "restaurant_venue_review_reports"("reviewId", "status");

-- CreateIndex
CREATE INDEX "restaurant_venue_review_reports_status_createdAt_idx" ON "restaurant_venue_review_reports"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "restaurant_venue_reviews" ADD CONSTRAINT "restaurant_venue_reviews_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_venue_reviews" ADD CONSTRAINT "restaurant_venue_reviews_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_venue_listings" ADD CONSTRAINT "restaurant_venue_listings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_venue_external_stats" ADD CONSTRAINT "restaurant_venue_external_stats_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_venue_review_reports" ADD CONSTRAINT "restaurant_venue_review_reports_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "restaurant_venue_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

