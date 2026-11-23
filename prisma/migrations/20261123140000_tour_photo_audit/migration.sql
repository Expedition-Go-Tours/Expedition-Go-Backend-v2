-- Photo quality audit results, written by scripts/audit-tour-photos.js.
--
-- The measurement calls Cloudinary per asset, so it runs as a batch job. The
-- supplier dashboard reads this column instead of measuring on every load.
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "photoIssueCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "photoAuditedAt" TIMESTAMP(3);
