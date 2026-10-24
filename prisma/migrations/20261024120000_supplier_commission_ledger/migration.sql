-- Commission follows money actually collected, so the ledger has to know WHICH
-- collection raised each charge, which invoice settled it, and which charge a
-- compensating credit offsets. Additive: no column is dropped or retyped, and
-- the two new SupplierCharge states (REVERSED, RESERVED-via-invoice) are
-- String values, so they need no enum change.

-- AlterTable
ALTER TABLE "SupplierCharge" ADD COLUMN     "collectionId" TEXT,
ADD COLUMN     "invoiceId" TEXT,
ADD COLUMN     "reversalOfId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "chargesTotal" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "commissionPolicy" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCharge_collectionId_key" ON "SupplierCharge"("collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCharge_reversalOfId_key" ON "SupplierCharge"("reversalOfId");

-- CreateIndex
CREATE INDEX "SupplierCharge_invoiceId_idx" ON "SupplierCharge"("invoiceId");

-- CreateIndex
CREATE INDEX "SupplierCharge_reversalOfId_idx" ON "SupplierCharge"("reversalOfId");

-- AddForeignKey
ALTER TABLE "SupplierCharge" ADD CONSTRAINT "SupplierCharge_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "BookingCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCharge" ADD CONSTRAINT "SupplierCharge_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCharge" ADD CONSTRAINT "SupplierCharge_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "SupplierCharge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
