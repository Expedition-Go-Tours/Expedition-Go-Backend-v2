-- Restaurant owner dashboard.
--
-- Purely additive. The storefront keeps reading `restaurant_venues.photos`,
-- `coverPhoto`, `menuUrl` and `hours`; the tables below are the managed
-- source that publishes back into those columns. Nothing here changes a
-- public read DTO, and no existing row is rewritten.

-- CreateEnum
CREATE TYPE "RestaurantPhotoStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RestaurantPhotoSource" AS ENUM ('OWNER', 'REVIEW', 'TERRA');

-- CreateEnum
CREATE TYPE "RestaurantMenuStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "RestaurantResponseStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED', 'REMOVED');

-- CreateEnum
CREATE TYPE "RestaurantVenueInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "restaurant_venue_photos" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" "RestaurantPhotoStatus" NOT NULL DEFAULT 'PENDING',
    "source" "RestaurantPhotoSource" NOT NULL DEFAULT 'OWNER',
    "mediaId" TEXT,
    "uploadedById" TEXT,
    "moderatedBy" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "flagReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menus" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Main menu',
    "description" TEXT,
    "status" "RestaurantMenuStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "position" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menu_sections" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menu_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menu_items" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "dietary" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "photoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_venue_review_responses" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" "RestaurantVenueMemberRole" NOT NULL,
    "body" TEXT NOT NULL,
    "status" "RestaurantResponseStatus" NOT NULL DEFAULT 'PENDING',
    "moderatedBy" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "flagReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_review_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_venue_invites" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "RestaurantVenueMemberRole" NOT NULL DEFAULT 'MANAGER',
    "status" "RestaurantVenueInviteStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedById" TEXT,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_venue_photos_venueId_url_key" ON "restaurant_venue_photos"("venueId", "url");

-- CreateIndex
CREATE INDEX "restaurant_venue_photos_venueId_status_position_idx" ON "restaurant_venue_photos"("venueId", "status", "position");

-- CreateIndex
CREATE INDEX "restaurant_venue_photos_venueId_position_idx" ON "restaurant_venue_photos"("venueId", "position");

-- CreateIndex
CREATE INDEX "restaurant_venue_photos_status_createdAt_idx" ON "restaurant_venue_photos"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_menus_venueId_name_key" ON "restaurant_menus"("venueId", "name");

-- CreateIndex
CREATE INDEX "restaurant_menus_venueId_position_idx" ON "restaurant_menus"("venueId", "position");

-- CreateIndex
CREATE INDEX "restaurant_menus_venueId_status_idx" ON "restaurant_menus"("venueId", "status");

-- CreateIndex
CREATE INDEX "restaurant_menu_sections_menuId_position_idx" ON "restaurant_menu_sections"("menuId", "position");

-- CreateIndex
CREATE INDEX "restaurant_menu_items_sectionId_position_idx" ON "restaurant_menu_items"("sectionId", "position");

-- CreateIndex
CREATE INDEX "restaurant_venue_review_responses_reviewId_status_idx" ON "restaurant_venue_review_responses"("reviewId", "status");

-- CreateIndex
CREATE INDEX "restaurant_venue_review_responses_venueId_status_createdAt_idx" ON "restaurant_venue_review_responses"("venueId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "restaurant_venue_review_responses_authorId_createdAt_idx" ON "restaurant_venue_review_responses"("authorId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_venue_invites_tokenHash_key" ON "restaurant_venue_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "restaurant_venue_invites_venueId_status_createdAt_idx" ON "restaurant_venue_invites"("venueId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "restaurant_venue_invites_email_status_idx" ON "restaurant_venue_invites"("email", "status");

-- CreateIndex
CREATE INDEX "restaurant_venue_invites_status_expiresAt_idx" ON "restaurant_venue_invites"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "restaurant_venue_photos" ADD CONSTRAINT "restaurant_venue_photos_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menus" ADD CONSTRAINT "restaurant_menus_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menu_sections" ADD CONSTRAINT "restaurant_menu_sections_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "restaurant_menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "restaurant_menu_items_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "restaurant_menu_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_venue_review_responses" ADD CONSTRAINT "restaurant_venue_review_responses_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "restaurant_venue_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_venue_review_responses" ADD CONSTRAINT "restaurant_venue_review_responses_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_venue_review_responses" ADD CONSTRAINT "restaurant_venue_review_responses_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_venue_invites" ADD CONSTRAINT "restaurant_venue_invites_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
