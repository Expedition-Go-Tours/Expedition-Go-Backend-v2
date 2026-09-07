/**
 * Pay-Later Sweep — collects deferred payment for reserve-now-pay-later bookings.
 *
 * A reserve-now-pay-later booking is created PENDING with paymentStatus PENDING
 * and an unattached (unconfirmed) Stripe PaymentIntent: the card is validated at
 * checkout but never charged. This sweep runs on a schedule (every 30 min, see
 * server.js/queue.js) and, as the activity date approaches, confirms the
 * PaymentIntent to charge the card.
 *
 * Guarantees (edge-case hardening):
 *  - NEVER auto-charges after the activity date has begun — once `travelDate`
 *    (start of the activity day) has passed we stop attempting and the seat is
 *    released by the finalize pass instead of silently charging after the event.
 *  - 3DS (`requires_action`) and card problems (`requires_payment_method`,
 *    expired / declined cards) are escalated to the CUSTOMER as a manual
 *    "complete payment / update card" action (`requiresPaymentActionAt` is set
 *    and the booking leaves the auto-charge set). No silent auto-cancel while
 *    the activity is still ahead — the customer is emailed a deep link and the
 *    booking only finalizes if it is still unpaid after the activity day.
 *  - Transient declines are retried with exponential backoff (60/120/240 min),
 *    then escalated to manual payment rather than silently cancelled.
 *  - Settlement and cancellation are idempotent (guarded on paymentStatus/status),
 *    so re-runs and racing webhooks never double-settle or double-charge.
 *
 * Outcomes per booking:
 *  - charge succeeds      → settle the booking (idempotent handlePaymentSucceeded);
 *                           paymentStatus becomes SUCCEEDED, paidAt is set
 *  - already succeeded    → settle the booking (webhook was lost/raced)
 *  - requires_action (3DS) → flag for manual customer action (no auto-charge)
 *  - requires_payment_method / declined → retry w/ backoff, then flag for manual action
 *  - no PI on file        → flag for manual action (customer completes payment)
 *  - still unpaid after the activity day → cancel reservation, release capacity
 */

const { getStripe, handlePaymentSucceeded } = require('./stripeHelpers');
const { enqueueNotification, enqueueEvent, enqueueEmail } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
const { notifyDiscord } = require('./discordNotifier');
const { logActivity } = require('./auditLogger');

const SWEEP_LIMIT = 200;
const DEFAULT_CHARGE_BEFORE_HOURS = 24;
const MAX_CHARGE_RETRIES = 3;
// After the activity day ends (travelDate + 24h) we allow a short grace for an
// in-flight webhook to settle before finalizing an unpaid reservation.
const FINALIZE_AFTER_GRACE_HOURS = 6;

async function settleBooking(booking, intent) {
  try {
    await handlePaymentSucceeded(intent);
  } catch (err) {
    console.error('[PayLater] Settlement failed for', booking.id, err.message);
    return false;
  }

  // Reset retry counter + manual-action flag on successful charge
  const prisma = require('./prismaClient');
  await prisma.booking.update({
    where: { id: booking.id },
    data: { chargeRetries: 0, nextRetryAt: null, requiresPaymentActionAt: null },
  }).catch(() => {});

  // handlePaymentSucceeded already enqueues the pay-later-charged emails
  // (customer + supplier), so no separate payment-successful email here.

  enqueueNotification({
    userId: booking.customerId,
    type: 'PAYMENT_COMPLETED',
    title: 'Payment Completed',
    message: `Your card was charged for "${booking.tour?.title || 'your tour'}". Payment received — see you there!`,
    data: { bookingId: booking.id },
  }).catch(() => {});

  const amount = parseFloat(booking.grossAmount).toFixed(2);
  notifyAdmin({
    type: 'PAYMENT_COLLECTED',
    title: 'Pay-later payment collected',
    message: `Booking #${booking.bookingNumber} — $${amount} for "${booking.tour?.title || 'a tour'}" charged successfully`,
    data: { bookingId: booking.id, source: 'pay-later-sweep' },
  }).catch(() => {});

  enqueueEvent({
    name: 'booking.payment_collected',
    userId: booking.customerId,
    resource: 'Booking',
    resourceId: booking.id,
    properties: { tourId: booking.tourId, paymentTiming: 'later', source: 'system' },
  }).catch(() => {});

  return true;
}

