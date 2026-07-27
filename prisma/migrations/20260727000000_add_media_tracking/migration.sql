-- Create MediaStatus enum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'ATTACHED', 'ORPHANED');

-- Create Media table
CREATE TABLE "Media" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT,
    "userId" TEXT,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "entity" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Media_pkey" PRIMARY KEY ("id")
);

-- Create unique index on url
CREATE UNIQUE INDEX "Media_url_key" ON "Media"("url");

-- Create indexes
CREATE INDEX "Media_status_idx" ON "Media"("status");
CREATE INDEX "Media_url_idx" ON "Media"("url");
CREATE INDEX "Media_entity_entityId_idx" ON "Media"("entity", "entityId");
CREATE INDEX "Media_createdAt_idx" ON "Media"("createdAt");
