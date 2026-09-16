-- AlterTable
ALTER TABLE "AdminNotification" ADD COLUMN "storefront" TEXT;

-- CreateIndex
CREATE INDEX "AdminNotification_storefront_idx" ON "AdminNotification"("storefront");
