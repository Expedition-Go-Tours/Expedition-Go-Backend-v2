CREATE INDEX IF NOT EXISTS idx_booking_tour_status_created ON "Booking"("tourId", "status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_wishlist_tour_added ON "WishlistItem"("tourId", "addedAt" DESC);
CREATE INDEX IF NOT EXISTS idx_event_name_resource_created ON "Event"("name", "resourceId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_review_tour_status_created ON "Review"("tourId", "status", "createdAt" DESC);
