-- AlterTable: pay-later bookings that need the customer to complete payment
-- manually (3DS / card update / repeated declines) are flagged so the sweep
-- stops auto-confirming them. Cleared when the booking settles.

ALTER TABLE "Booking" ADD COLUMN "requiresPaymentActionAt" TIMESTAMP(3);
