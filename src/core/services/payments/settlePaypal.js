/**
 * PayPal settlement.
 *
 * The single place where "PayPal says money moved" becomes a Booking. Both the
 * browser return and the webhook call this; materializeHold is idempotent, so
 * whichever arrives second is a no-op. A capture that arrives after the hold is
 * gone is refunded automatically rather than turned into an oversold booking.
 */

const prisma = require('../prismaClient');
const { readCapture, refundCapture } = require('./paypalPayments');
const { fromMinorUnits, toSettlementSession } = require('./normalize');
const { logActivity } = require('../auditLogger');
const { notifyDiscord } = require('../discordNotifier');

async function loadDraft({ draftId, orderId }) {
  if (draftId) {
    const byId = await prisma.checkoutDraft.findUnique({ where: { id: draftId } });
    if (byId) return byId;
  }
  if (orderId) {
    return prisma.checkoutDraft.findUnique({ where: { paypalOrderId: orderId } });
  }
  return null;
}

async function loadBookingForDraft(draft) {
  if (!draft?.bookingId) return null;
  return prisma.booking.findUnique({
    where: { id: draft.bookingId },
    include: {
      tour: { select: { id: true, title: true, slug: true, coverPhoto: true, supplierId: true } },
      customer: { select: { id: true, name: true, email: true } },
    },
  });
}

/**
 * Persist an unclaimed capture so it is visible to finance instead of silently
 * sitting in the PayPal balance. Deliberately NOT auto-refunded: an unmapped
 * payment may be a legitimate manual sale, and refunding someone's money
 * without a human decision is worse than flagging it.
 */
async function recordUnmappedPayment(capture) {
  const amount = fromMinorUnits(capture.amountMinor);

  try {
    await prisma.bookingPaymentReconciliation.upsert({
      where: { paypalCaptureId: capture.captureId },
      create: {
        paymentProvider: 'PAYPAL',
        paypalCaptureId: capture.captureId,
        amount,
        currency: capture.currency,
        reason: 'UNMAPPED_PAYMENT',
        status: 'UNMATCHED',
      },
      update: {},
    });
  } catch (err) {
    console.error('[PayPal] Could not record unmapped capture', capture.captureId, err.message);
  }

  await logActivity({
    action: 'payment.paypal.unmapped',
    resource: 'BookingPaymentReconciliation',
    resourceId: capture.captureId,
    metadata: {
      orderId: capture.orderId,
      captureId: capture.captureId,
      amount,
      currency: capture.currency,
      payerEmail: capture.payerEmail,
      draftId: capture.draftId,
    },
  }).catch(() => {});

  try {
    const { salesUnmappedPayment } = require('../channelEmbeds');
    const message = salesUnmappedPayment({
      provider: 'PayPal',
      amount: capture.amountMinor / 100,
      currency: capture.currency,
      reference: capture.captureId,
      email: capture.payerEmail,
      orderId: capture.orderId,
    });
    notifyDiscord('sales', message.content, message.opts);
  } catch { /* alerting is best-effort */ }
}

async function refundCaptureInFull(draft, capture, reason) {
  const { normalized } = await refundCapture({
    captureId: capture.captureId,
    amountMinor: null,
    currency: capture.currency,
    note: 'Your payment was received after this booking hold ended. A full refund has been issued.',
    invoiceId: draft?.id || capture.draftId || null,
    idempotencyKey: `paypal-auto-refund-${capture.captureId}`,
  });

  const amount = fromMinorUnits(capture.amountMinor);

  await prisma.$transaction(async (tx) => {
    if (draft?.id) {
      await tx.checkoutDraft.updateMany({
        where: { id: draft.id, status: { not: 'PAID' } },
        data: { status: 'REFUNDED' },
      });
    }
    await tx.bookingPaymentReconciliation.upsert({
      where: { paypalCaptureId: capture.captureId },
      create: {
        paymentProvider: 'PAYPAL',
        paypalCaptureId: capture.captureId,
        bookingId: draft?.bookingId || null,
        amount,
        currency: capture.currency,
        reason,
        status: normalized.status === 'SUCCEEDED' ? 'REFUNDED' : 'REFUND_PENDING',
        paypalRefundId: normalized.refundId,
        refundedAt: normalized.status === 'SUCCEEDED' ? new Date() : null,
      },
      update: {
        status: normalized.status === 'SUCCEEDED' ? 'REFUNDED' : 'REFUND_PENDING',
        paypalRefundId: normalized.refundId,
        refundedAt: normalized.status === 'SUCCEEDED' ? new Date() : null,
      },
    });
  });

  await logActivity({
    action: 'payment.paypal.late_capture_refunded',
    resource: 'CheckoutDraft',
    resourceId: draft?.id || capture.draftId || capture.captureId,
    metadata: {
      captureId: capture.captureId,
      orderId: capture.orderId,
      refundId: normalized.refundId,
      reason,
      amount,
      currency: capture.currency,
    },
  }).catch(() => {});

  try {
    const { salesRefundIssued } = require('../channelEmbeds');
    const message = salesRefundIssued({
      amount: capture.amountMinor / 100,
      currency: capture.currency,
      chargeId: capture.captureId,
      bookingNumber: null,
      provider: 'PayPal',
    });
    notifyDiscord('sales', message.content, message.opts);
  } catch { /* best effort */ }

  return normalized;
}

