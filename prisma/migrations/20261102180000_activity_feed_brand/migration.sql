-- Activity feed: first-class brand scoping + read-path indexes.
--
-- `Event.source` already means delivery channel (web/mobile/api/webhook), but
-- several producers also stuffed the brand into `properties.source`. That made
-- brand-scoped reads ambiguous and left search events unattributable. `brand`
-- is now a real column on both streams, written from the request context.
--
-- Everything here is additive and nullable, so it is safe to deploy before the
-- code that reads it. Backfill existing rows with
-- scripts/backfill-activity-brand.js (batched; not part of this migration).

ALTER TABLE "Event" ADD COLUMN "brand" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "brand" TEXT;
ALTER TABLE "AuditLogArchive" ADD COLUMN "brand" TEXT;

CREATE INDEX "Event_brand_createdAt_idx" ON "Event"("brand", "createdAt");
CREATE INDEX "AuditLog_brand_createdAt_idx" ON "AuditLog"("brand", "createdAt");
CREATE INDEX "AuditLogArchive_brand_createdAt_idx" ON "AuditLogArchive"("brand", "createdAt");

-- Activity feed read paths. These windows are always "latest N since X", so
-- the timestamp indexes are what keep the card from scanning the tables.
CREATE INDEX "Booking_createdAt_idx" ON "Booking"("createdAt");
CREATE INDEX "Booking_paidAt_idx" ON "Booking"("paidAt");
CREATE INDEX "Booking_cancelledAt_idx" ON "Booking"("cancelledAt");
CREATE INDEX "Booking_refundedAt_idx" ON "Booking"("refundedAt");
CREATE INDEX "WishlistItem_addedAt_idx" ON "WishlistItem"("addedAt");
CREATE INDEX "SupplierRefundRequest_createdAt_idx" ON "SupplierRefundRequest"("createdAt");
