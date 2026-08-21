-- CreateTable
CREATE TABLE "CheckoutDraft" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "selectedDate" DATE NOT NULL,
    "selectedTime" TEXT,
    "seats" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "pricing" JSONB NOT NULL,
    "commissionRate" DECIMAL(5,4) NOT NULL,
    "commissionAmount" DECIMAL(10,2) NOT NULL,
    "supplierPayout" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stripeSessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'HOLDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutDraft_stripeSessionId_key" ON "CheckoutDraft"("stripeSessionId");

-- CreateIndex
CREATE INDEX "CheckoutDraft_tourId_selectedDate_status_idx" ON "CheckoutDraft"("tourId", "selectedDate", "status");

-- CreateIndex
CREATE INDEX "CheckoutDraft_status_expiresAt_idx" ON "CheckoutDraft"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CheckoutDraft_customerId_idx" ON "CheckoutDraft"("customerId");

-- AddForeignKey
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
