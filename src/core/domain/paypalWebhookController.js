/**
 * PayPal webhook controller.
 *
 * PayPal does not sign with a shared HMAC secret: authenticity is established by
 * calling PayPal's verification API with the transmission headers and the exact
 * event body. Only then is the event stored and processed.
 *
 * Every delivery is acknowledged with 200 once it has been persisted, even when
 * processing fails — failures are retried through the same BullMQ webhook queue
 * the Stripe path uses, so a transient database error cannot make PayPal retry
 * into a half-applied state.
 */

const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const prisma = require('../services/prismaClient');
const { logActivity } = require('../services/auditLogger');
const { notifyDiscord } = require('../services/discordNotifier');
const { enqueuePaypalWebhookRetry } = require('../services/queue');
const { verifyWebhookSignature } = require('../services/payments/paypalPayments');
const { settlePaypalOrder, recordUnmappedPayment } = require('../services/payments/settlePaypal');
const { toMinorUnits } = require('../services/payments/normalize');

function parseRawBody(body) {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return null;
}

async function orderIdForCapture(capture) {
  const related = capture?.supplemental_data?.related_ids || {};
  if (related.order_id) return related.order_id;

  // Fallback: the order id is not always included, but our draft id is stamped
  // on the capture as custom_id, and the draft remembers its order.
  const draftId = capture?.custom_id;
  if (draftId) {
    const draft = await prisma.checkoutDraft.findUnique({
      where: { id: draftId },
      select: { paypalOrderId: true },
    });
    if (draft?.paypalOrderId) return draft.paypalOrderId;
  }
  return null;
}

function captureAsNormalized(capture, orderId) {
  const amount = capture?.amount || {};
  return {
    provider: 'PAYPAL',
    orderId: orderId || null,
    captureId: capture?.id || null,
    status: 'SUCCEEDED',
    amountMinor: toMinorUnits(amount.value),
    currency: String(amount.currency_code || 'USD').toUpperCase(),
    draftId: capture?.custom_id || null,
    payerEmail: capture?.payer?.email_address || null,
    channel: null,
  };
}

async function handleCaptureRefunded(capture) {
  const captureId = capture?.id;
  if (!captureId) return;

  const fullyRefunded = String(capture.status || '').toUpperCase() === 'REFUNDED';
  const booking = await prisma.booking.findFirst({
    where: { paypalCaptureId: captureId },
    select: { id: true, bookingNumber: true, status: true, paymentStatus: true },
  });

  if (booking) {
    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        paypalRefundStatus: fullyRefunded ? 'COMPLETED' : 'PARTIAL',
        ...(fullyRefunded
          ? { paymentStatus: 'REFUNDED', refundedAt: new Date(), paypalRefundId: capture?.id || undefined }
          : {}),
      },
    }).catch((err) => console.error('[PayPal] Could not update booking refund state', booking.id, err.message));
  }

  await prisma.bookingPaymentReconciliation.updateMany({
    where: { paypalCaptureId: captureId },
    data: {
      status: fullyRefunded ? 'REFUNDED' : 'REFUND_PENDING',
      refundedAt: fullyRefunded ? new Date() : null,
    },
  }).catch(() => {});

  const refundedAmount = capture?.seller_receivable_breakdown?.refunded_amount?.value
    || capture?.amount?.value
    || 0;

  try {
    const { salesRefundIssued } = require('../services/channelEmbeds');
    const message = salesRefundIssued({
      amount: Number(refundedAmount),
      currency: capture?.amount?.currency_code || 'USD',
      chargeId: captureId,
      bookingNumber: booking?.bookingNumber || null,
      provider: 'PayPal',
    });
    notifyDiscord('sales', message.content, message.opts);
  } catch { /* alerting is best-effort */ }
}

/**
 * Apply one verified PayPal event. Exported so the retry worker can call it with
 * the stored payload.
 */
