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
const { enqueueEmail } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
const event = require('./eventEmitter');

/**
 * Create Payment Intent with commission split
 */
async function createPaymentIntent({
  amount,
  currency = 'USD',
  customerId,
  paymentMethodId,
  metadata = {}
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

    const paymentIntent = await getStripe().paymentIntents.create(paymentIntentData);

    console.log(` Payment Intent created: ${paymentIntent.id} for amount: ${amount}`);
    return paymentIntent;
  } catch (error) {
    console.error(' Payment Intent creation failed:', error);
    throw new Error(`Failed to create payment: ${error.message}`);
  }
}

/**
 * Calculate commission based on supplier tier and booking amount
 */
function calculateCommission(bookingAmount, supplierProfile) {
  const amount = parseFloat(bookingAmount);
  
  // Default commission rates based on supplier tier/volume
  let commissionRate = 0.15; // 15% default
  
  // Adjust rate based on supplier performance
  if (supplierProfile.totalBookings > 100) {
    commissionRate = 0.12; // 12% for high-volume suppliers
  } else if (supplierProfile.totalBookings > 50) {
    commissionRate = 0.13; // 13% for medium-volume suppliers
  } else if (supplierProfile.averageRating && supplierProfile.averageRating >= 4.8) {
    commissionRate = 0.14; // 14% for high-rated new suppliers
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
 */
async function processStripeWebhook(event) {
  try {
    console.log(` Processing Stripe webhook: ${event.type}`);

    // Check if event already processed (idempotency)
    const existingEvent = await prisma.stripeEvent.findUnique({
      where: { stripeEventId: event.id }
    });

    if (existingEvent && existingEvent.processed) {
      console.log(` Event ${event.id} already processed, skipping`);
      return { success: true, message: 'Event already processed' };
    }

    // Store event for idempotency
    await prisma.stripeEvent.upsert({
      where: { stripeEventId: event.id },
      update: { data: event },
      create: {
        stripeEventId: event.id,
        eventType: event.type,
        data: event,
        processed: false
      }
    });

    let result = { success: true, message: 'Event processed' };

    switch (event.type) {
      case 'payment_intent.succeeded':
        result = await handlePaymentSucceeded(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        result = await handlePaymentFailed(event.data.object);
        break;

      default:
        console.log(` Unhandled event type: ${event.type}`);
    }

    // Mark event as processed
    await prisma.stripeEvent.update({
      where: { stripeEventId: event.id },
      data: { processed: true }
    });

    return result;
  } catch (error) {
    console.error(' Webhook processing failed:', error);
    throw error;
  }
}

/**
 * Handle successful payment
 */
async function handlePaymentSucceeded(paymentIntent) {
  const bookingIds = paymentIntent.metadata.bookingIds?.split(',') || [];
  
  if (bookingIds.length === 0) {
    console.log(' No booking IDs found in payment intent metadata');
    return { success: false, message: 'No bookings found' };
  }

  let bookings;

  await prisma.$transaction(async (tx) => {
    // Update booking statuses
    const updatedBookings = await tx.booking.updateMany({
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

    // Get booking details for notifications
    bookings = await tx.booking.findMany({
      where: { id: { in: bookingIds } },
      include: {
        customer: true,
        tour: {
          include: {
            supplier: true
          }
        }
      }
    });

    // Send notifications and emails
    for (const booking of bookings) {
      // Notify customer
      await tx.notification.create({
        data: {
          userId: booking.customerId,
          type: 'BOOKING_CONFIRMED',
          title: 'Booking Confirmed',
          message: `Your booking for "${booking.tour.title}" has been confirmed!`,
          data: { bookingId: booking.id }
        }
      });

      // Notify supplier
      await tx.notification.create({
        data: {
          userId: booking.tour.supplierId,
          type: 'BOOKING_CONFIRMED',
          title: 'New Booking Received',
          message: `You have a new booking for "${booking.tour.title}"`,
          data: { bookingId: booking.id }
        }
      });

      // Update supplier statistics (internal ledger)
      await tx.supplierProfile.update({
        where: { userId: booking.tour.supplierId },
        data: {
          totalBookings: { increment: 1 },
          totalEarnings: { increment: booking.supplierPayout }
        }
      });

      // Update tour statistics
      await tx.tour.update({
        where: { id: booking.tourId },
        data: {
          totalBookings: { increment: 1 },
          totalRevenue: { increment: booking.total }
        }
      });

      // Create Payout record (PENDING — awaits admin approval)
      await tx.payout.create({
        data: {
          supplierId: booking.tour.supplierId,
          bookingId: booking.id,
          amount: booking.supplierPayout,
          currency: booking.currency,
          commissionAmount: booking.commissionAmount,
          status: 'PENDING'
        }
      });
    }
  });

  // Send confirmation emails through the queue (non-blocking, outside transaction)
  for (const booking of bookings) {
    enqueueEmail({ type: 'booking-confirmation', bookingId: booking.id }).catch((err) => console.error('[Email] Booking confirmation email failed:', err.message));
    enqueueEmail({ type: 'supplier-booking-notification', bookingId: booking.id }).catch((err) => console.error('[Email] Supplier booking notification email failed:', err.message));
  }

  // Notify admins of new pending payouts
  for (const booking of bookings) {
    notifyAdmin({
      type: 'PAYOUT_NEEDS_APPROVAL',
      title: 'New Payout Pending',
      message: `Booking #${booking.bookingNumber}: $${parseFloat(booking.supplierPayout).toFixed(2)} payout awaiting approval`,
      data: { bookingId: booking.id, tourTitle: booking.tour?.title, amount: booking.supplierPayout },
    }).catch((err) => console.error('[AdminNotification] Payout notification failed:', err.message));
  }

  // Emit analytics events for each completed booking
  for (const booking of bookings) {
    event.emit({
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
        paymentIntentId: paymentIntent.id,
      },
      source: 'webhook',
    });
  }

  return { success: true, message: `${bookingIds.length} bookings confirmed` };
}

/**
 * Handle failed payment
 */
async function handlePaymentFailed(paymentIntent) {
  const bookingIds = paymentIntent.metadata.bookingIds?.split(',') || [];
  
  if (bookingIds.length === 0) {
    return { success: false, message: 'No bookings found' };
  }

  await prisma.booking.updateMany({
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
  calculateCommission,
  processStripeWebhook,
  verifyWebhookSignature,
};