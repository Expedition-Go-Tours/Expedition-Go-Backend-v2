-- GA4 session attribution for server-side purchases.
--
-- The Measurement Protocol purchase carried a client_id but no session_id, so
-- GA4 opened a session of its own for it. Revenue and transactions were right;
-- the session-scoped "Purchase journey" funnel reported zero purchases because
-- no single session ever ran view_item → begin_checkout → purchase.
--
-- Digits only: the API validates before storing (see ghana/controller.js), so
-- this column is either null or a usable GA4 session id.
ALTER TABLE "Booking" ADD COLUMN "gaSessionId" TEXT;
