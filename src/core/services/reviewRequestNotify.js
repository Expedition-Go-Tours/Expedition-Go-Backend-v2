const { enqueueNotification, enqueueEmail } = require('./queue');

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

/**
 * Hands the supplier the customer's review link once the activity is complete.
 *
 * Sent at the same moment the customer's own review nudge is queued (a paid
 * booking becomes COMPLETED), so the operator can forward the guest's
 * `/review/<slug>` URL to WhatsApp, SMS or email. The link is the storefront
 * review page for the exact tour the guest booked; the sender personalises it
 * with the lead traveller's name, the real tour photo and the booking reference.
 *
 * @param {object} booking - Booking row (must have id, paymentStatus, tour/tourId)
 * @param {object} [tour]  - Tour row (id, slug, title, supplier) when available.
 */
function enqueueSupplierReviewInvite(booking, tour) {
  if (!booking || !booking.id) return;
  // Only paid bookings can be reviewed, so only those get a forwardable link.
  if (booking.paymentStatus !== 'SUCCEEDED') return;
  // Without a tour there is no review URL to forward; the auto-completion sweep
  // selects it, but guard so a caller with a bare booking row can't send a
  // link-less email.
  const t = tour || booking.tour || null;
  if (!t) return;

  enqueueEmail({ type: 'supplier-review-invite', bookingId: booking.id }).catch((err) => {
    console.error('[ReviewInvite] Failed to queue supplier review invite:', booking.id, err.message);
  });
}

/**
 * Single entry point for the completion moment: nudges the customer to write a
 * review AND hands the supplier the link to forward. Callers flip a paid
 * booking to COMPLETED; both emails go out once.
 */
function notifyBookingCompleted(booking, tour) {
  enqueueReviewRequest(booking, tour);
  enqueueSupplierReviewInvite(booking, tour);
}

module.exports = { enqueueReviewRequest, enqueueSupplierReviewInvite, notifyBookingCompleted };
