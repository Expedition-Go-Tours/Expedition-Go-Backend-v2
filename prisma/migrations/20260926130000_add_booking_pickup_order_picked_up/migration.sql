-- Supplier pickup planner: per-day stop ordering + a "picked up" marker.

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "pickupOrder" INTEGER;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "pickedUpAt" TIMESTAMP(3);
