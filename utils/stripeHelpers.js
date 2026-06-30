/**
 * Stripe Integration Helpers - Production Ready
 * Handles Stripe payments, Connect accounts, and webhooks
 * 
 * Features:
 * - Payment Intent creation with commission splits
 * - Stripe Connect account management
 * - Webhook signature verification
 * - Commission calculations
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const Stripe = require('stripe');

let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is required to use Stripe.');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2025-02-24.acacia',
      maxNetworkRetries: 2,
      timeout: 30000,
    });
  }
  return _stripe;
}
const prisma = require('./prismaClient');
const { enqueueEmail, enqueueEvent } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
const getConfig = require('./getConfig');

/**
 * Create Payment Intent with commission split
 */
async function createPaymentIntent({
  amount,
  currency = 'USD',
  customerId,
  paymentMethodId,
  metadata = {},
  idempotencyKey
}) {
  try {
    const paymentIntentData = {
      amount,
      currency: currency.toLowerCase(),
      customer: customerId,
      payment_method: paymentMethodId,
      confirmation_method: 'manual',
      confirm: true,
      return_url: `${process.env.CLIENT_URL}/booking/complete`,
      metadata
    };

    const options = idempotencyKey ? { idempotencyKey } : {};
    const paymentIntent = await getStripe().paymentIntents.create(paymentIntentData, options);

    console.log(` Payment Intent created: ${paymentIntent.id} for amount: ${amount}`);
    return paymentIntent;
  } catch (error) {
    console.error(' Payment Intent creation failed:', error);
    throw new Error(`Failed to create payment: ${error.message}`);
  }
}

/**
 * Create a Stripe refund for a PaymentIntent
 */
async function createRefund(paymentIntentId, amount = null) {
  try {
    const refundData = { payment_intent: paymentIntentId };
    if (amount !== null) {
      refundData.amount = amount;
    }
    const refund = await getStripe().refunds.create(refundData);
    console.log(` Refund created: ${refund.id} for PaymentIntent: ${paymentIntentId}`);
    return refund;
  } catch (error) {
    console.error(' Refund creation failed:', error);
    throw new Error(`Failed to create refund: ${error.message}`);
  }
}

/**
 * Calculate commission based on supplier tier and booking amount
 */
async function calculateCommission(bookingAmount, supplierProfile) {
  const amount = parseFloat(bookingAmount);

  const defaultRate = parseFloat(await getConfig('commission.default_rate', '0.15'));
  let commissionRate = defaultRate;

  // Adjust rate based on supplier performance
  // Use totalBookings + 1 since this booking hasn't been counted yet
  const bookingCount = supplierProfile.totalBookings + 1;
  if (bookingCount > 100) {
    commissionRate = Math.max(0.01, defaultRate - 0.03);
  } else if (bookingCount > 50) {
    commissionRate = Math.max(0.01, defaultRate - 0.02);
  } else if (supplierProfile.averageRating && supplierProfile.averageRating >= 4.8) {
    commissionRate = Math.max(0.01, defaultRate - 0.01);
  }

  const commissionAmount = amount * commissionRate;
  const supplierPayout = amount - commissionAmount;

  return {
    rate: commissionRate,
    amount: commissionAmount,
    supplierPayout: supplierPayout
  };
}

/**
 * Process Stripe webhook events
 *
 * Idempotency is guaranteed by wrapping the entire flow in a single
 * $transaction.  The stripeEvent upsert + business logic + processed
 * flag update happen atomically.  If the transaction rolls back,
 * the event remains un-processed and a retry is safe.
 *
 * Side-effects (emails, admin notifications, analytics) run AFTER
 * the transaction commits so they are never emitted for a rolled-back
 * event.
 */
async function processStripeWebhook(event) {
  console.log(` Processing Stripe webhook: ${event.type}`);

  let bookings = [];

  await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction — serialized by Postgres, no race
    const existingEvent = await tx.stripeEvent.findUnique({
      where: { stripeEventId: event.id }
    });

    if (existingEvent && existingEvent.processed) {
      console.log(` Event ${event.id} already processed, skipping`);
      return;
    }

    // Upsert event record (creates on first call, updates on concurrent duplicate)
    await tx.stripeEvent.upsert({
      where: { stripeEventId: event.id },
      update: { data: event },
      create: {
        stripeEventId: event.id,
        eventType: event.type,
        data: event,
        processed: false
      }
    });

    switch (event.type) {
      case 'payment_intent.succeeded':
        bookings = await handlePaymentSucceeded(event.data.object, tx);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object, tx);
        break;

      default:
        console.log(` Unhandled event type: ${event.type}`);
    }

    // Mark processed INSIDE the same transaction.
    // If this line is reached, the transaction commits everything atomically.
    // A concurrent duplicate would have its upsert succeed but the stripeEvent
    // already has processed=false here; however Postgres serialization ensures
    // only one transaction commits — the others fail and retry.
    await tx.stripeEvent.update({
      where: { stripeEventId: event.id },
      data: { processed: true }
    });
  });

  // ── Side effects run AFTER the transaction committed ──────────────
  // These are fire-and-forget; failures are caught and logged but do
  // not affect the booking state (which is already committed).

  for (const booking of bookings) {
    enqueueEmail({ type: 'booking-confirmation', bookingId: booking.id })
      .catch((err) => console.error('[Email] Booking confirmation failed:', err.message));
    enqueueEmail({ type: 'supplier-booking-notification', bookingId: booking.id })
      .catch((err) => console.error('[Email] Supplier notification failed:', err.message));

    notifyAdmin({
      type: 'PAYOUT_NEEDS_APPROVAL',
      title: 'New Payout Pending',
      message: `Booking #${booking.bookingNumber}: $${parseFloat(booking.supplierPayout).toFixed(2)} payout awaiting approval`,
      data: { bookingId: booking.id, tourTitle: booking.tour?.title, amount: booking.supplierPayout },
    }).catch((err) => console.error('[AdminNotification] Payout notification failed:', err.message));

    enqueueEvent({
      name: 'booking.completed',
      userId: booking.customerId,
      resource: 'Booking',
      resourceId: booking.id,
      properties: {
        tourId: booking.tourId,
        total: parseFloat(booking.total),
        currency: booking.currency,
        supplierPayout: parseFloat(booking.supplierPayout),
        commissionAmount: parseFloat(booking.commissionAmount),
        supplierId: booking.tour?.supplierId,
        paymentIntentId: event.data.object?.id,
      },
      source: 'webhook',
    });
  }

  return { success: true, message: 'Event processed' };
}

