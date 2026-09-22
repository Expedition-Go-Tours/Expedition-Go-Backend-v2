/**
 * Single source of truth mapping a NotificationType to the settings category
 * used by both a user's notificationPreferences and a notification recipient's
 * per-category preferences.
 *
 * Categories mirror the supplier settings UI:
 *   bookings | reviews | payments | systemAlerts
 *
 * Unknown/new types fall back to systemAlerts so a new enum value can never
 * silently escape preference filtering.
 */

const CATEGORY_BY_TYPE = {
  // Bookings & operational changes
  BOOKING_CONFIRMED: 'bookings',
  BOOKING_CANCELLED: 'bookings',
  BOOKING_STATUS_UPDATED: 'bookings',
  BOOKING_MODIFIED: 'bookings',
  BOOKING_AWAITING_CONFIRMATION: 'bookings',
  BOOKING_PAYMENT_FAILED: 'bookings',
  PICKUP_UPDATED: 'bookings',
  NEW_MESSAGE: 'bookings',
  DISPUTE_OPENED: 'bookings',
  DISPUTE_RESOLVED: 'bookings',

  // Reviews
  REVIEW_RECEIVED: 'reviews',
  REVIEW_REQUEST: 'reviews',

  // Payments & payouts
  PAYMENT_RECEIVED: 'payments',
  PAYMENT_FAILED: 'payments',
  PAYMENT_COMPLETED: 'payments',
  PAYMENT_ACTION_REQUIRED: 'payments',
  PAYOUT_PROCESSED: 'payments',
  PAYOUT_APPROVED: 'payments',
  PAYOUT_COMPLETED: 'payments',
  PAYOUT_REQUEST_SUBMITTED: 'payments',
  PAYOUT_REQUEST_APPROVED: 'payments',
  PAYOUT_REQUEST_REJECTED: 'payments',
  REFUND_ISSUED: 'payments',
  REFUND_CLAIM: 'payments',

  // System / account / moderation
  SYSTEM_ALERT: 'systemAlerts',
  TOUR_SUBMITTED: 'systemAlerts',
  TOUR_APPROVED: 'systemAlerts',
  TOUR_FLAGGED: 'systemAlerts',
  SUPPLIER_APPROVED: 'systemAlerts',
  SUPPLIER_REJECTED: 'systemAlerts',
  DOCUMENT_REJECTED: 'systemAlerts',
  DOCUMENT_EXPIRY_REMINDER: 'systemAlerts',
  DOCUMENT_EXPIRED: 'systemAlerts',
  TEAM_INVITE_ACCEPTED: 'systemAlerts',
};

function categoryForType(type) {
  return CATEGORY_BY_TYPE[type] || 'systemAlerts';
}

module.exports = { CATEGORY_BY_TYPE, categoryForType };
