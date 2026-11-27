-- Notification types emitted by the owner dashboard.
--
-- The reply, photo and team services already enqueue these values, but the
-- enums did not declare them, so Prisma rejected every create and the
-- surrounding .catch() only logged a warning. These are additive enum values;
-- no existing rows or columns change.
--
-- NotificationType
--   RESTAURANT_REVIEW_RESPONSE_UPDATE  a moderator decided on an owner reply
--   RESTAURANT_TEAM_INVITE             an account was invited to manage a venue
--   RESTAURANT_TEAM_ROLE_CHANGED       a venue member's role changed
--   RESTAURANT_OWNERSHIP_TRANSFERRED   ownership moved to this account
--
-- AdminNotificationType
--   RESTAURANT_PHOTOS_NEED_MODERATION  owner photos await approval
--   RESTAURANT_REVIEW_RESPONSE_PENDING an owner reply awaits approval
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_REVIEW_RESPONSE_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_TEAM_INVITE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_TEAM_ROLE_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_OWNERSHIP_TRANSFERRED';
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_PHOTOS_NEED_MODERATION';
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_REVIEW_RESPONSE_PENDING';
