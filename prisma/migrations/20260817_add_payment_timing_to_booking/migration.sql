-- Track whether the customer chose to pay now or "Reserve now, pay later"
-- at checkout, so suppliers can see the payment intent on the booking.

ALTER TABLE "Booking" ADD COLUMN "paymentTiming" TEXT NOT NULL DEFAULT 'now';