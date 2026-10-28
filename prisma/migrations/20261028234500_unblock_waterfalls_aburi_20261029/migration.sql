-- Remove the one-off manual block added for:
--   From Accra : Waterfalls, Aburi Gardens & Cocoa Farm Tour
--   Travio Ghana listing tour id: cmt8hizsj00bk646ppg06lw18
--   Date: 2026-10-29
--
-- Targets the exact override row created by
-- 20261028230000_block_waterfalls_aburi_20261029 so any unrelated supplier
-- override for the same date is left untouched.
DELETE FROM "TourDateOverride"
WHERE "id" = 'manual-block-20261029-cmt8hizsj00bk646ppg06lw18'
  AND "tourId" = 'cmt8hizsj00bk646ppg06lw18'
  AND "date" = DATE '2026-10-29';
