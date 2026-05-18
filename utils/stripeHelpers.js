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

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const prisma = require('./prismaClient');
const { sendBookingConfirmationEmail, sendSupplierBookingNotification } = require('./emailService');
const event = require('./eventEmitter');

/**
 * Create Stripe Connect Express account for supplier
 */
async function createStripeConnectAccount({ email, businessProfile, individual }) {
  try {
    const accountData = {
      type: 'express',
      country: businessProfile.country || 'US',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      business_type: businessProfile.businessType || 'individual'
    };

    // Add business profile if provided
    if (businessProfile) {
      accountData.business_profile = {
        name: businessProfile.displayName,
        product_description: 'Tour and experience services',
        support_email: email,
        url: businessProfile.website
      };

      if (businessProfile.address) {
        accountData.business_profile.support_address = {
          line1: businessProfile.address.line1,
          line2: businessProfile.address.line2,
          city: businessProfile.address.city,
          state: businessProfile.address.state,
          postal_code: businessProfile.address.postalCode,
          country: businessProfile.country
        };
      }
    }

    // Add individual information if provided
    if (individual && businessProfile.businessType === 'individual') {
      accountData.individual = {
        email,
        first_name: individual.fullName?.split(' ')[0],
        last_name: individual.fullName?.split(' ').slice(1).join(' '),
        dob: individual.dateOfBirth ? {
          day: new Date(individual.dateOfBirth).getDate(),
          month: new Date(individual.dateOfBirth).getMonth() + 1,
          year: new Date(individual.dateOfBirth).getFullYear()
        } : undefined
      };

      if (individual.address) {
        accountData.individual.address = {
          line1: individual.address.line1,
          line2: individual.address.line2,
          city: individual.address.city,
          state: individual.address.state,
          postal_code: individual.address.postalCode,
          country: businessProfile.country
        };
      }
    }

    const account = await stripe.accounts.create(accountData);
    
    console.log(`✅ Stripe Connect account created: ${account.id}`);
    return account;
  } catch (error) {
    console.error('❌ Stripe Connect account creation failed:', error);
    throw new Error(`Failed to create Stripe account: ${error.message}`);
  }
}

/**
 * Create Stripe Connect onboarding link
 */
async function createOnboardingLink(accountId, { refreshUrl, returnUrl }) {
  try {
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding'
    });

    console.log(`✅ Onboarding link created for account: ${accountId}`);
    return accountLink;
  } catch (error) {
    console.error('❌ Onboarding link creation failed:', error);
    throw new Error(`Failed to create onboarding link: ${error.message}`);
  }
}

/**
 * Create Payment Intent with commission split
 */
async function createPaymentIntent({
  amount,
  currency = 'USD',
  customerId,
  paymentMethodId,
  bookings,
  metadata = {}
}) {
  try {
    // Calculate total commission and transfers
    let totalCommission = 0;
    const transfers = [];

    for (const booking of bookings) {
      const supplierAccountId = booking.tour.supplier.supplierProfile.stripeAccountId;
      const supplierPayout = Math.round(parseFloat(booking.supplierPayout) * 100); // Convert to cents
      const commission = Math.round(parseFloat(booking.commissionAmount) * 100);

      totalCommission += commission;

      if (supplierAccountId && supplierPayout > 0) {
        transfers.push({
          destination: supplierAccountId,
          amount: supplierPayout
        });
      }
    }

    const paymentIntentData = {
      amount,
      currency: currency.toLowerCase(),
      customer: customerId,
      payment_method: paymentMethodId,
      confirmation_method: 'manual',
      confirm: true,
      return_url: `${process.env.CLIENT_URL}/booking/complete`,
      metadata: {
        ...metadata,
        totalCommission: totalCommission.toString(),
        bookingCount: bookings.length.toString()
      }
    };

    // Add application fee if there are commissions
    if (totalCommission > 0) {
      paymentIntentData.application_fee_amount = totalCommission;
    }

    // Add transfer data for the first supplier (Stripe limitation)
    // For multiple suppliers, we'll handle transfers via webhooks
    if (transfers.length === 1) {
      paymentIntentData.transfer_data = {
        destination: transfers[0].destination,
        amount: transfers[0].amount
      };
    }

    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

    console.log(`✅ Payment Intent created: ${paymentIntent.id} for amount: ${amount}`);
    return paymentIntent;
  } catch (error) {
    console.error('❌ Payment Intent creation failed:', error);
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
    console.log(`🔔 Processing Stripe webhook: ${event.type}`);

    // Check if event already processed (idempotency)
    const existingEvent = await prisma.stripeEvent.findUnique({
      where: { stripeEventId: event.id }
    });

    if (existingEvent && existingEvent.processed) {
      console.log(`⚠️ Event ${event.id} already processed, skipping`);
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

      case 'account.updated':
        result = await handleAccountUpdated(event.data.object);
        break;

      case 'transfer.created':
        result = await handleTransferCreated(event.data.object);
        break;

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }

    // Mark event as processed
    await prisma.stripeEvent.update({
      where: { stripeEventId: event.id },
      data: { processed: true }
    });

    return result;
  } catch (error) {
    console.error('❌ Webhook processing failed:', error);
    throw error;
  }
}

