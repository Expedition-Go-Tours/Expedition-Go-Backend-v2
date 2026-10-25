/**
 * Reconcile charges that did not settle a booking.
 *
 * A webhook can arrive for money that no longer maps to a payable booking:
 *   - the booking was cancelled/completed/refunded (terminal)
 *   - a second PaymentIntent succeeded after the booking was already paid
 *   - a pay-later charge landed after the activity started
 *   - the amount/currency does not match the booking
 *
 * The webhook deliberately refuses to resurrect a terminal booking. This
 * service is the money-side follow-up: refund genuine duplicates/terminal/late
 * charges, keep an auditable row, and alert operations. It never changes a
 * booking to CONFIRMED or SUCCEEDED.
 */

const prisma = require('./prismaClient');
const { getStripe, createRefund } = require('./stripeHelpers');
const { activityStartExactUtc, parseBlob } = require('./availabilityCore');
const { notifyAdmin } = require('./adminNotificationService');
const { notifyDiscord } = require('./discordNotifier');
const { logActivity } = require('./auditLogger');
const logger = require('./logger');

const TERMINAL_STATUSES = ['CANCELLED', 'COMPLETED', 'NO_SHOW', 'REFUNDED'];
const REFUNDABLE_REASONS = new Set([
  'BOOKING_TERMINAL',
  'DUPLICATE_CHARGE',
  'PAYMENT_TOO_LATE',
  'AMOUNT_MISMATCH',
]);

function activityStartFor(booking) {
  const tickets = parseBlob(booking?.tour?.bookingAndTickets) || {};
  return activityStartExactUtc(tickets, booking?.travelDate, booking?.selectedTime);
}

function bookingCandidatesWhere(paymentIntent, bookingIds) {
  const OR = [];
  if (bookingIds.length) OR.push({ id: { in: bookingIds } });
  OR.push({ stripePaymentIntentId: paymentIntent.id });
  return { OR };
}

function refundReasonFor(booking, paymentIntent, now) {
  if (!booking) return 'UNMATCHED_PAYMENT';
  // Money already returned is never refunded twice, even for a terminal row.
  if (
    booking.paymentStatus === 'REFUNDED'
    || booking.refundStatus === 'REFUNDED'
    || booking.refundedAt
  ) return null;
  if (booking.status === 'REFUNDED') return null;

  if (booking.paymentStatus === 'SUCCEEDED') {
    // Same PaymentIntent means a duplicate webhook, not a duplicate charge.
    // A completed or no-show booking was legitimately served: never auto-refund
    // it just because a success event arrived again. A cancelled booking that
    // is still marked paid does need its cancellation refund completed.
    if (booking.stripePaymentIntentId === paymentIntent.id) {
      return booking.status === 'CANCELLED' ? 'BOOKING_TERMINAL' : null;
    }
    return 'DUPLICATE_CHARGE';
  }

  if (TERMINAL_STATUSES.includes(booking.status)) return 'BOOKING_TERMINAL';

  if (booking.paymentTiming === 'later') {
    const start = activityStartFor(booking);
    if (start && now.getTime() >= start.getTime()) return 'PAYMENT_TOO_LATE';
  }

  if (Number.isFinite(Number(paymentIntent.amount))) {
    const charged = Number(paymentIntent.amount) / 100;
    if (Math.abs(charged - Number(booking.grossAmount)) > 0.009) return 'AMOUNT_MISMATCH';
  }
  if (paymentIntent.currency && String(paymentIntent.currency).toUpperCase() !== String(booking.currency || '').toUpperCase()) {
    return 'AMOUNT_MISMATCH';
  }

  return null;
}

async function alertRefund(reconciliation, booking, paymentIntent, action = 'created') {
  const label = booking?.bookingNumber || reconciliation.stripePaymentIntentId;
  const reason = reconciliation.reason;
  await notifyAdmin({
    type: 'REFUND_NEEDS_ATTENTION',
    title: action === 'failed' ? 'Automatic refund failed' : 'Late or duplicate charge refund',
    message: `Booking #${label}: ${reason.replace(/_/g, ' ').toLowerCase()}. Refund status: ${reconciliation.status}.`,
    data: {
      bookingId: booking?.id || null,
      paymentIntentId: paymentIntent.id,
      reconciliationId: reconciliation.id,
      reason,
      status: reconciliation.status,
    },
  }).catch(() => {});

  await notifyDiscord(
    'incidents',
    'Late or duplicate charge reconciliation',
    {
      title: action === 'failed' ? 'Automatic Refund Failed' : 'Automatic Refund Created',
      color: action === 'failed' ? 0xff4444 : 0xffaa00,
      fields: [
        { name: 'Booking #', value: String(label), inline: true },
        { name: 'Reason', value: reason, inline: true },
        { name: 'Status', value: reconciliation.status, inline: true },
        { name: 'PaymentIntent', value: paymentIntent.id, inline: false },
      ],
      cooldownKey: `reconcile-refund:${reconciliation.id}:${action}`,
    },
  ).catch(() => {});
}

