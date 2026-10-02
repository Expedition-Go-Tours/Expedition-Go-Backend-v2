#!/usr/bin/env node
/**
 * Backfill: send the supplier in-app notification and email for a cancelled
 * booking that happened before these notifications were wired up.
 *
 * Usage: node scripts/backfill-supplier-cancel-notification.js [bookingNumber]
 *
 * Reads the booking from the database and sends:
 *   - In-app notification (BOOKING_CANCELLED)
 *   - Supplier cancellation email (free or late template based on refund status)
 *   - Discord sales channel notification
 *
 * The reason and note come from the booking's own columns.
 */
const prisma = require('../src/core/services/prismaClient');
const { enqueueNotification, enqueueEmail } = require('../src/core/services/queue');
const { sendSupplierCustomerCancelledFreeEmail, sendSupplierCustomerCancelledLateEmail } = require('../src/core/services/emailService');
const { notifyDiscord } = require('../src/core/services/discordNotifier');
const { salesBookingCancelled } = require('../src/core/services/channelEmbeds');

const bookingNumber = process.argv[2] || 'EXP-79131408-2026-53';

async function main() {
  console.log(`Looking up booking: ${bookingNumber}`);

  const booking = await prisma.booking.findUnique({
    where: { bookingNumber },
    include: {
      tour: { select: { id: true, title: true, supplierId: true } },
      customer: { select: { id: true, name: true, email: true } },
    },
  });

  if (!booking) {
    console.error(`Booking ${bookingNumber} not found`);
    process.exit(1);
  }

  const tour = booking.tour;
  const customer = booking.customer;
  const refundSucceeded = booking.paymentStatus === 'REFUNDED' && booking.refundedAt;
  const reason = booking.cancellationReason || 'Customer requested cancellation';
  const note = booking.cancellationNote || null;

  console.log(`Tour: ${tour.title}`);
  console.log(`Supplier: ${tour.supplierId}`);
  console.log(`Customer: ${customer.name || '—'} (${customer.email || '—'})`);
  console.log(`Status: ${booking.status}`);
  console.log(`Reason: ${reason}`);
  console.log(`Note: ${note || '—'}`);
  console.log(`Refund: ${refundSucceeded ? 'Issued' : 'Pending/Failed'}`);
  console.log();

  // 1. Supplier in-app notification
  console.log('Sending supplier in-app notification...');
  try {
    await enqueueNotification({
      userId: tour.supplierId,
      type: 'BOOKING_CANCELLED',
      title: `Booking Cancelled: ${tour.title}`,
      message: `Booking ${booking.bookingNumber} was cancelled by the customer. Reason: ${reason}${note ? '. Note: ' + note : ''}`,
      data: { bookingId: booking.id, source: 'expedition' },
    });
    console.log('  In-app notification sent ✓');
  } catch (err) {
    console.error('  In-app notification failed:', err.message);
  }

  // 2. Supplier email — pass the ID, not the object, so
  // resolveBookingContext re-fetches with full includes (tour + supplier +
  // customer). The backfill fetches a minimal booking; passing the object
  // directly would skip the re-fetch and leave supplierRecipientList with
  // an empty supplier — the email would silently go to nobody.
  console.log('Sending supplier email...');
  try {
    const emailFn = refundSucceeded
      ? sendSupplierCustomerCancelledFreeEmail
      : sendSupplierCustomerCancelledLateEmail;
    await emailFn(booking.id, { cancelledAt: booking.cancelledAt });
    console.log('  Supplier email sent ✓');
  } catch (err) {
    console.error('  Supplier email failed:', err.message);
  }

  // 3. Discord sales channel notification
  console.log('Sending Discord sales channel notification...');
  try {
    const notification = salesBookingCancelled({
      bookingNumber: booking.bookingNumber,
      tour: tour.title,
      amount: booking.grossAmount,
      currency: booking.currency,
      reason,
      note: note || undefined,
      customer: customer.name || booking.leadTravelerName || customer.email || '—',
      refundSucceeded,
    });
    await notifyDiscord('sales', notification.content, notification.opts);
    console.log('  Discord notification sent ✓');
  } catch (err) {
    console.error('  Discord notification failed:', err.message);
  }

  console.log('\nDone.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());