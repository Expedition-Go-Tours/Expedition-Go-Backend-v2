-- AlterEnum
-- Dedicated pickup-update notification type + the booking status-update type
-- used by booking status-change notifications (both were missing from the enum,
-- so those in-app notifications were silently rejected by Prisma).
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_STATUS_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'PICKUP_UPDATED';
