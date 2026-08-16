-- Store the customer-selected pickup snapshot (geoshape area / pickup
-- location, address, time) on bookings for tours that offer pickup.

ALTER TABLE "Booking" ADD COLUMN "pickup" JSONB;