/**
 * Escalate a pay-later booking to manual customer payment (3DS required, card
 * invalid/expired, or retries exhausted). Marks the row and emails the customer
 * once so the sweep never loops auto-confirm attempts on an un-actionable card.
 */
async function escalateToManual(booking, reason) {
  const prisma = require('./prismaClient');
  // updateMany guards: only escalates when still unpaid + not already flagged,
  // so re-runs never double-email.
  const updated = await prisma.booking.updateMany({
    where: { id: booking.id, paymentTiming: 'later', paymentStatus: 'PENDING', paidAt: null, requiresPaymentActionAt: null },
    data: { requiresPaymentActionAt: new Date() },
  });
  if (updated.count === 0) return false;

  console.log(`[PayLater] Booking ${booking.bookingNumber} needs manual payment action: ${reason}`);

  // Deep link points at the booking management page, which surfaces the
  // "Complete payment / update card" action on the storefront.
  enqueueEmail({
    type: 'payment-unsuccessful',
    bookingId: booking.id,
    data: { amount: booking.grossAmount, deadline: booking.travelDate, failureReason: reason },
  }).catch((err) => console.error('[PayLater] Payment action email failed:', err.message));

  enqueueNotification({
    userId: booking.customerId,
    type: 'PAYMENT_ACTION_REQUIRED',
    title: 'Complete your payment',
    message: `We could not automatically charge your card for "${booking.tour?.title || 'your tour'}" (${reason}). Complete your payment to keep your spot.`,
    data: { bookingId: booking.id },
  }).catch(() => {});

  notifyAdmin({
    type: 'PAYMENT_COLLECTION_FAILED',
    title: 'Pay-later needs manual payment',
    message: `Booking #${booking.bookingNumber} — $${parseFloat(booking.grossAmount).toFixed(2)} for "${booking.tour?.title || 'a tour'}". Auto-charge not possible: ${reason}.`,
    data: { bookingId: booking.id, source: 'pay-later-sweep' },
  }).catch(() => {});

  notifyDiscord(
    'incidents',
    `Pay-later booking ${booking.bookingNumber} needs manual payment`,
    {
      title: 'Manual Payment Required',
      color: 0xffaa00,
      fields: [
        { name: 'Booking #', value: booking.bookingNumber, inline: true },
        { name: 'Amount', value: `$${parseFloat(booking.grossAmount).toFixed(2)}`, inline: true },
        { name: 'Tour', value: booking.tour?.title || '—', inline: true },
        { name: 'Reason', value: (reason || 'Unknown').slice(0, 1024), inline: false },
      ],
      cooldownKey: `pay-later-manual:${booking.id}`,
    }
  ).catch(() => {});

  return true;
}

async function notifyPaymentFailed(booking, reason) {
  enqueueEmail({
    type: 'payment-unsuccessful',
    bookingId: booking.id,
    data: {
      amount: booking.grossAmount,
      deadline: booking.travelDate,
      failureReason: reason,
    },
  }).catch((err) => console.error('[PayLater] Payment failed email failed:', err.message));

  enqueueNotification({
    userId: booking.customerId,
    type: 'PAYMENT_FAILED',
    title: 'Payment Declined',
    message: `We could not charge your card for "${booking.tour?.title || 'your tour'}" (${reason}). Update your payment details to keep your booking.`,
    data: { bookingId: booking.id },
  }).catch(() => {});

  enqueueNotification({
    userId: booking.tour?.supplierId,
    type: 'BOOKING_PAYMENT_FAILED',
    title: 'Booking Payment Failed',
    message: `Payment failed for booking for "${booking.tour?.title || 'the tour'}". The reservation may be cancelled.`,
    data: { bookingId: booking.id },
  }).catch(() => {});

  notifyAdmin({
    type: 'PAYMENT_COLLECTION_FAILED',
    title: 'Pay-later payment collection failed',
    message: `Booking #${booking.bookingNumber} — $${parseFloat(booking.grossAmount).toFixed(2)} for "${booking.tour?.title || 'a tour'}". Card charge failed: ${reason}`,
    data: { bookingId: booking.id },
  }).catch(() => {});

  notifyDiscord(
    'incidents',
    `Pay-later charge failed for booking ${booking.bookingNumber}`,
    {
      title: 'Payment Collection Failed',
      color: 0xff4444,
      fields: [
        { name: 'Booking #', value: booking.bookingNumber, inline: true },
        { name: 'Amount', value: `$${parseFloat(booking.grossAmount).toFixed(2)}`, inline: true },
        { name: 'Tour', value: booking.tour?.title || '—', inline: true },
        { name: 'Reason', value: (reason || 'Unknown').slice(0, 1024), inline: false },
      ],
      cooldownKey: `pay-later-fail:${booking.id}`,
    }
  ).catch(() => {});
}

