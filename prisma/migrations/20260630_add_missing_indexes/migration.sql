-- DropIndex
DROP INDEX IF EXISTS "User_roles_idx";

-- CreateIndex
CREATE INDEX "Booking_tourId_status_selectedDate_idx" ON "Booking"("tourId", "status", "selectedDate");

-- CreateIndex
CREATE INDEX "Booking_customerId_status_selectedDate_idx" ON "Booking"("customerId", "status", "selectedDate");

-- CreateIndex
CREATE INDEX "Booking_status_selectedDate_idx" ON "Booking"("status", "selectedDate");

-- CreateIndex
CREATE INDEX "Review_tourId_status_rating_idx" ON "Review"("tourId", "status", "rating");

-- CreateIndex
CREATE INDEX "Review_status_createdAt_idx" ON "Review"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Tour_supplierId_status_idx" ON "Tour"("supplierId", "status");

-- CreateIndex
CREATE INDEX "User_roles_idx" ON "User" USING GIN ("roles");
