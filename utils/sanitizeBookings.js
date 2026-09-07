/**
 * Payment-internal identifiers that must never leave the server to
 * supplier / customer clients.
 *
 * These keys are stripped from any booking object before it is returned
 * to a non-admin caller. Admins (refunds, finance) still receive the raw
 * rows from their own dedicated queries.
 */
const STRIP_KEYS = ['stripePaymentIntentId', 'stripeCheckoutSessionId'];

/**
 * @param {object|object[]|null} booking - a Booking row (or list)
 * @returns {object|object[]|null} the same object with payment internals removed
 */
function sanitizeBookingPaymentInternals(booking) {
  if (Array.isArray(booking)) {
    return booking.map((b) => sanitizeBookingPaymentInternals(b));
  }
  if (!booking || typeof booking !== 'object') return booking;
  for (const key of STRIP_KEYS) {
    if (key in booking) delete booking[key];
  }
  return booking;
}

module.exports = { sanitizeBookingPaymentInternals, STRIP_KEYS };