/**
 * Schedule an automatic retry with exponential backoff. Returns true when a
 * retry was scheduled, false when retries are exhausted (caller escalates).
 */
async function scheduleRetry(booking, reason) {
  const prisma = require('./prismaClient');
  if ((booking.chargeRetries || 0) >= MAX_CHARGE_RETRIES) return false;

  const retryCount = (booking.chargeRetries || 0) + 1;
  const backoffMinutes = Math.pow(2, retryCount) * 30; // 60min, 120min, 240min
  const nextRetry = new Date(Date.now() + backoffMinutes * 60 * 1000);

  await prisma.booking.update({
    where: { id: booking.id },
    data: { chargeRetries: retryCount, nextRetryAt: nextRetry },
  });

  console.log(`[PayLater] Booking ${booking.bookingNumber} charge failed — retry ${retryCount}/${MAX_CHARGE_RETRIES} scheduled at ${nextRetry.toISOString()}`);

  notifyAdmin({
    type: 'PAYMENT_COLLECTION_FAILED',
    title: `Pay-later charge failed (retry ${retryCount}/${MAX_CHARGE_RETRIES})`,
    message: `Booking #${booking.bookingNumber} — $${parseFloat(booking.grossAmount).toFixed(2)} charge failed: ${reason}. Next retry at ${nextRetry.toLocaleString()}.`,
    data: { bookingId: booking.id, retryCount, nextRetry: nextRetry.toISOString() },
  }).catch(() => {});

  notifyDiscord(
    'incidents',
    `Pay-later charge failed — retry ${retryCount}/${MAX_CHARGE_RETRIES}`,
    {
      title: 'Payment Retry Scheduled',
      color: 0xffaa00,
      fields: [
        { name: 'Booking #', value: booking.bookingNumber, inline: true },
        { name: 'Amount', value: `$${parseFloat(booking.grossAmount).toFixed(2)}`, inline: true },
        { name: 'Tour', value: booking.tour?.title || '—', inline: true },
        { name: 'Next Retry', value: nextRetry.toLocaleString(), inline: true },
        { name: 'Reason', value: (reason || 'Unknown').slice(0, 1024), inline: false },
      ],
      cooldownKey: `pay-later-retry:${booking.id}:${retryCount}`,
    }
  ).catch(() => {});

  return true;
}

/**
 * Finalize an unpaid pay-later booking whose activity day has fully passed
 * (travelDate + grace). The reservation is cancelled and capacity released —
 * this is the ONLY path that auto-cancels a pay-later booking, and it never
 * runs before the activity day is over.
 */
async function finalizeBooking(booking, reason) {
  const prisma = require('./prismaClient');
  const updated = await prisma.booking.updateMany({
    where: { id: booking.id, paymentTiming: 'later', paymentStatus: 'PENDING', paidAt: null },
    data: {
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
      cancellationReason: reason,
      cancelledAt: new Date(),
    },
  });
  if (updated.count === 0) return;

  enqueueEmail({
    type: 'customer-cancelled-no-refund',
    bookingId: booking.id,
    data: {
      cancelledAt: new Date().toISOString(),
      cancellationFee: booking.grossAmount,
      refundAmount: 0,
    },
  }).catch((err) => console.error('[PayLater] Cancellation email failed:', err.message));

  enqueueEmail({
    type: 'supplier-customer-cancelled-free',
    bookingId: booking.id,
    data: { cancelledAt: new Date().toISOString() },
  }).catch((err) => console.error('[PayLater] Supplier cancellation email failed:', err.message));

  enqueueNotification({
    userId: booking.customerId,
    type: 'BOOKING_CANCELLED',
    title: 'Booking Cancelled',
    message: `Your booking for "${booking.tour?.title || 'the tour'}" was cancelled because payment could not be collected. You can rebook anytime.`,
    data: { bookingId: booking.id },
  }).catch(() => {});

  enqueueNotification({
    userId: booking.tour?.supplierId,
    type: 'BOOKING_CANCELLED',
    title: 'Booking Cancelled',
    message: `A reserve-now-pay-later booking for "${booking.tour?.title || 'the tour'}" was cancelled (payment not collected).`,
    data: { bookingId: booking.id },
  }).catch(() => {});

  enqueueEvent({
    name: 'booking.expired',
    userId: booking.customerId,
    resource: 'Booking',
    resourceId: booking.id,
    properties: { tourId: booking.tourId, reason, source: 'system' },
  }).catch(() => {});

  notifyDiscord(
    'incidents',
    `Pay-later booking ${booking.bookingNumber} cancelled — payment not collected`,
    {
      title: 'Pay-Later Booking Cancelled',
      color: 0xff4444,
      fields: [
        { name: 'Booking #', value: booking.bookingNumber, inline: true },
        { name: 'Amount', value: `$${parseFloat(booking.grossAmount).toFixed(2)}`, inline: true },
        { name: 'Tour', value: booking.tour?.title || '—', inline: true },
        { name: 'Reason', value: (reason || 'Payment not collected').slice(0, 1024), inline: false },
      ],
      cooldownKey: `pay-later-cancel:${booking.id}`,
    }
  ).catch(() => {});

  logActivity({
    userId: booking.customerId,
    action: 'booking.pay_later_cancelled',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { reason, source: 'system' },
  }).catch(() => {});
}

