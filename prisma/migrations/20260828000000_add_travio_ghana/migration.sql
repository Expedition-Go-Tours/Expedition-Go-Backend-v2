-- AlterEnum
ALTER TYPE "BookingSource" ADD VALUE 'GHANA';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'ghana';

-- CreateTable
CREATE TABLE "TravioGhanaTour" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "bookingFlow" "BookingFlow" NOT NULL DEFAULT 'DIRECT',
    "externalUrl" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "unpublishedById" TEXT,
    "unpublishedAt" TIMESTAMP(3),
    "unpublishReason" TEXT,
    "syncStatus" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "syncError" TEXT,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TravioGhanaTour_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TravioGhanaTour_tourId_key" ON "TravioGhanaTour"("tourId");

-- CreateIndex
CREATE INDEX "TravioGhanaTour_isActive_displayOrder_idx" ON "TravioGhanaTour"("isActive", "displayOrder");

-- CreateIndex
CREATE INDEX "TravioGhanaTour_isActive_isFeatured_displayOrder_idx" ON "TravioGhanaTour"("isActive", "isFeatured", "displayOrder");

-- AddForeignKey
ALTER TABLE "TravioGhanaTour" ADD CONSTRAINT "TravioGhanaTour_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravioGhanaTour" ADD CONSTRAINT "TravioGhanaTour_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravioGhanaTour" ADD CONSTRAINT "TravioGhanaTour_unpublishedById_fkey" FOREIGN KEY ("unpublishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravioGhanaTour" ADD CONSTRAINT "TravioGhanaTour_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
