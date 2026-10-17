-- ── GA4 Measurement Protocol attribution on the booking ────────────────────
-- The storefront reports purchases server-side (via the GA4 Measurement
-- Protocol) from the settlement hook, so the backend needs the visitor's GA4
-- client_id — the only identifier the Measurement Protocol accepts. It is read
-- from the first-party `_ga` cookie at checkout and carried through the
-- checkout draft payload onto the Booking.
--
-- Consent Mode cannot be signalled through the Measurement Protocol, so the
-- visitor's analytics choice is stored alongside the id and re-checked before
-- any event is sent. Both columns are additive and nullable: every
-- pre-existing booking stays NULL and is therefore never reported.

ALTER TABLE "Booking" ADD COLUMN "gaClientId" TEXT;
ALTER TABLE "Booking" ADD COLUMN "analyticsConsent" BOOLEAN;