/**
 * Charge a single due booking. Assumes it has a stripePaymentIntentId.
 * Returns a bucket label for the sweep summary.
 */
async function chargeBooking(booking) {
  const prisma = require('./prismaClient');
  const now = new Date();

  // Charge-after-event guard (defense-in-depth; the sweep query already only
  // selects travelDate > now). If we somehow end up here past the activity day
  // end, never confirm — finalize instead.
  const activityDayEnd = new Date(
    new Date(booking.travelDate).getTime() + 24 * 60 * 60 * 1000
  );
  if (now >= activityDayEnd) {
    await finalizeBooking(booking, 'Payment not collected before the activity date');
    return 'cancelled';
  }

  // Never auto-charge a booking we have already asked the customer to settle.
  if (booking.requiresPaymentActionAt) return 'waiting';

  let intent;
  try {
    intent = await getStripe().paymentIntents.retrieve(booking.stripePaymentIntentId);
  } catch (err) {
    console.error('[PayLater] Could not retrieve PI', booking.stripePaymentIntentId, err.message);
    return 'failed';
  }

  switch (intent.status) {
    case 'succeeded':
      if (await settleBooking(booking, intent)) return 'settled';
      return 'failed';

    case 'requires_action':
      // 3DS — cannot complete server-side. Escalate to the customer once.
      await escalateToManual(booking, 'Your bank requires extra verification (3D Secure) to complete the charge');
      return 'manual';

    case 'requires_payment_method': {
      // Card invalid / expired / declined. Retry transient declines with
      // backoff; after MAX retries escalate to manual payment.
      const retried = await scheduleRetry(booking, 'Card could not be charged (invalid, expired or declined)');
      if (retried) {
        await notifyPaymentFailed(booking, 'Card could not be charged — we will retry automatically');
        return 'retried';
      }
      await escalateToManual(booking, 'We could not charge your card after several attempts');
      return 'manual';
    }

    case 'processing':
      // In flight — the webhook will settle it; retry next sweep if it never lands.
      return 'processing';

    case 'canceled': {
      const retried = await scheduleRetry(booking, 'Payment could not be collected (intent canceled)');
      if (retried) return 'retried';
      await escalateToManual(booking, 'Payment could not be collected');
      return 'manual';
    }

    case 'requires_confirmation':
    default: {
      let confirmed;
      try {
        // Accounts with dashboard-enabled payment methods require a
        // return_url on confirm. The captured card never redirects, so this
        // URL is only consumed by Stripe's validation.
        confirmed = await getStripe().paymentIntents.confirm(booking.stripePaymentIntentId, {
          return_url: `${process.env.CLIENT_URL}/booking/complete`,
        });
      } catch (err) {
        console.error('[PayLater] Confirm failed', booking.stripePaymentIntentId, err.message);
        await notifyPaymentFailed(booking, err.message);
        const retried = await scheduleRetry(booking, err.message);
        if (retried) return 'retried';
        await escalateToManual(booking, err.message);
        return 'manual';
      }

      if (confirmed.status === 'succeeded') {
        if (await settleBooking(booking, confirmed)) return 'charged';
        return 'failed';
      }
      if (confirmed.status === 'requires_action') {
        await escalateToManual(booking, 'Your bank requires extra verification (3D Secure) to complete the charge');
        return 'manual';
      }
      if (confirmed.status === 'requires_payment_method') {
        // Confirm returned control to the payment method (declined).
        await notifyPaymentFailed(booking, 'Your card was declined');
        const retried = await scheduleRetry(booking, 'Card declined');
        if (retried) return 'retried';
        await escalateToManual(booking, 'Your card was declined after several attempts');
        return 'manual';
      }
      if (confirmed.status === 'canceled') {
        const retried = await scheduleRetry(booking, 'Payment could not be collected');
        if (retried) return 'retried';
        await escalateToManual(booking, 'Payment could not be collected');
        return 'manual';
      }
      // processing / requires_payment_method — retry on the next sweep.
      return 'processing';
    }
  }
}

