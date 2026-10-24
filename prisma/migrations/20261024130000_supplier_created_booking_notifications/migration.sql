-- Supplier-created bookings dispatch an in-app notification to the supplier.
-- Without this enum value the notification worker's insert fails validation,
-- so the job retries and dies silently: no bell entry and no WebSocket push.
--
-- Additive only: an enum value is appended, existing rows are untouched.
-- IF NOT EXISTS makes the migration safe to re-run.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BOOKING_CREATED_BY_SUPPLIER';
