-- AlterTable: add addedById column to ExpeditionTour
ALTER TABLE "ExpeditionTour" ADD COLUMN "addedById" TEXT;

-- AddForeignKey
ALTER TABLE "ExpeditionTour" ADD CONSTRAINT "ExpeditionTour_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