async function chargePayLaterBookings() {
  const prisma = require('./prismaClient');
  const chargeBeforeHours =
    parseFloat(process.env.PAY_LATER_CHARGE_BEFORE_HOURS || String(DEFAULT_CHARGE_BEFORE_HOURS)) ||
    DEFAULT_CHARGE_BEFORE_HOURS;

  const now = new Date();
  const windowEnd = new Date(now.getTime() + chargeBeforeHours * 60 * 60 * 1000);

  // Due: pay-later, unpaid, still reserved (PENDING or CONFIRMED), activity
  // date ahead and within the charge window. CONFIRMED is kept for legacy rows
  // created before pay-later bookings became PENDING. Skip bookings waiting for
  // retry and bookings already escalated to manual customer payment.
  const due = await prisma.booking.findMany({
    where: {
      paymentTiming: 'later',
      paymentStatus: 'PENDING',
      status: { in: ['CONFIRMED', 'PENDING'] },
      paidAt: null,
      travelDate: { lte: windowEnd, gt: now },
      requiresPaymentActionAt: null,
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: now } },
      ],
    },
    include: {
      tour: { select: { id: true, title: true, supplierId: true } },
      customer: { select: { id: true, email: true } },
    },
    orderBy: { travelDate: 'asc' },
    take: SWEEP_LIMIT,
  });

  // Finalize: unpaid pay-later reservations whose activity day has fully ended
  // (plus a grace for a settling webhook). This releases held capacity and is
  // the ONLY auto-cancel path for pay-later bookings.
  const finalizeCutoff = new Date(now.getTime() - (24 + FINALIZE_AFTER_GRACE_HOURS) * 60 * 60 * 1000);
  const finalize = await prisma.booking.findMany({
    where: {
      paymentTiming: 'later',
      paymentStatus: 'PENDING',
      status: { in: ['CONFIRMED', 'PENDING'] },
      paidAt: null,
      travelDate: { lt: finalizeCutoff },
    },
    include: {
      tour: { select: { id: true, title: true, supplierId: true } },
      customer: { select: { id: true, email: true } },
    },
    orderBy: { travelDate: 'asc' },
    take: SWEEP_LIMIT,
  });

  let charged = 0;
  let settled = 0;
  let manual = 0;
  let processing = 0;
  let failed = 0;
  let cancelled = 0;
  let retried = 0;
  let waiting = 0;

  for (const booking of finalize) {
    await finalizeBooking(booking, 'Payment not collected before the activity date');
    cancelled += 1;
  }

  for (const booking of due) {
    if (!booking.stripePaymentIntentId) {
      await escalateToManual(booking, 'No payment method available to charge — please complete payment');
      manual += 1;
      continue;
    }

    const bucket = await chargeBooking(booking);
    if (bucket === 'charged') charged += 1;
    else if (bucket === 'settled') settled += 1;
    else if (bucket === 'manual') manual += 1;
    else if (bucket === 'processing') processing += 1;
    else if (bucket === 'failed') failed += 1;
    else if (bucket === 'cancelled') cancelled += 1;
    else if (bucket === 'retried') retried += 1;
    else waiting += 1; // 'waiting'
  }

  const summary = { checked: due.length, charged, settled, manual, processing, failed, cancelled, retried, waiting };
  console.log(
    `[PayLater] Sweep: ${due.length} due (${finalize.length} to finalize) → ${charged} charged, ${settled} settled, ${manual} manual action, ${processing} processing, ${failed} failed, ${cancelled} cancelled, ${retried} retried, ${waiting} waiting`
  );
  return summary;
}

module.exports = { chargePayLaterBookings };
