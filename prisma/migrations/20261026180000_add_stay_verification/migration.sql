-- CreateTable
CREATE TABLE "StayVerificationProfile" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "documentationDeadline" TIMESTAMP(3),
    "requirements" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayVerificationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StayVerificationDocument" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "propertyId" TEXT,
    "type" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL DEFAULT 'SUPPLIER',
    "ownerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "url" TEXT,
    "fileName" TEXT,
    "expiryDate" TIMESTAMP(3),
    "reviewNote" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayVerificationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StayVerificationProfile_supplierId_key" ON "StayVerificationProfile"("supplierId");

-- CreateIndex
CREATE INDEX "StayVerificationDocument_supplierId_status_idx" ON "StayVerificationDocument"("supplierId", "status");

-- CreateIndex
CREATE INDEX "StayVerificationDocument_propertyId_idx" ON "StayVerificationDocument"("propertyId");

-- AddForeignKey
ALTER TABLE "StayVerificationProfile" ADD CONSTRAINT "StayVerificationProfile_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayVerificationDocument" ADD CONSTRAINT "StayVerificationDocument_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayVerificationDocument" ADD CONSTRAINT "StayVerificationDocument_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "StayProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