async function processPaypalEvent(event) {
  const type = event?.event_type;
  const resource = event?.resource || {};

  switch (type) {
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const orderId = await orderIdForCapture(resource);
      if (!orderId) {
        await recordUnmappedPayment(captureAsNormalized(resource, null));
        return { success: true, message: 'capture recorded as unmapped (no order id)' };
      }
      const result = await settlePaypalOrder(orderId, { source: 'webhook' });
      return { success: true, message: `settle:${result.reason || (result.ok ? 'paid' : 'skipped')}` };
    }

    case 'PAYMENT.CAPTURE.DENIED': {
      const orderId = await orderIdForCapture(resource);
      if (orderId) await settlePaypalOrder(orderId, { source: 'webhook' });
      return { success: true, message: 'capture denied' };
    }

    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      await handleCaptureRefunded(resource);
      return { success: true, message: 'capture refund recorded' };
    }

    case 'PAYMENT.CAPTURE.PENDING':
    case 'CHECKOUT.ORDER.APPROVED':
      return { success: true, message: 'no settlement action required' };

    default:
      return { success: true, message: `ignored:${type || 'unknown'}` };
  }
}

/**
 * Store + process a delivery exactly once. A replayed webhook is a no-op.
 */
async function persistAndProcess(event) {
  const row = await prisma.paypalEvent.upsert({
    where: { paypalEventId: event.id },
    create: {
      paypalEventId: event.id,
      eventType: String(event.event_type || 'unknown'),
      resourceId: event?.resource?.id || null,
      data: event,
    },
    update: {},
  });

  if (row.processed) {
    return { duplicate: true, success: true, message: 'already processed' };
  }

  try {
    const result = await processPaypalEvent(event);
    await prisma.paypalEvent.update({
      where: { id: row.id },
      data: { processed: true, processedAt: new Date(), error: null },
    });
    return { ...result, duplicate: false };
  } catch (err) {
    await prisma.paypalEvent.update({
      where: { id: row.id },
      data: { error: String(err.message || err).slice(0, 500) },
    }).catch(() => {});
    throw err;
  }
}

exports.handlePaypalWebhook = catchAsync(async (req, res, next) => {
  const raw = parseRawBody(req.body);
  if (!raw) {
    console.error('[PayPal] Webhook body was parsed before verification — raw body required');
    return next(new AppError('Webhook body was parsed before signature verification — raw body required', 500));
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return next(new AppError('Invalid webhook payload', 400));
  }

  if (!event?.id || !event?.event_type) {
    return next(new AppError('Invalid webhook payload', 400));
  }

  let verification;
  try {
    verification = await verifyWebhookSignature(req.headers, event);
  } catch (err) {
    console.error('[PayPal] Webhook verification failed:', err.message);
    // 400 makes PayPal retry, which is correct for a transient verification
    // failure (e.g. PayPal API unavailable).
    return next(new AppError('Could not verify webhook signature', 400));
  }

  if (!verification.verified) {
    console.warn('[PayPal] Rejected webhook:', verification.reason || verification.status);
    return next(new AppError('Invalid webhook signature', 400));
  }

  try {
    const result = await persistAndProcess(event);

    await logActivity({
      action: `webhook.paypal.${event.event_type}`,
      resource: 'Webhook',
      resourceId: event.id,
      metadata: {
        eventType: event.event_type,
        processed: result.success,
        duplicate: result.duplicate,
        message: result.message,
        resourceId: event?.resource?.id || null,
      },
    }).catch(() => {});

    return res.status(200).json({ status: 'success', message: 'Webhook received' });
  } catch (err) {
    console.error('[PayPal] Webhook processing failed:', err.message);

    await logActivity({
      action: `webhook.paypal.${event.event_type}.error`,
      resource: 'Webhook',
      resourceId: event.id,
      metadata: {
        eventType: event.event_type,
        error: err.message,
        resourceId: event?.resource?.id || null,
      },
    }).catch(() => {});

    enqueuePaypalWebhookRetry(event).catch((queueErr) => {
      console.error('[PayPal] Failed to enqueue webhook retry:', queueErr.message);
    });

    return res.status(200).json({
      status: 'error',
      message: 'Webhook processing failed, queued for retry',
    });
  }
});

exports.processPaypalEvent = processPaypalEvent;
exports.persistAndProcess = persistAndProcess;
