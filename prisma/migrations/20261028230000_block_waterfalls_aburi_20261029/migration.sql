-- One-off operational block requested for:
--   From Accra : Waterfalls, Aburi Gardens & Cocoa Farm Tour
--   Travio Ghana listing tour id: cmt8hizsj00bk646ppg06lw18
--   Date: 2026-10-29
--
-- Guarded with EXISTS so environments that do not contain this tour are
-- unaffected. Re-running (or an existing override) updates the row instead of
-- failing. Unblocking later from the supplier availability page removes the
-- override as usual.
INSERT INTO "TourDateOverride" ("id", "tourId", "date", "status", "notes")
SELECT
  'manual-block-20261029-cmt8hizsj00bk646ppg06lw18',
  'cmt8hizsj00bk646ppg06lw18',
  DATE '2026-10-29',
  'BLOCKED'::"OverrideStatus",
  'Manual block requested via support'
WHERE EXISTS (
  SELECT 1 FROM "Tour" WHERE "id" = 'cmt8hizsj00bk646ppg06lw18'
)
ON CONFLICT ("tourId", "date")
DO UPDATE SET
  "status" = 'BLOCKED'::"OverrideStatus",
  "notes" = COALESCE("TourDateOverride"."notes", 'Manual block requested via support');
