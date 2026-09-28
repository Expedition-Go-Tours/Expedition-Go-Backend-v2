-- 30-day documentation window reminders: the daily sweep notifies live
-- suppliers at T-7 / T-3 / final day that their remaining documents are due.
-- Reminders are in-app notifications (this enum value) plus email.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DOCUMENTATION_WINDOW_REMINDER';