/**
 * Settle one PayPal order.
 *
 * Returns:
 *   { ok: true, booking, alreadySettled }        — money is accounted for
 *   { ok: false, reason: 'processing' }          — wait for the capture to complete
 *   { ok: false, reason: 'unmapped', capture }   — no draft owns this capture
 *   { ok: false, reason: 'refunded', capture }   — arrived too late, refunded
 *   { ok: false, reason: 'not_captured' }        — approved but no capture yet
 */
async function settlePaypalOrder(orderId, { source = 'webhook' } = {}) {
  if (!orderId) throw new Error('settlePaypalOrder requires an order id');

  const { orderNormalized, capture } = await readCapture(orderId);

  if (!capture) {
    return { ok: false, reason: 'not_captured', order: orderNormalized };
  }

  if (capture.status === 'PROCESSING') {
    return { ok: false, reason: 'processing', order: orderNormalized, capture };
  }

  if (capture.status !== 'SUCCEEDED') {
    // Declined capture: free the seats so another customer can book.
    const draft = await loadDraft({ draftId: capture.draftId, orderId });
    if (draft?.status === 'HOLDING') {
      await prisma.checkoutDraft.updateMany({
        where: { id: draft.id, status: 'HOLDING' },
        data: { status: 'EXPIRED' },
      });
    }
    return { ok: false, reason: 'declined', order: orderNormalized, capture };
  }

  const draft = await loadDraft({ draftId: capture.draftId, orderId });

  if (!draft) {
    await recordUnmappedPayment(capture);
    return { ok: false, reason: 'unmapped', order: orderNormalized, capture };
  }

  // A draft created for Stripe must never be settled by a PayPal capture.
  if (draft.paymentProvider !== 'PAYPAL') {
    await recordUnmappedPayment(capture);
    return { ok: false, reason: 'provider_mismatch', order: orderNormalized, capture };
  }

  if (draft.status === 'PAID') {
    return { ok: true, booking: await loadBookingForDraft(draft), alreadySettled: true, capture };
  }

  if (draft.status !== 'HOLDING') {
    const refund = await refundCaptureInFull(draft, capture, 'PAYMENT_TOO_LATE');
    return { ok: false, reason: 'refunded', refund, capture };
  }

  const expectedMinor = Math.round(Number(draft.pricing?.total || 0) * 100);
  const expectedCurrency = String(draft.currency || draft.pricing?.currency || 'USD').toUpperCase();

  if (capture.amountMinor !== expectedMinor || capture.currency !== expectedCurrency) {
    const refund = await refundCaptureInFull(draft, capture, 'AMOUNT_MISMATCH');
    return { ok: false, reason: 'amount_mismatch', refund, capture };
  }

  const { materializeHold } = require('../checkoutHold');
  const result = await materializeHold(
    draft.id,
    toSettlementSession(capture),
    null,
    { provider: 'PAYPAL', captureId: capture.captureId }
  );

  if (result.ok) {
    // Persist the order id if the draft was created before it was known.
    await prisma.checkoutDraft.updateMany({
      where: { id: draft.id, paypalOrderId: null },
      data: { paypalOrderId: orderId },
    }).catch(() => {});

    await logActivity({
      action: 'payment.paypal.settled',
      resource: 'Booking',
      resourceId: result.booking?.id || draft.id,
      metadata: {
        source,
        orderId,
        captureId: capture.captureId,
        amount: fromMinorUnits(capture.amountMinor),
        currency: capture.currency,
        channel: capture.channel,
        payerEmail: capture.payerEmail,
      },
    }).catch(() => {});

    // Reuse the shared settlement notifier so PayPal bookings get exactly the
    // same customer/supplier emails, admin alert and #sales booking embed as a
    // Stripe booking. The booking is re-read with the tour payload because the
    // notifier distinguishes manual-confirmation tours.
    try {
      const { notifyBookingsSettled } = require('../stripeHelpers');
      const fullBooking = await prisma.booking.findUnique({
        where: { id: result.booking.id },
        include: {
          tour: { include: { supplier: { select: { id: true, name: true, email: true } } } },
          customer: { select: { id: true, name: true, email: true } },
        },
      });
      if (fullBooking) {
        notifyBookingsSettled([fullBooking], { paymentIntentId: capture.captureId, source: 'paypal' });
      }
    } catch (err) {
      console.error('[PayPal] Settlement notifications failed:', err.message);
    }

    return { ok: true, booking: result.booking, capture, alreadySettled: false };
  }

  if (result.oversold) {
    const refund = await refundCaptureInFull(draft, capture, 'BOOKING_TERMINAL');
    return { ok: false, reason: 'oversold', refund, capture };
  }

  // already_settled: another worker won the race. Return the booking.
  const refreshed = await prisma.checkoutDraft.findUnique({ where: { id: draft.id } });
  if (refreshed?.status === 'PAID') {
    return { ok: true, booking: await loadBookingForDraft(refreshed), alreadySettled: true, capture };
  }

  return { ok: false, reason: result.reason || 'not_settled', capture };
}

module.exports = {
  settlePaypalOrder,
  recordUnmappedPayment,
  refundCaptureInFull,
};
