-- Minimum party size for a specific date. Null inherits the product/option
-- minimum, so existing overrides and listings keep their current behaviour.
ALTER TABLE "TourDateOverride" ADD COLUMN "minParticipants" INTEGER;
