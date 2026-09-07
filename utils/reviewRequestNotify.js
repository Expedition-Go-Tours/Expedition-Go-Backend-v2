const { enqueueNotification } = require('./queue');

/**
 * Sends the customer a "your trip is complete — write a review" in-app
 * notification whenever a paid booking becomes COMPLETED (auto sweep or manual
 * supplier transition). One notification per completion; the deep link data is
 * generic enough for every storefront (expedition / ghana / travio) to route to
 * its own review page.
 *
 * @param {object} booking - Booking row (must have id, customerId, source,
 *   paymentStatus, clientOrigin?, tourId?)
 * @param {object} [tour]  - Tour row (id, slug?, title?) when the caller has it;
 *   otherwise booking.tour is used.
 */
function enqueueReviewRequest(booking, tour) {
  if (!booking || !booking.id || !booking.customerId) return;
  // Reviews can only be submitted for paid bookings — don't nudge unpaid
  // reservations that can't be reviewed yet.
  if (booking.paymentStatus !== 'SUCCEEDED') return;

  const t = tour || booking.tour || {};
  const data = {
    bookingId: booking.id,
    tourId: t.id || booking.tourId || null,
    tourSlug: t.slug || null,
    tourTitle: t.title || null,
    source: booking.source || null,
    clientOrigin: booking.clientOrigin || null,
  };

  enqueueNotification({
    userId: booking.customerId,
    type: 'REVIEW_REQUEST',
    title: 'Your trip is complete',
    message: `How was ${t.title ? `"${t.title}"` : 'your trip'}? Share your experience to help other travelers.`,
    data,
  }).catch((err) => {
    console.error('[ReviewRequest] Failed to notify customer:', booking.id, err.message);
  });
}

module.exports = { enqueueReviewRequest };
