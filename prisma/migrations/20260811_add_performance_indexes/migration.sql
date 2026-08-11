-- Performance indexes for Neon PostgreSQL
-- These indexes target the most common query patterns identified in profiling

-- Partial index for active tours (most queries filter on status = 'ACTIVE')
-- Smaller than a full index, faster to scan
CREATE INDEX IF NOT EXISTS "Tour_active_supplier_createdAt_idx"
  ON "Tour"("supplierId", "createdAt" DESC)
  WHERE status = 'ACTIVE';

-- Faster booking lookups by customer (My Bookings page)
CREATE INDEX IF NOT EXISTS "Booking_customerId_createdAt_idx"
  ON "Booking"("customerId", "createdAt" DESC);

-- Faster supplier booking dashboard
CREATE INDEX IF NOT EXISTS "Tour_supplierId_status_createdAt_idx"
  ON "Tour"("supplierId", "status", "createdAt" DESC);

-- Faster event analytics queries (time-series charts)
CREATE INDEX IF NOT EXISTS "Event_name_createdAt_idx"
  ON "Event"("name", "createdAt" DESC);

-- Faster notification unread count (badge in UI)
CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx"
  ON "Notification"("userId", "read") WHERE "read" = false;

-- Covering index for tour listing (avoids heap lookups for common SELECT columns)
CREATE INDEX IF NOT EXISTS "Tour_list_covering_idx"
  ON "Tour"("status", "createdAt" DESC)
  INCLUDE ("title", "slug", "coverPhoto", "category", "city", "country", "averageRating", "reviewCount", "viewCount");

-- Faster availability calendar lookups (date override by tour + date)
-- Already exists as @@unique + @@index in schema, but adding explicit composite
CREATE INDEX IF NOT EXISTS "TourDateOverride_tourId_date_idx"
  ON "TourDateOverride"("tourId", "date");

-- Faster chat message retrieval (conversation history)
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx"
  ON "Message"("conversationId", "createdAt" DESC);

-- Faster audit log queries (admin activity feed)
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx"
  ON "AuditLog"("createdAt" DESC);
