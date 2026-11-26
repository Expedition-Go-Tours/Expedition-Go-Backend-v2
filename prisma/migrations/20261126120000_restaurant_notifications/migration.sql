-- Restaurant notification types.
--
-- The restaurant services have always enqueued these, but none of the values
-- existed in the Prisma enums, so every create was rejected and the
-- surrounding .catch() only logged a warning. All six bells were silent:
--
-- AdminNotificationType
--   RESTAURANT_VENUE_CLAIM_PENDING        someone asked to manage a listing
--   RESTAURANT_REVIEW_NEEDS_MODERATION    a new/updated review awaits a moderator
--   RESTAURANT_REVIEW_REPORTED            a diner reported a review
--
-- NotificationType
--   RESTAURANT_CLAIM_UPDATE               the claimant's claim was decided
--   REVIEW_STATUS_UPDATE                  a review was approved/rejected/flagged
--   REVIEW_REMOVED                        a review was removed after a report
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_VENUE_CLAIM_PENDING';
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_REVIEW_NEEDS_MODERATION';
ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_REVIEW_REPORTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RESTAURANT_CLAIM_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_STATUS_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_REMOVED';
