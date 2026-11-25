-- Trip-advisor-style "Who did you go with?" metadata for restaurant reviews.
ALTER TABLE "restaurant_venue_reviews"
  ADD COLUMN "companions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
