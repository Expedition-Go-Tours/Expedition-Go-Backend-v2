-- Restaurant claims and venue members.
--
-- Purely additive. Claim submission never changes a listing: an admin must
-- approve a claim before a membership row is created. One membership per
-- venue/user keeps the owner surface small and auditable.

-- CreateEnum
CREATE TYPE "RestaurantVenueClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "RestaurantVenueMemberRole" AS ENUM ('OWNER', 'MANAGER');

-- CreateTable
CREATE TABLE "restaurant_venue_claims" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "businessName" TEXT,
    "role" TEXT,
    "contactEmail" TEXT NOT NULL,
    "phone" TEXT,
    "message" TEXT,
    "evidenceUrl" TEXT,
    "status" "RestaurantVenueClaimStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_venue_members" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RestaurantVenueMemberRole" NOT NULL DEFAULT 'OWNER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_venue_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_venue_claims_venueId_userId_status_idx" ON "restaurant_venue_claims"("venueId", "userId", "status");
CREATE INDEX "restaurant_venue_claims_venueId_status_createdAt_idx" ON "restaurant_venue_claims"("venueId", "status", "createdAt");
CREATE INDEX "restaurant_venue_claims_status_createdAt_idx" ON "restaurant_venue_claims"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_venue_members_venueId_userId_key" ON "restaurant_venue_members"("venueId", "userId");
CREATE INDEX "restaurant_venue_members_userId_status_idx" ON "restaurant_venue_members"("userId", "status");

-- AddForeignKey
ALTER TABLE "restaurant_venue_claims" ADD CONSTRAINT "restaurant_venue_claims_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_venue_claims" ADD CONSTRAINT "restaurant_venue_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_venue_members" ADD CONSTRAINT "restaurant_venue_members_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "restaurant_venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_venue_members" ADD CONSTRAINT "restaurant_venue_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
