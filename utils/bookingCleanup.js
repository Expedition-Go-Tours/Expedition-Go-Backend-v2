/**
 * Booking Cleanup — reconciles stale PENDING bookings.
 *
 * Every checkout marks a booking PENDING and only a `payment_intent.succeeded`
 * webhook flips it to CONFIRMED. A booking can get stuck PENDING when:
 *  - the customer abandons a 3DS challenge (PI is requires_action forever),
 *  - the card is declined and the retry UI is never re-submitted
 *    (PI is requires_payment_method / canceled),
 *  - the payment settled but its webhook was lost beyond retry (rare).
 *
 * Reserve-now-pay-later bookings are excluded: they stay PENDING on purpose
 * until payLaterSweep collects the deferred charge near the activity date.
 *
 * Stale PENDING bookings leak capacity (availability sums PENDING bookings)
 * and block re-booking via the checkout dedup guard, so they must be
 * reconciled. For each stale booking we ask Stripe for the authoritative
 * PaymentIntent state and act accordingly:
 *  - succeeded            → settle (same code path as the webhook; idempotent)
 *  - canceled / declined  → cancel the booking, release capacity
 *  - requires_action/...  → abandoned challenge: cancel intent + booking
 *  - unreachable Stripe   → skip; retried on the next sweep
 *
 * Runs every 5 minutes from the system-cleanup queue (see server.js).
 */

const { getStripe, handlePaymentSucceeded, createRefund } = require('./stripeHelpers');
const { enqueueNotification, enqueueEvent } = require('./queue');
const { logActivity } = require('./auditLogger');

const DEFAULT_GRACE_MINUTES = 30;
const SWEEP_LIMIT = 500;

async function expireBooking(booking, reason) {
  const prisma = require('./prismaClient');

  const updated = await prisma.booking.updateMany({
    where: {
      id: booking.id,
      status: 'PENDING',
      paymentStatus: { in: ['PENDING', 'PROCESSING'] },
      paidAt: null,
    },
    data: {
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
      cancellationReason: reason,
      cancelledAt: new Date(),
    },
  });

  if (updated.count === 0) return 0;

  enqueueNotification({
    userId: booking.customerId,
    type: 'BOOKING_CANCELLED',
    title: 'Booking Not Completed',
    message: `Your booking for "${booking.tour?.title || 'the tour'}" was cancelled because payment was not completed. You can rebook anytime.`,
    data: { bookingId: booking.id },
  }).catch((err) => console.error('[BookingCleanup] notification failed:', err?.message));

  enqueueEvent({
    name: 'booking.expired',
    userId: booking.customerId,
    resource: 'Booking',
    resourceId: booking.id,
    properties: { tourId: booking.tourId, reason, source: 'system' },
  }).catch(() => {});

  logActivity({
    userId: booking.customerId,
    action: 'booking.expired',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { reason, source: 'system' },
  }).catch(() => {});

  return updated.count;
}

