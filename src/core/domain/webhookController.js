/**
 * Webhook Controller - Production Ready
 * Handles Stripe webhooks and other external service webhooks
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const { processStripeWebhook, verifyWebhookSignature } = require('../services/stripeHelpers');
const { enqueueWebhookRetry } = require('../services/queue');
const { logActivity } = require('../services/auditLogger');
const { notifyDiscord } = require('../services/discordNotifier');
const prisma = require('../services/prismaClient');

/**
 * Handle Stripe webhooks
 */
exports.handleStripeWebhook = catchAsync(async (req, res, next) => {
  const signature = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature) {
    return next(new AppError('Missing Stripe signature', 400));
  }

  if (!endpointSecret) {
    console.error('❌ STRIPE_WEBHOOK_SECRET not configured');
    return next(new AppError('Webhook configuration error', 500));
  }

  // Stripe SDK's constructEvent requires the raw request body (Buffer or
  // string).  If express.json() ran before express.raw() on this request the
  // body would already be a parsed object and the signature would never match.
  // Guard against that so we get an actionable log instead of the opaque
  // "No signatures found matching the expected signature" error.
  if (!Buffer.isBuffer(req.body) && typeof req.body !== 'string') {
    console.error(
      `[Webhook] ⚠ req.body is type=${typeof req.body}, constructor=${req.body?.constructor?.name} — expected Buffer. ` +
      `Signature verification will fail. Check that express.raw() runs before express.json() for /api/webhooks/stripe.`
    );
    return next(new AppError('Webhook body was parsed before signature verification — raw body required', 500));
  }

  let event;
  
  try {
    // Verify webhook signature
    event = verifyWebhookSignature(req.body, signature, endpointSecret);
    console.log(`🔔 Stripe webhook received: ${event.type}`);
  } catch (error) {
    console.error('❌ Webhook signature verification failed:', error.message);
    return next(new AppError('Invalid webhook signature', 400));
  }

  try {
    // Process the webhook event
    const result = await processStripeWebhook(event);
    
    // Log webhook processing
    await logActivity({
      action: `webhook.stripe.${event.type}`,
      resource: 'Webhook',
      resourceId: event.id,
      metadata: {
        eventType: event.type,
        processed: result.success,
        message: result.message
      }
    });

    if (result.success) {
      console.log(`✅ Webhook processed successfully: ${result.message}`);

      // Discord: payment events (fire-and-forget, never affects webhook handling)
      const { salesPaymentFailed, salesPaymentRecovered, salesRefundIssued, formatDeclineReason } = require('../services/channelEmbeds');
      if (event.type === 'payment_intent.payment_failed') {
        const pi = event.data.object || {};
        const err = pi.last_payment_error || {};
        const email = pi.receipt_email || (err.payment_method && err.payment_method.billing_details ? err.payment_method.billing_details.email : null);
        // Issuer declines / 3-D Secure challenges are retryable — the customer
        // often pays on the next attempt, so remember the failure (30 min) and
        // word the alert as a decline rather than a final failure.
        const recoverable = ['card_declined', 'authentication_required', 'payment_intent_authentication_failure'].includes(err.code)
          || err.type === 'card_error';
        try {
          // Use the module's safe helpers (they ensure a ready connection and
          // no-op while Redis is degraded) — the low-level getClient() returns
          // null outside a connected state, which made the marker vanish and
          // the recovery notice below never post.
          const { set } = require('../services/redisClient');
          await set(`hp:payfail:${pi.id}`, { amount: pi.amount, currency: pi.currency, email, at: Date.now() }, 1800);
        } catch { /* best effort */ }
        // The PaymentIntent error only says "payment attempt failed"; fetch the
        // Charge to report what the issuer actually did (issuer_declined /
        // generic_decline, plus the bank's message) so the alert is actionable
        // without opening the Stripe dashboard.
        let chargeOutcome = {};
        if (err.charge) {
          try {
            const { getStripe } = require('../services/stripeHelpers');
            const charge = await getStripe().charges.retrieve(err.charge);
            chargeOutcome = charge.outcome || {};
          } catch (lookupErr) {
            console.warn('[Stripe] decline-detail lookup failed:', lookupErr.message);
          }
        }

        const failed = salesPaymentFailed({
          amount: (pi.amount || 0) / 100,
          currency: pi.currency || 'USD',
          paymentIntentId: pi.id,
          email,
          reason: formatDeclineReason(err, chargeOutcome),
          recoverable,
        });
        notifyDiscord('sales', failed.content, failed.opts);
      } else if (event.type === 'payment_intent.succeeded') {
        // If this PaymentIntent failed recently, post the recovery so the
        // channel reflects the final state (e.g. a 3-D Secure retry).
        const pi = event.data.object || {};
        try {
          const { get, del } = require('../services/redisClient');
          let prior = await get(`hp:payfail:${pi.id}`);
          if (prior) {
            await del(`hp:payfail:${pi.id}`);
          } else {
            // Redis marks the decline as a 30-minute best effort, so it can be
            // missing (degraded Redis, a restart, a worker that never wrote it) —
            // and then a successful retry left the channel showing a scary
            // "Payment Declined" with no counter-notice. Every Stripe event is
            // also persisted, so fall back to that record, which cannot be lost.
            const since = new Date(Date.now() - 30 * 60 * 1000);
            const failedEvent = await prisma.stripeEvent.findFirst({
              where: {
                eventType: 'payment_intent.payment_failed',
                createdAt: { gte: since },
                data: { path: ['data', 'object', 'id'], equals: pi.id },
              },
              orderBy: { createdAt: 'desc' },
            });
            if (failedEvent) prior = { email: pi.receipt_email || null };
          }
          if (prior) {
            const recovered = salesPaymentRecovered({
              amount: (pi.amount || 0) / 100,
              currency: pi.currency || 'USD',
              paymentIntentId: pi.id,
              email: prior.email || pi.receipt_email || null,
            });
            notifyDiscord('sales', recovered.content, recovered.opts);
          }
        } catch { /* best effort */ }
      } else if (event.type === 'charge.refunded') {
        const ch = event.data.object || {};
        const refunded = salesRefundIssued({
          amount: (ch.amount_refunded || 0) / 100,
          currency: ch.currency || 'USD',
          chargeId: ch.id,
        });
        notifyDiscord('sales', refunded.content, refunded.opts);
      }
    } else {
      console.error(`❌ Webhook processing failed: ${result.message}`);
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({
      status: 'success',
      message: 'Webhook received'
    });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    
    await logActivity({
      action: `webhook.stripe.${event.type}.error`,
      resource: 'Webhook',
      resourceId: event.id,
      metadata: {
        eventType: event.type,
        error: error.message,
        stack: error.stack
      }
    });

    // Enqueue for retry — processStripeWebhook wraps everything in a
    // single $transaction, so a partial failure rolls back cleanly and
    // re-processing is safe.
    enqueueWebhookRetry(event).catch((err) =>
      console.error('[Webhook] Failed to enqueue retry:', err.message)
    );

    // Still return 200 to Stripe — retries handled internally via the
    // webhook-retry BullMQ queue with exponential backoff.
    res.status(200).json({
      status: 'error',
      message: 'Webhook processing failed, queued for retry'
    });
  }
});

/**
 * Test webhook endpoint for development
 */
exports.testWebhook = catchAsync(async (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return next(new AppError('Test endpoint not available in production', 404));
  }

  const { eventType = 'test.event', data = {} } = req.body;

  console.log(`🧪 Test webhook: ${eventType}`, data);

  // Log test webhook
  await logActivity({
    action: `webhook.test.${eventType}`,
    resource: 'Webhook',
    metadata: {
      eventType,
      data,
      source: 'test'
    }
  });

  res.status(200).json({
    status: 'success',
    message: 'Test webhook received',
    data: {
      eventType,
      receivedAt: new Date().toISOString(),
      data
    }
  });
});

module.exports = exports;

