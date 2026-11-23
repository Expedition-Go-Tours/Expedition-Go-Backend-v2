-- Per-photo audit detail, written by scripts/audit-tour-photos.js.
--
-- The count alone can tell a supplier "154 photos need work" but not which one,
-- and the product page has to mark the exact tile. Stored as
-- [{ url, width, height, problem }] so it can be matched against the gallery
-- without a second Cloudinary call.
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "photoIssues" JSONB;
