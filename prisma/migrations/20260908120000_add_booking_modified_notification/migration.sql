-- Customer self-service "modify booking" applies (party size / date / time).
-- Suppliers and admins need an in-app notification when a confirmed booking is
-- modified (with the changed fields), so a dedicated value exists instead of
-- reusing the status-transition type.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BOOKING_MODIFIED';
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'BOOKING_MODIFIED';
