-- ── Card on file for reserve-now-pay-later bookings ─────────────────────────
-- A reserve-now-pay-later booking holds an uncharged card so the pay-later
-- sweep can collect before the activity. Until now the only stored reference
-- was the Stripe PaymentIntent id, so every email, admin view and support
-- question about "which card is on file?" needed a live Stripe call.
--
-- Capture brand + last4 at checkout from the PaymentMethod (never the PAN —
-- Stripe only ever exposes brand/last4/exp_* to us). Additive and nullable:
-- pay-now bookings and every pre-existing row stay NULL until
-- scripts/backfill-payment-method-labels.js fills them.

ALTER TABLE "Booking" ADD COLUMN "paymentMethodBrand" TEXT;
ALTER TABLE "Booking" ADD COLUMN "paymentMethodLast4" TEXT;