/**
 * Handle successful payment
 */
async function handlePaymentSucceeded(paymentIntent) {
  const bookingIds = paymentIntent.metadata.bookingIds?.split(',') || [];
  
  if (bookingIds.length === 0) {
    console.log('⚠️ No booking IDs found in payment intent metadata');
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

    console.log(`✅ Updated ${updatedBookings.count} bookings to CONFIRMED`);

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

      // Update supplier statistics
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
    }
  });

  // Send confirmation emails (non-blocking, outside transaction)
  for (const booking of bookings) {
    sendBookingConfirmationEmail(booking).catch(console.error);
    sendSupplierBookingNotification(booking).catch(console.error);
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

  console.log(`❌ Marked ${bookingIds.length} bookings as CANCELLED due to payment failure`);
  return { success: true, message: `${bookingIds.length} bookings cancelled` };
}

/**
 * Handle Stripe Connect account updates
 */
async function handleAccountUpdated(account) {
  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { stripeAccountId: account.id },
    include: { user: true }
  });

  if (!supplierProfile) {
    console.log(`⚠️ No supplier found for Stripe account: ${account.id}`);
    return { success: false, message: 'Supplier not found' };
  }

  const chargesEnabled = account.charges_enabled;
  const payoutsEnabled = account.payouts_enabled;
  const onboardingComplete = chargesEnabled && payoutsEnabled;

  // Update supplier status if onboarding is complete
  if (onboardingComplete && supplierProfile.status === 'STRIPE_PENDING') {
    await prisma.supplierProfile.update({
      where: { id: supplierProfile.id },
      data: { status: 'ACTIVE' }
    });

    // Send notification
    await prisma.notification.create({
      data: {
        userId: supplierProfile.userId,
        type: 'SUPPLIER_APPROVED',
        title: 'Supplier Account Activated',
        message: 'Your supplier account is now active! You can start creating tours.',
        data: { supplierId: supplierProfile.userId }
      }
    });

    console.log(`✅ Supplier ${supplierProfile.userId} activated`);
  }

  return { success: true, message: 'Account status updated' };
}

/**
 * Generate a Stripe Express dashboard login link for suppliers.
 * This lets suppliers update their bank account, tax info, and view payouts.
 */
async function createDashboardLink(stripeAccountId) {
  try {
    const link = await stripe.accounts.createLoginLink(stripeAccountId);
    return link.url;
  } catch (error) {
    console.error('❌ Failed to create Stripe dashboard link:', error.message);
    throw new Error(`Failed to create dashboard link: ${error.message}`);
  }
}

/**
 * Handle transfer creation (for tracking payouts)
 */
async function handleTransferCreated(transfer) {
  console.log(`💰 Transfer created: ${transfer.id} for ${transfer.amount} to ${transfer.destination}`);

  // You can add logic here to track individual payouts
  // and update supplier earnings records

  return { success: true, message: 'Transfer logged' };
}

/**
 * Verify Stripe webhook signature
 */
function verifyWebhookSignature(payload, signature, endpointSecret) {
  try {
    return stripe.webhooks.constructEvent(payload, signature, endpointSecret);
  } catch (error) {
    console.error('❌ Webhook signature verification failed:', error.message);
    throw new Error('Invalid webhook signature');
  }
}

module.exports = {
  createStripeConnectAccount,
  createOnboardingLink,
  createPaymentIntent,
  calculateCommission,
  processStripeWebhook,
  verifyWebhookSignature,
  createDashboardLink,
};