/**
 * Webhook Controller - Production Ready
 * Handles Stripe webhooks and other external service webhooks
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { processStripeWebhook, verifyWebhookSignature } = require('../utils/stripeHelpers');
const { logActivity } = require('../utils/auditLogger');

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
    
    // Log the error but still return 200 to prevent retries
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

    res.status(200).json({
      status: 'error',
      message: 'Webhook processing failed'
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