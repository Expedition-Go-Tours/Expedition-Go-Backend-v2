-- Special-offer end dates were stored at 00:00:00Z — midnight at the START of
-- the chosen day — so an offer picked to end 30/09/2026 died at 00:00 on
-- 30/09: the nightly `expire-special-offers` job (`endDate <= now`) switched it
-- off, `computeStatus` reported it expired, and suppliers saw "Expired" on a
-- day the picker told them was included.
--
-- End dates are calendar days, so move every stored value to the LAST
-- millisecond of that same day, making the chosen day inclusive.
--
-- The `endTime = 00:00:00` guard keeps this idempotent: rows already moved to
-- 23:59:59.999 no longer match and cannot be shifted a second time.
--
-- startDate is deliberately untouched — start-of-day is already correct.

UPDATE "SpecialOffer"
SET "endDate" = "endDate" + INTERVAL '1 day' - INTERVAL '1 millisecond'
WHERE "endDate" IS NOT NULL
  AND "endDate"::time = TIME '00:00:00';
