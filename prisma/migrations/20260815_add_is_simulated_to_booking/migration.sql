-- Mark seeded demo/test bookings so the archived-tour purge can safely
-- remove tours that only ever received simulated bookings.

ALTER TABLE "Booking" ADD COLUMN "isSimulated" BOOLEAN NOT NULL DEFAULT false;