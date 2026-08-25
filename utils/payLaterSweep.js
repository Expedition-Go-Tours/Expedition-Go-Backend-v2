/**
 * Pay-Later Sweep — collects deferred payment for reserve-now-pay-later bookings.
 *
 * A reserve-now-pay-later booking is created PENDING with paymentStatus PENDING
 * and an unattached (unconfirmed) Stripe PaymentIntent: the card is validated at
 * checkout but never charged. This sweep runs on a schedule (see server.js) and,
 * as the activity date approaches, confirms the PaymentIntent to charge the card.
 *
 * Outcomes per booking:
 *  - charge succeeds      → settle the booking (idempotent handlePaymentSucceeded);
 *                           paymentStatus becomes SUCCEEDED, paidAt is set
 *  - already succeeded    → settle the booking (webhook was lost/raced)
 *  - requires_action (3DS) → cannot auto-charge; notify the customer to complete
 *  - declined / canceled  → cancel the reservation, release capacity
 *  - no PI on file        → cancel with a clear reason (should never happen)
 *
 * Idempotency: settle + cancellation updates are guarded by the booking's
 * paymentStatus/status, so re-runs and racing webhooks never double-settle or
 * double-charge (Stripe PaymentIntents cannot be confirmed twice).
 */

const { getStripe, handlePaymentSucceeded } = require('./stripeHelpers');
const { enqueueNotification, enqueueEvent, enqueueEmail } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
const { logActivity } = require('./auditLogger');

const SWEEP_LIMIT = 200;
const DEFAULT_CHARGE_BEFORE_HOURS = 24;
const MAX_CHARGE_RETRIES = 3;

async function settleBooking(booking, intent) {
  try {
    await handlePaymentSucceeded(intent);
  } catch (err) {
    console.error('[PayLater] Settlement failed for', booking.id, err.message);
    return false;
  }

  // Reset retry counter on successful charge
  const prisma = require('./prismaClient');
  await prisma.booking.update({
    where: { id: booking.id },
    data: { chargeRetries: 0, nextRetryAt: null },
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

async function notifyCustomerToCompletePayment(booking) {
  enqueueEmail({
    type: 'payment-unsuccessful',
    bookingId: booking.id,
    data: {
      amount: booking.grossAmount,
      deadline: booking.travelDate,
    },
  }).catch((err) => console.error('[PayLater] Payment action email failed:', err.message));

  enqueueNotification({
    userId: booking.customerId,
    type: 'PAYMENT_ACTION_REQUIRED',
    title: 'Payment Action Required',
    message: `Complete your payment for "${booking.tour?.title || 'your tour'}" to keep your spot.`,
    data: { bookingId: booking.id },
  }).catch(() => {});
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
    message: `We could not charge your card for "${booking.tour?.title || 'your tour'}" (${reason}). Update your payment details or your booking may be cancelled.`,
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
}

async function cancelBooking(booking, reason) {
  const prisma = require('./prismaClient');

  // Check retry count before cancelling — only cancel after MAX_CHARGE_RETRIES
  if ((booking.chargeRetries || 0) < MAX_CHARGE_RETRIES) {
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

    return false; // not cancelled yet
  }

  // Max retries exceeded — cancel the booking
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

  logActivity({
    userId: booking.customerId,
    action: 'booking.pay_later_cancelled',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { reason, source: 'system' },
  }).catch(() => {});
}

async function chargePayLaterBookings() {
  const prisma = require('./prismaClient');
  const chargeBeforeHours =
    parseFloat(process.env.PAY_LATER_CHARGE_BEFORE_HOURS || String(DEFAULT_CHARGE_BEFORE_HOURS)) ||
    DEFAULT_CHARGE_BEFORE_HOURS;

  const now = new Date();
  const windowEnd = new Date(now.getTime() + chargeBeforeHours * 60 * 60 * 1000);

  // Due: pay-later, unpaid, still reserved (PENDING or CONFIRMED), activity
  // date within the charge window (includes overdue bookings so they are
  // collected rather than lost). CONFIRMED is kept for legacy rows created
  // before pay-later bookings became PENDING. Skip bookings waiting for retry.
  const due = await prisma.booking.findMany({
    where: {
      paymentTiming: 'later',
      paymentStatus: 'PENDING',
      status: { in: ['CONFIRMED', 'PENDING'] },
      paidAt: null,
      travelDate: { lte: windowEnd },
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

  if (due.length === 0) return { checked: 0, charged: 0, settled: 0, needsAction: 0, failed: 0, cancelled: 0, retried: 0 };

  let charged = 0;
  let settled = 0;
  let needsAction = 0;
  let failed = 0;
  let cancelled = 0;
  let retried = 0;

  for (const booking of due) {
    if (!booking.stripePaymentIntentId) {
      const result = await cancelBooking(booking, 'No payment method available to charge');
      if (result === false) retried += 1;
      else cancelled += 1;
      continue;
    }

    let intent;
    try {
      intent = await getStripe().paymentIntents.retrieve(booking.stripePaymentIntentId);
    } catch (err) {
      console.error('[PayLater] Could not retrieve PI', booking.stripePaymentIntentId, err.message);
      failed += 1;
      continue;
    }

    switch (intent.status) {
      case 'succeeded':
        if (await settleBooking(booking, intent)) settled += 1;
        else failed += 1;
        break;

      case 'canceled': {
        const result = await cancelBooking(booking, 'Payment could not be collected');
        if (result === false) retried += 1;
        else cancelled += 1;
        break;
      }

      case 'requires_action':
        await notifyCustomerToCompletePayment(booking);
        needsAction += 1;
        break;

      case 'processing':
        // In flight — the webhook will settle it; retry next sweep if it never lands.
        break;

      case 'requires_payment_method':
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
          const result = await cancelBooking(booking, err.message);
          if (result === false) retried += 1;
          else cancelled += 1;
          break;
        }

        if (confirmed.status === 'succeeded') {
          if (await settleBooking(booking, confirmed)) charged += 1;
          else failed += 1;
        } else if (confirmed.status === 'requires_action') {
          await notifyCustomerToCompletePayment(booking);
          needsAction += 1;
        } else if (confirmed.status === 'canceled') {
          const result = await cancelBooking(booking, 'Payment could not be collected');
          if (result === false) retried += 1;
          else cancelled += 1;
        } else {
          // processing / requires_payment_method — retry on the next sweep.
        }
        break;
      }
    }
  }

  const summary = { checked: due.length, charged, settled, needsAction, failed, cancelled, retried };
  console.log(
    `[PayLater] Sweep: ${due.length} due → ${charged} charged, ${settled} already settled, ${needsAction} need action, ${failed} failed, ${cancelled} cancelled, ${retried} retried`
  );
  return summary;
}

module.exports = { chargePayLaterBookings };