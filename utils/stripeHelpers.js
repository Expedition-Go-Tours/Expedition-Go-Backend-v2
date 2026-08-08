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
  idempotencyKey,
  confirm = true
}) {
  try {
    const paymentIntentData = {
      amount,
      currency: currency.toLowerCase(),
      customer: customerId,
      payment_method: paymentMethodId,
      confirmation_method: 'manual',
      confirm,
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
 * Try to cancel a PaymentIntent before deleting a tour.
 *
 * Returns:
 *   { ok: true }            — intent is canceled (or was already canceled)
 *   { ok: false, reason }   — cannot prove it is cancelable, caller must block:
 *                             'status_succeeded' | 'status_processing' |
 *                             'cancel_failed' | 'unavailable'
 *
 * Never throws. If we cannot PROVE the intent is canceled we report failure,
 * because the alternative is silently cancelling a booking whose money may
 * be in flight.
 */
async function cancelPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return { ok: true };

  let intent;
  try {
    intent = await getStripe().paymentIntents.retrieve(paymentIntentId);
  } catch (error) {
    console.error('[Stripe] PaymentIntent retrieve failed:', paymentIntentId, error.message);
    return { ok: false, reason: 'unavailable' };
  }

  if (intent.status === 'canceled') return { ok: true };
  if (intent.status === 'succeeded' || intent.status === 'processing') {
    return { ok: false, reason: `status_${intent.status}` };
  }

  try {
    await getStripe().paymentIntents.cancel(paymentIntentId);
    return { ok: true };
  } catch (error) {
    console.error('[Stripe] PaymentIntent cancel failed:', paymentIntentId, error.message);
    return { ok: false, reason: 'cancel_failed' };
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
    const isExpedition = booking.source === 'EXPEDITION';
    const emailData = isExpedition
      ? {
          brandName: process.env.EXPEDITION_BRAND_NAME || 'Expedition Go Tours',
          logoUrl: process.env.EXPEDITION_LOGO_URL || process.env.LOGO_URL,
          supportEmail: process.env.EXPEDITION_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL || 'support@expeditiongo.com',
        }
      : {};

    enqueueEmail({ type: 'booking-confirmation', bookingId: booking.id, data: emailData })
      .catch((err) => console.error('[Email] Booking confirmation failed:', err.message));
    enqueueEmail({ type: 'supplier-booking-notification', bookingId: booking.id })
      .catch((err) => console.error('[Email] Supplier notification failed:', err.message));

    if (isExpedition) {
      notifyAdmin({
        type: 'BOOKING_CONFIRMED',
        title: 'Expedition Booking Confirmed',
        message: `Booking #${booking.bookingNumber} — $${parseFloat(booking.total).toFixed(2)} for "${booking.tour.title}" has been confirmed`,
        data: { bookingId: booking.id, tourTitle: booking.tour?.title, amount: booking.total, source: 'expedition' },
      }).catch((err) => console.error('[AdminNotification] Expedition notification failed:', err.message));
    } else {
      notifyAdmin({
        type: 'PAYOUT_NEEDS_APPROVAL',
        title: 'New Payout Pending',
        message: `Booking #${booking.bookingNumber}: $${parseFloat(booking.supplierPayout).toFixed(2)} payout awaiting approval`,
        data: { bookingId: booking.id, tourTitle: booking.tour?.title, amount: booking.supplierPayout },
      }).catch((err) => console.error('[AdminNotification] Payout notification failed:', err.message));
    }

    enqueueEvent({
      name: isExpedition ? 'expedition.booking_completed' : 'booking.completed',
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
      source: isExpedition ? 'expedition' : 'webhook',
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
  let bookings;
  const payoutMinThreshold = parseFloat(await getConfig('payout.min_threshold', '0'));

  const dbWork = async (client) => {
    // Try to find bookings by metadata.bookingIds (main flow: bookings exist before PI)
    if (bookingIds.length > 0) {
      const updatedBookings = await client.booking.updateMany({
        where: {
          id: { in: bookingIds },
          stripePaymentIntentId: paymentIntent.id,
          // Only still-pending bookings may be confirmed — a booking the
          // supplier already cancelled (e.g. their tour was deleted) must
          // never be resurrected by a late webhook.
          status: 'PENDING'
        },
        data: {
          status: 'CONFIRMED',
          paymentStatus: 'SUCCEEDED',
          paidAt: new Date()
        }
      });

      console.log(` Updated ${updatedBookings.count} bookings to CONFIRMED`);

      if (updatedBookings.count > 0) {
        bookings = await client.booking.findMany({
          where: { id: { in: bookingIds } },
          include: {
            customer: true,
            tour: { include: { supplier: true } }
          }
        });
      }
    }

    // Fallback: find expedition booking by stripePaymentIntentId
    // (booking was created after PI confirmation, metadata updated async)
    if (!bookings || bookings.length === 0) {
      const updated = await client.booking.updateMany({
        where: {
          stripePaymentIntentId: paymentIntent.id,
          status: 'PENDING',
          paymentStatus: 'PENDING'
        },
        data: {
          status: 'CONFIRMED',
          paymentStatus: 'SUCCEEDED',
          paidAt: new Date()
        }
      });

      if (updated.count > 0) {
        console.log(` Updated ${updated.count} expedition bookings to CONFIRMED`);
        bookings = await client.booking.findMany({
          where: { stripePaymentIntentId: paymentIntent.id },
          include: {
            customer: true,
            tour: { include: { supplier: true } }
          }
        });
      }
    }

    if (!bookings || bookings.length === 0) {
      console.log(' No bookings found for payment intent:', paymentIntent.id);
      return;
    }

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

  return bookings || [];
}

/**
 * Handle failed payment
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 * @param {object} [tx] - Optional Prisma transaction client
 */
async function handlePaymentFailed(paymentIntent, tx = null) {
  const bookingIds = paymentIntent.metadata.bookingIds?.split(',') || [];
  const client = tx || prisma;

  if (bookingIds.length > 0) {
    await client.booking.updateMany({
      where: {
        id: { in: bookingIds },
        stripePaymentIntentId: paymentIntent.id,
        status: 'PENDING'
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

  // Fallback: find expedition booking by stripePaymentIntentId
  const updated = await client.booking.updateMany({
    where: {
      stripePaymentIntentId: paymentIntent.id,
      status: 'PENDING',
      paymentStatus: 'PENDING'
    },
    data: {
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
      cancellationReason: 'Payment failed'
    }
  });

  if (updated.count > 0) {
    console.log(` Marked ${updated.count} expedition bookings as CANCELLED due to payment failure`);
  }

  return { success: true, message: `${updated.count} bookings cancelled` };
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
  cancelPaymentIntent,
  calculateCommission,
  processStripeWebhook,
  verifyWebhookSignature,
};