async function updateAttemptRefund(paymentIntentId, status, refundId = null) {
  if (!paymentIntentId) return;
  await prisma.bookingPaymentAttempt.updateMany({
    where: { stripePaymentIntentId: paymentIntentId },
    data: {
      refundStatus: status,
      ...(refundId ? { stripeRefundId: refundId } : {}),
      ...(status === 'REFUNDED' ? { refundedAt: new Date() } : {}),
    },
  }).catch(() => {});
}

async function refundReconciliation(reconciliation, booking, paymentIntent) {
  let row = reconciliation;
  const previousStatus = reconciliation.status;
  try {
    const refund = await createRefund(paymentIntent.id, null, {
      metadata: {
        reason: reconciliation.reason,
        bookingId: booking?.id || '',
        reconciliationId: reconciliation.id,
      },
      idempotencyKey: `reconciliation_refund_${reconciliation.stripePaymentIntentId}`,
    });
    const status = refund?.status === 'succeeded'
      ? 'REFUNDED'
      : refund?.status === 'failed' || refund?.status === 'canceled'
        ? 'REFUND_FAILED'
        : 'REFUND_PENDING';
    row = await prisma.bookingPaymentReconciliation.update({
      where: { id: reconciliation.id },
      data: {
        status,
        stripeRefundId: refund?.id || reconciliation.stripeRefundId || null,
        refundedAt: status === 'REFUNDED' ? new Date() : reconciliation.refundedAt,
        failureCode: status === 'REFUND_FAILED' ? 'REFUND_PROVIDER_FAILED' : null,
        errorMessage: null,
      },
    });
    await updateAttemptRefund(paymentIntent.id, status, refund?.id);
    if (status !== previousStatus && status !== 'REFUND_PENDING') {
      await alertRefund(row, booking, paymentIntent, status === 'REFUND_FAILED' ? 'failed' : 'created');
    }
  } catch (err) {
    logger.error(`[Reconciliation] Refund failed for ${paymentIntent.id}: ${err.message}`);
    row = await prisma.bookingPaymentReconciliation.update({
      where: { id: reconciliation.id },
      data: {
        status: 'REFUND_FAILED',
        failureCode: 'REFUND_PROVIDER_ERROR',
        errorMessage: String(err.message || err).slice(0, 500),
        retryCount: { increment: 1 },
      },
    }).catch(() => reconciliation);
    await updateAttemptRefund(paymentIntent.id, 'REFUND_FAILED');
    await alertRefund(row, booking, paymentIntent, 'failed');
  }

  await logActivity({
    userId: null,
    action: `payment.reconciliation_${row.status.toLowerCase()}`,
    resource: 'Booking',
    resourceId: booking?.id || null,
    metadata: {
      paymentIntentId: paymentIntent.id,
      reason: row.reason,
      refundId: row.stripeRefundId || null,
      source: 'webhook',
    },
  }).catch(() => {});

  return row;
}

/**
 * Called after a Stripe success event that claimed no booking. Retrieves the
 * authoritative PaymentIntent (never trusts a partial event body for money) and
 * refunds only when the persisted booking state proves the charge is not a
 * valid settlement.
 */
