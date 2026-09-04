-- Store the storefront origin a booking was made on so transactional emails
-- ("View booking", "Manage booking", "Download voucher", ...) and Stripe
-- redirect URLs point back at the platform the customer actually used, instead
-- of one global brand domain. Additive only — existing rows keep NULL and fall
-- back to CLIENT_URL when building links.
ALTER TABLE "Booking" ADD COLUMN "clientOrigin" TEXT;
