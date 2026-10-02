#!/usr/bin/env node
/**
 * Backfill: re-send the Discord sales channel notification for a cancelled
 * booking with the proper cancellation details.
 *
 * Usage: node scripts/backfill-cancel-notification.js [bookingNumber]
 *
 * Reads the booking from the database and sends the cancellation embed
 * to the Discord sales channel with full details (customer, reason, etc.)
 */
const prisma = require('../src/core/services/prismaClient');
const { notifyDiscord } = require('../src/core/services/discordNotifier');
const { salesBookingCancelled } = require('../src/core/services/channelEmbeds');

const bookingNumber = process.argv[2] || 'EXP-79131408-2026-53';

async function main() {
  console.log(`Looking up booking: ${bookingNumber}`);

  const booking = await prisma.booking.findUnique({
    where: { bookingNumber },
    include: {
      tour: { select: { title: true } },
      customer: { select: { name: true, email: true } },
    },
  });

  if (!booking) {
    console.error(`Booking ${bookingNumber} not found`);
    process.exit(1);
  }

  console.log(`Found: ${booking.tour.title}`);
  console.log(`Customer: ${booking.customer.name || booking.leadTravelerName || '—'} (${booking.customer.email || '—'})`);
  console.log(`Status: ${booking.status}`);
  console.log(`Reason: ${booking.cancellationReason || '—'}`);
  console.log(`Refund: ${booking.refundStatus || '—'}`);
  console.log(`Amount: ${booking.currency} ${booking.grossAmount}`);

  const refundSucceeded = booking.paymentStatus === 'REFUNDED' && booking.refundedAt;

  const notification = salesBookingCancelled({
    bookingNumber: booking.bookingNumber,
    tour: booking.tour.title,
    amount: booking.grossAmount,
    currency: booking.currency,
    reason: booking.cancellationReason || 'Customer requested cancellation',
    note: booking.cancellationNote || undefined,
    customer: booking.customer.name || booking.leadTravelerName || booking.customer.email || '—',
    refundSucceeded,
  });

  console.log('\nSending to Discord sales channel...');
  console.log('Content:', notification.content);
  console.log('Fields:');
  for (const f of notification.opts.fields) {
    console.log(`  ${f.name}: ${f.value}`);
  }

  try {
    await notifyDiscord('sales', notification.content, notification.opts);
    console.log('\n✅ Sent successfully');
  } catch (err) {
    console.error('\n❌ Failed:', err.message);
    process.exit(1);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