async function reconcileUnclaimedPayment({ paymentIntentId, bookingIds = [], source = 'webhook' }) {
  if (!paymentIntentId) return { action: 'none' };
  let intent;
  try {
    intent = await getStripe().paymentIntents.retrieve(paymentIntentId);
  } catch (err) {
    logger.error(`[Reconciliation] Could not retrieve PaymentIntent ${paymentIntentId}: ${err.message}`);
    return { action: 'provider_error' };
  }
  if (!intent || intent.status !== 'succeeded') {
    return { action: 'not_succeeded' };
  }

  const candidates = await prisma.booking.findMany({
    where: bookingCandidatesWhere(intent, bookingIds),
    include: {
      tour: { select: { id: true, title: true, bookingAndTickets: true } },
    },
    take: 10,
  });

  if (candidates.length === 0) {
    // No booking row at all. Do not guess and do not refund automatically; an
    // operator must match the charge first. Alerting is handled by the
    // unmatched-payment audit below.
    await logActivity({
      userId: null,
      action: 'payment.reconciliation_unmatched',
      resource: 'PaymentIntent',
      resourceId: intent.id,
      metadata: { amount: intent.amount, currency: intent.currency, source },
    }).catch(() => {});
    await notifyAdmin({
      type: 'REFUND_NEEDS_ATTENTION',
      title: 'Unmatched Stripe payment',
      message: `A successful PaymentIntent (${intent.id}) does not match any booking. Manual review required.`,
      data: { paymentIntentId: intent.id, amount: intent.amount, currency: intent.currency },
    }).catch(() => {});
    return { action: 'unmatched' };
  }

  const now = new Date();
  let refunded = 0;
  let ignored = 0;

  for (const booking of candidates) {
    const reason = refundReasonFor(booking, intent, now);
    if (!reason) {
      ignored += 1;
      continue;
    }
    if (!REFUNDABLE_REASONS.has(reason)) {
      ignored += 1;
      continue;
    }

    let row;
    try {
      row = await prisma.bookingPaymentReconciliation.create({
        data: {
          bookingId: booking.id,
          stripePaymentIntentId: intent.id,
          stripeCheckoutSessionId: intent.metadata?.checkoutSessionId || null,
          amount: intent.amount != null ? Number(intent.amount) / 100 : null,
          currency: String(intent.currency || booking.currency || 'USD').toUpperCase(),
          reason,
          status: 'REFUND_PENDING',
        },
      });
    } catch (err) {
      if (err?.code !== 'P2002') throw err;
      row = await prisma.bookingPaymentReconciliation.findUnique({
        where: { stripePaymentIntentId: intent.id },
      });
      if (!row || row.status === 'REFUNDED') {
        ignored += 1;
        continue;
      }
    }

    await refundReconciliation(row, booking, intent);
    refunded += 1;
  }

  return { action: refunded > 0 ? 'refunded' : 'ignored', refunded, ignored };
}

/**
 * Retry/confirm refunds that were left pending by a provider delay or a
 * transient failure. Safe to run on every pay-later sweep.
 */
async function reconcilePendingRefunds({ limit = 50 } = {}) {
  const rows = await prisma.bookingPaymentReconciliation.findMany({
    where: {
      OR: [
        { status: 'REFUND_PENDING' },
        { status: 'REFUND_FAILED', retryCount: { lt: 3 } },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    include: { booking: { select: { id: true, bookingNumber: true } } },
  });

  let confirmed = 0;
  let retried = 0;

  for (const row of rows) {
    if (!row.stripeRefundId) {
      const intent = await getStripe().paymentIntents.retrieve(row.stripePaymentIntentId).catch(() => null);
      if (intent?.status === 'succeeded') {
        await refundReconciliation(row, row.booking, intent);
        retried += 1;
      }
      continue;
    }
    try {
      const refund = await getStripe().refunds.retrieve(row.stripeRefundId);
      const status = refund?.status === 'succeeded'
        ? 'REFUNDED'
        : refund?.status === 'failed' || refund?.status === 'canceled'
          ? 'REFUND_FAILED'
          : 'REFUND_PENDING';
      if (status !== row.status) {
        const updated = await prisma.bookingPaymentReconciliation.update({
          where: { id: row.id },
          data: {
            status,
            refundedAt: status === 'REFUNDED' ? new Date() : row.refundedAt,
            failureCode: status === 'REFUND_FAILED' ? 'REFUND_PROVIDER_FAILED' : null,
          },
        });
        await updateAttemptRefund(row.stripePaymentIntentId, status, row.stripeRefundId);
        if (status === 'REFUNDED') {
          confirmed += 1;
          await alertRefund(updated, row.booking, { id: row.stripePaymentIntentId }, 'created');
        }
        if (status === 'REFUND_FAILED') await alertRefund(updated, row.booking, { id: row.stripePaymentIntentId }, 'failed');
      }
    } catch (err) {
      logger.warn(`[Reconciliation] Could not refresh refund ${row.stripeRefundId}: ${err.message}`);
    }
  }

  return { checked: rows.length, confirmed, retried };
}

module.exports = {
  reconcileUnclaimedPayment,
  reconcilePendingRefunds,
  refundReasonFor,
};
