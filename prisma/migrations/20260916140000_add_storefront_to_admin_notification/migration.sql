-- AlterTable
ALTER TABLE "AdminNotification" ADD COLUMN IF NOT EXISTS "storefront" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AdminNotification_storefront_idx" ON "AdminNotification"("storefront");
