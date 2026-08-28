-- Add CLIP embedding fields to Tour and TourImageAnalysis models

-- Tour: CLIP embeddings for image and text
ALTER TABLE "Tour" ADD COLUMN "clipEmbedding" JSONB;
ALTER TABLE "Tour" ADD COLUMN "clipTextEmbedding" JSONB;

-- TourImageAnalysis: CLIP image embedding per image
ALTER TABLE "TourImageAnalysis" ADD COLUMN "clipEmbedding" JSONB;
ALTER TABLE "TourImageAnalysis" ADD COLUMN "clipModelVersion" TEXT;
ALTER TABLE "TourImageAnalysis" ADD COLUMN "clipProcessedAt" TIMESTAMP(3);
