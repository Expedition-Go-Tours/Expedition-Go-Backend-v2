-- The cycle is up: the supplier has 24 hours to request a payout.
-- In-app notification (this enum value) plus an email listing every booking
-- that is ready to withdraw, its amount, and the deadline.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PAYOUT_REQUEST_WINDOW_OPEN';
