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
const { enqueueNotification, enqueueEvent, enqueueEmail } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
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
  // once `travelDate` is strictly before today (start of day), the activity is
  // in the past.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const updated = await prisma.booking.updateMany({
    where: {
      status: 'CONFIRMED',
      travelDate: { lt: startOfToday },
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

/**
 * Auto-cancel PENDING bookings whose activity date has passed.
 *
 * When a PENDING booking's travel date is more than 48 hours in the past and
 * the supplier never confirmed, the booking is auto-cancelled. This prevents
 * bookings from stuck in PENDING forever.
 *
 * - Paid bookings: refund via evaluateCancellationPolicy + createRefund
 * - Reserve-now-pay-later: just cancel (no charge was made)
 * - Sends email notification to customer explaining the auto-cancellation
 *
 * Runs every 30 minutes from the CLEANUP worker.
 */
const STALE_PENDING_GRACE_HOURS = 48;

async function cancelStalePendingAfterTravelDate() {
  const prisma = require('./prismaClient');
  const { evaluateCancellationPolicy } = require('./bookingHelpers');

  const graceCutoff = new Date();
  graceCutoff.setHours(graceCutoff.getHours() - STALE_PENDING_GRACE_HOURS);

  const stale = await prisma.booking.findMany({
    where: {
      status: 'PENDING',
      travelDate: { lt: graceCutoff },
    },
    include: {
      tour: { select: { title: true, supplierId: true } },
    },
    orderBy: { travelDate: 'asc' },
    take: SWEEP_LIMIT,
  });

  if (stale.length === 0) return { stale: 0, cancelled: 0, refunded: 0 };

  let cancelled = 0;
  let refunded = 0;

  for (const booking of stale) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const updateData = {
          status: 'CANCELLED',
          cancellationReason: 'Activity date passed without supplier confirmation',
          cancelledAt: new Date(),
          payoutStatus: 'CANCELLED',
          updatedAt: new Date(),
        };

        // Process refund if payment was successful
        let refundAmount = 0;
        if (booking.paymentStatus === 'SUCCEEDED') {
          const cancellationCheck = evaluateCancellationPolicy(booking, booking.tour);
          refundAmount = cancellationCheck.refundAmount;

          if (refundAmount > 0) {
            try {
              const refundAmountCents = Math.round(refundAmount * 100);
              await createRefund(booking.stripePaymentIntentId, refundAmountCents);
              updateData.paymentStatus = 'REFUNDED';
              updateData.refundAmount = refundAmount;
              updateData.refundedAt = new Date();
            } catch (err) {
              console.error('[BookingCleanup] Refund failed for stale PENDING', booking.id, err.message);
            }
          }
        }

        // Cancel any pending payout rows
        await tx.payout.updateMany({
          where: { bookingId: booking.id, status: { in: ['PENDING', 'APPROVED'] } },
          data: { status: 'CANCELLED', updatedAt: new Date() },
        });

        const updated = await tx.booking.update({
          where: { id: booking.id },
          data: updateData,
        });

        // Release capacity
        try {
          const { releaseCapacityForBooking } = require('./availabilityCore');
          await releaseCapacityForBooking(booking);
        } catch (err) {
          console.error('[BookingCleanup] Capacity release failed for', booking.id, err.message);
        }

        return { updated, refundAmount };
      });

      // Send email notification to customer
      enqueueEmail({
        type: 'booking-auto-cancelled',
        bookingId: booking.id,
        reason: 'Activity date passed without supplier confirmation',
      }).catch((err) => console.error('[BookingCleanup] Auto-cancel email failed:', err.message));

      // Notify supplier
      enqueueNotification({
        userId: booking.tour?.supplierId,
        type: 'BOOKING_CANCELLED',
        title: 'Booking Auto-Cancelled',
        message: `Booking #${booking.bookingNumber} for "${booking.tour?.title}" was auto-cancelled because the activity date passed without confirmation.`,
        data: { bookingId: booking.id },
      }).catch((err) => console.error('[BookingCleanup] Supplier notification failed:', err.message));

      enqueueEvent({
        name: 'booking.auto-cancelled',
        userId: booking.customerId,
        resource: 'Booking',
        resourceId: booking.id,
        properties: { tourId: booking.tourId, reason: 'stale-pending', source: 'system' },
      }).catch(() => {});

      logActivity({
        userId: booking.customerId,
        action: 'booking.auto-cancelled',
        resource: 'Booking',
        resourceId: booking.id,
        metadata: { reason: 'Activity date passed without supplier confirmation', source: 'system' },
      }).catch(() => {});

      cancelled += 1;
      if (result.refundAmount > 0) refunded += 1;
    } catch (err) {
      console.error('[BookingCleanup] Auto-cancel failed for', booking.id, err.message);
    }
  }

  console.log(`[BookingCleanup] Stale PENDING sweep: ${stale.length} found → ${cancelled} cancelled, ${refunded} refunded`);
  return { stale: stale.length, cancelled, refunded };
}

/**
 * Expire stale CheckoutDraft holds.
 *
 * Holds past their `expiresAt` (plus a grace window) are unrecoverable if
 * the Stripe session is still open — the customer left. For each stale hold
 * we ask Stripe for the authoritative session state:
 *  - session paid (webhook lost) → materialize into a Booking
 *  - session open / expired / incomplete → release the hold (EXPIRED)
 *  - Stripe unreachable → skip; retried on the next sweep
 *
 * Runs every 5 minutes from the CLEANUP worker (same cadence as stale
 * PENDING bookings).
 */
const HOLD_GRACE_MINUTES = 10;