async function cancelStalePendingBookings() {
  const prisma = require('./prismaClient');
  const graceMinutes = parseInt(process.env.BOOKING_STALE_GRACE_MIN, 10) || DEFAULT_GRACE_MINUTES;
  const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

  const stale = await prisma.booking.findMany({
    where: {
      status: 'PENDING',
      paymentStatus: { in: ['PENDING', 'PROCESSING'] },
      paidAt: null,
      // Reserve-now-pay-later bookings are intentionally PENDING until the
      // deferred charge window (payLaterSweep collects them near the activity
      // date) — they are never "stale" and must not be cancelled here.
      paymentTiming: { not: 'later' },
      createdAt: { lt: cutoff },
    },
    include: { tour: { select: { title: true } } },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_LIMIT,
  });

  if (stale.length === 0) return { stale: 0, confirmed: 0, cancelled: 0 };

  let confirmed = 0;
  let cancelled = 0;

  for (const booking of stale) {
    if (!booking.stripePaymentIntentId) {
      // Pay-now bookings await their hosted Checkout Session before any
      // PaymentIntent exists. Reconcile by session state rather than assuming
      // payment never started: an open/in-flight session keeps the booking,
      // a completed session settles it (webhook lost), anything else cancels.
      if (booking.stripeCheckoutSessionId) {
        let session;
        try {
          session = await getStripe().checkout.sessions.retrieve(booking.stripeCheckoutSessionId);
        } catch (err) {
          console.error('[BookingCleanup] Could not retrieve Checkout Session', booking.stripeCheckoutSessionId, err.message);
          continue;
        }

        if (['open', 'processing', 'incomplete'].includes(session.status)) {
          // Session still valid / payment in flight — leave the booking alone.
          continue;
        }

        if (session.payment_intent) {
          // Session completed but its webhook never landed — settle now
          // (idempotent: rows already CONFIRMED are untouched).
          try {
            const { oversold } = await handlePaymentSucceeded(
              { id: session.payment_intent, metadata: { bookingIds: booking.id } }
            );
            for (const ob of oversold || []) {
              await createRefund(ob.stripePaymentIntentId).catch((err) => {
                console.error('[BookingCleanup] Refund failed for oversold booking', ob.id, err.message);
              });
            }
            confirmed += 1;
          } catch (err) {
            console.error('[BookingCleanup] Manual settlement failed for', booking.id, err.message);
          }
          continue;
        }
      }

      cancelled += await expireBooking(booking, 'Payment was not completed');
      continue;
    }

    let intent;
    try {
      intent = await getStripe().paymentIntents.retrieve(booking.stripePaymentIntentId);
    } catch (err) {
      console.error('[BookingCleanup] Could not retrieve PI', booking.stripePaymentIntentId, err.message);
      continue;
    }

    if (intent.status === 'succeeded') {
      // Payment settled but its webhook never landed — settle the booking now.
      // Idempotent: rows already CONFIRMED are untouched by the updates below.
      try {
        const { oversold } = await handlePaymentSucceeded(intent);
        // Offer capacity was exhausted before settlement: the booking was
        // cancelled inside the transaction, so the customer's money must go
        // back immediately (best-effort — failures are logged for follow-up).
        for (const ob of oversold || []) {
          await createRefund(ob.stripePaymentIntentId).catch((err) => {
            console.error('[BookingCleanup] Refund failed for oversold booking', ob.id, err.message);
          });
        }
        confirmed += 1;
      } catch (err) {
        console.error('[BookingCleanup] Manual settlement failed for', booking.id, err.message);
      }
    } else if (['requires_payment_method', 'canceled'].includes(intent.status)) {
      cancelled += await expireBooking(booking, 'Payment was not completed');
    } else {
      // requires_action / requires_confirmation / processing: the 3DS flow was
      // abandoned beyond the grace window. Cancel the intent so a charge can
      // never land later, then release the booking.
      try {
        await getStripe().paymentIntents.cancel(booking.stripePaymentIntentId);
      } catch (err) {
        console.error('[BookingCleanup] PI cancel failed', booking.stripePaymentIntentId, err.message);
      }
      cancelled += await expireBooking(booking, 'Payment authorization expired');
    }
  }

  console.log(`[BookingCleanup] Sweep: ${stale.length} stale PENDING bookings → ${confirmed} confirmed, ${cancelled} cancelled`);
  return { stale: stale.length, confirmed, cancelled };
}

/**
 * Auto-complete bookings.
 *
 * A CONFIRMED booking whose activity date has already passed is considered
 * completed — the supplier no longer needs to manually mark it COMPLETED. Runs
 * periodically (e.g. every 30 minutes) and is idempotent: only rows still
 * CONFIRMED are flipped, so a completed booking is never touched again.
 */
async function autoCompleteBookings() {
  const prisma = require('./prismaClient');
  const now = new Date();
  // The activity date is stored at midnight UTC in the tour's timezone context;
  // once `selectedDate` is strictly before today (start of day), the activity is
  // in the past.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const updated = await prisma.booking.updateMany({
    where: {
      status: 'CONFIRMED',
      selectedDate: { lt: startOfToday },
    },
    data: {
      status: 'COMPLETED',
      updatedAt: new Date(),
    },
  });

  if (updated.count > 0) {
    console.log(`[BookingCleanup] Auto-completed ${updated.count} past booking(s) → COMPLETED`);
  }
  return { completed: updated.count };
}

module.exports = { cancelStalePendingBookings, expireBooking, autoCompleteBookings };