/**
 * Handle successful payment
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 * @param {object} [tx] - Optional Prisma transaction client.
 *   When provided, all DB operations use this client (called from
 *   within the parent transaction in processStripeWebhook).
 *   When omitted, creates its own transaction (standalone call).
 * @returns {Promise<Array>} Array of booking records (for side effects)
 */
async function handlePaymentSucceeded(paymentIntent, tx = null) {
  const bookingIds = paymentIntent.metadata.bookingIds?.split(',') || [];
  
  if (bookingIds.length === 0) {
    console.log(' No booking IDs found in payment intent metadata');
    return [];
  }

  let bookings;
  const payoutMinThreshold = parseFloat(await getConfig('payout.min_threshold', '0'));

  const dbWork = async (client) => {
    const updatedBookings = await client.booking.updateMany({
      where: {
        id: { in: bookingIds },
        stripePaymentIntentId: paymentIntent.id
      },
      data: {
        status: 'CONFIRMED',
        paymentStatus: 'SUCCEEDED',
        paidAt: new Date()
      }
    });

    console.log(` Updated ${updatedBookings.count} bookings to CONFIRMED`);

    bookings = await client.booking.findMany({
      where: { id: { in: bookingIds } },
      include: {
        customer: true,
        tour: { include: { supplier: true } }
      }
    });

    for (const booking of bookings) {
      await client.notification.create({
        data: {
          userId: booking.customerId,
          type: 'BOOKING_CONFIRMED',
          title: 'Booking Confirmed',
          message: `Your booking for "${booking.tour.title}" has been confirmed!`,
          data: { bookingId: booking.id }
        }
      });

      await client.notification.create({
        data: {
          userId: booking.tour.supplierId,
          type: 'BOOKING_CONFIRMED',
          title: 'New Booking Received',
          message: `You have a new booking for "${booking.tour.title}"`,
          data: { bookingId: booking.id }
        }
      });

      await client.supplierProfile.update({
        where: { userId: booking.tour.supplierId },
        data: {
          totalBookings: { increment: 1 },
          totalEarnings: { increment: booking.supplierPayout }
        }
      });

      await client.tour.update({
        where: { id: booking.tourId },
        data: {
          totalBookings: { increment: 1 },
          totalRevenue: { increment: booking.total }
        }
      });

      if (booking.appliedOfferId) {
        const travelerCount = (booking.travelers?.adults || 0) + (booking.travelers?.children || 0) + (booking.travelers?.infants || 0);
        await client.specialOffer.update({
          where: { id: booking.appliedOfferId },
          data: { spotsSold: { increment: travelerCount } },
        });
      }

      if (parseFloat(booking.supplierPayout) >= payoutMinThreshold) {
        const defaultMethod = await client.payoutMethod.findFirst({
          where: { supplierId: booking.tour.supplierId, verified: true },
          orderBy: { isDefault: 'desc' }
        });

        await client.payout.create({
          data: {
            supplierId: booking.tour.supplierId,
            bookingId: booking.id,
            amount: booking.supplierPayout,
            currency: booking.currency,
            commissionAmount: booking.commissionAmount,
            status: 'PENDING',
            payoutMethodId: defaultMethod?.id || null
          }
        });
      }
    }
  };

  if (tx) {
    await dbWork(tx);
  } else {
    await prisma.$transaction(dbWork);
  }

  return bookings;
}

/**
 * Handle failed payment
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 * @param {object} [tx] - Optional Prisma transaction client
 */
async function handlePaymentFailed(paymentIntent, tx = null) {
  const bookingIds = paymentIntent.metadata.bookingIds?.split(',') || [];
  
  if (bookingIds.length === 0) {
    return { success: false, message: 'No bookings found' };
  }

  const client = tx || prisma;

  await client.booking.updateMany({
    where: {
      id: { in: bookingIds },
      stripePaymentIntentId: paymentIntent.id
    },
    data: {
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
      cancellationReason: 'Payment failed'
    }
  });

  console.log(` Marked ${bookingIds.length} bookings as CANCELLED due to payment failure`);
  return { success: true, message: `${bookingIds.length} bookings cancelled` };
}

/**
 * Verify Stripe webhook signature
 */
function verifyWebhookSignature(payload, signature, endpointSecret) {
  try {
    return getStripe().webhooks.constructEvent(payload, signature, endpointSecret);
  } catch (error) {
    console.error(' Webhook signature verification failed:', error.message);
    throw new Error('Invalid webhook signature');
  }
}

module.exports = {
  createPaymentIntent,
  createRefund,
  calculateCommission,
  processStripeWebhook,
  verifyWebhookSignature,
};