async function expireCheckoutHolds() {
  const prisma = require('./prismaClient');
  const { materializeHold, releaseHold } = require('./checkoutHold');

  const graceCutoff = new Date(Date.now() - (DEFAULT_GRACE_MINUTES + HOLD_GRACE_MINUTES) * 60 * 1000);

  const stale = await prisma.checkoutDraft.findMany({
    where: {
      status: 'HOLDING',
      expiresAt: { lt: graceCutoff },
    },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_LIMIT,
  });

  if (stale.length === 0) return { stale: 0, materialized: 0, released: 0 };

  let materialized = 0;
  let released = 0;

  for (const draft of stale) {
    if (!draft.stripeSessionId) {
      // No session ever created — release directly.
      await releaseHold(draft.id, 'expired').catch(() => {});
      released += 1;
      continue;
    }

    // Custom Payment Element flow: the draft's id is an unconfirmed PaymentIntent.
    if (draft.stripeSessionId.startsWith('pi_')) {
      let pi;
      try {
        pi = await getStripe().paymentIntents.retrieve(draft.stripeSessionId);
      } catch (err) {
        console.error('[BookingCleanup] Could not retrieve PaymentIntent', draft.stripeSessionId, err.message);
        continue; // retry next sweep
      }

      if (pi.status === 'succeeded') {
        // Webhook never landed — materialize now (same settlement path).
        try {
          const result = await materializeHold(draft.id, { id: null, amount_total: pi.amount }, pi.id);
          if (result.ok) {
            materialized += 1;
            const booking = result.booking;
            if (booking) {
              enqueueEmail({ type: 'booking-confirmed', bookingId: booking.id })
                .catch((err) => console.error('[BookingCleanup] Customer email failed:', err.message));
              enqueueEmail({ type: 'supplier-new-booking', bookingId: booking.id })
                .catch((err) => console.error('[BookingCleanup] Supplier email failed:', err.message));
              notifyAdmin({
                type: 'BOOKING_CONFIRMED',
                title: 'Expedition Booking Confirmed',
                message: `Booking #${booking.bookingNumber} — $${parseFloat(booking.grossAmount).toFixed(2)} for "${booking.tour?.title}" has been confirmed`,
                data: { bookingId: booking.id, tourTitle: booking.tour?.title, amount: booking.grossAmount, source: 'expedition' },
              }).catch(() => {});
            }
          } else if (result.oversold) {
            const { createRefund: refund } = require('./stripeHelpers');
            await refund(pi.id).catch((err) => {
              console.error('[BookingCleanup] Refund failed for oversold hold', draft.id, err.message);
            });
            released += 1;
          }
        } catch (err) {
          console.error('[BookingCleanup] Materialize (PI) failed for', draft.id, err.message);
        }
        continue;
      }

      // Abandoned — cancel the unconfirmed intent and free the seats.
      try { await getStripe().paymentIntents.cancel(draft.stripeSessionId); } catch { /* already canceled */ }
      await releaseHold(draft.id, 'expired').catch(() => {});
      released += 1;
      continue;
    }

    let session;
    try {
      session = await getStripe().checkout.sessions.retrieve(draft.stripeSessionId);
    } catch (err) {
      console.error('[BookingCleanup] Could not retrieve Checkout Session', draft.stripeSessionId, err.message);
      continue; // retry next sweep
    }

    if (['open', 'processing', 'incomplete'].includes(session.status)) {
      // Session still valid / payment in flight — leave the hold alone.
      continue;
    }

    if (session.payment_status === 'paid' && session.payment_intent) {
      // Session completed but its webhook never landed — materialize now.
      try {
        const result = await materializeHold(draft.id, session, session.payment_intent);
        if (result.ok) {
          materialized += 1;
          // Send confirmation emails (webhook path was lost; sweep is the
          // settlement source so we must fire notifications here).
          const booking = result.booking;
          if (booking) {
            enqueueEmail({ type: 'booking-confirmed', bookingId: booking.id })
              .catch((err) => console.error('[BookingCleanup] Customer email failed:', err.message));
            enqueueEmail({ type: 'supplier-new-booking', bookingId: booking.id })
              .catch((err) => console.error('[BookingCleanup] Supplier email failed:', err.message));
            notifyAdmin({
              type: 'BOOKING_CONFIRMED',
              title: 'Expedition Booking Confirmed',
              message: `Booking #${booking.bookingNumber} — $${parseFloat(booking.grossAmount).toFixed(2)} for "${booking.tour?.title}" has been confirmed`,
              data: { bookingId: booking.id, tourTitle: booking.tour?.title, amount: booking.grossAmount, source: 'expedition' },
            }).catch(() => {});
          }
        } else if (result.oversold) {
          // Capacity gone — refund.
          const { createRefund: refund } = require('./stripeHelpers');
          await refund(session.payment_intent).catch((err) => {
            console.error('[BookingCleanup] Refund failed for oversold hold', draft.id, err.message);
          });
          released += 1;
        }
      } catch (err) {
        console.error('[BookingCleanup] Materialize failed for', draft.id, err.message);
      }
      continue;
    }

    // Session completed without payment (shouldn't happen) or expired.
    await releaseHold(draft.id, 'expired').catch(() => {});
    released += 1;
  }

  console.log(`[BookingCleanup] Hold sweep: ${stale.length} stale → ${materialized} materialized, ${released} released`);
  return { stale: stale.length, materialized, released };
}

module.exports = { cancelStalePendingBookings, expireBooking, autoCompleteBookings, cancelStalePendingAfterTravelDate, expireCheckoutHolds };