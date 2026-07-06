-- CreateTable
CREATE TABLE "ExpeditionTour" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpeditionTour_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpeditionTour_tourId_key" ON "ExpeditionTour"("tourId");

-- CreateIndex
CREATE INDEX "ExpeditionTour_isActive_displayOrder_idx" ON "ExpeditionTour"("isActive", "displayOrder");

-- CreateIndex
CREATE INDEX "ExpeditionTour_isActive_isFeatured_displayOrder_idx" ON "ExpeditionTour"("isActive", "isFeatured", "displayOrder");

-- AddForeignKey
ALTER TABLE "ExpeditionTour" ADD CONSTRAINT "ExpeditionTour_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
