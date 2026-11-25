-- A restaurant's own menu link plus the meal services it offers.
-- These are presentation facts supplied by the business, not review data.
ALTER TABLE "restaurant_venues"
  ADD COLUMN "menuUrl" TEXT,
  ADD COLUMN "mealTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
