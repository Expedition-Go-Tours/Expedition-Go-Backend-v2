-- CreateEnum
CREATE TYPE "NotificationRecipientStatus" AS ENUM ('PENDING', 'VERIFIED', 'DISABLED');

-- CreateTable
CREATE TABLE "SupplierNotificationRecipient" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "status" "NotificationRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "verifyTokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "disableReason" TEXT,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierNotificationRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierNotificationRecipient_verifyTokenHash_key" ON "SupplierNotificationRecipient"("verifyTokenHash");

-- CreateIndex
CREATE INDEX "SupplierNotificationRecipient_supplierId_status_idx" ON "SupplierNotificationRecipient"("supplierId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierNotificationRecipient_supplierId_email_key" ON "SupplierNotificationRecipient"("supplierId", "email");

-- AddForeignKey
ALTER TABLE "SupplierNotificationRecipient" ADD CONSTRAINT "SupplierNotificationRecipient_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierNotificationRecipient" ADD CONSTRAINT "SupplierNotificationRecipient_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
