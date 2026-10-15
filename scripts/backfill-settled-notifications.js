/**
 * Backfill: re-emit the settlement notifications for bookings whose
 * confirmation emails / #sales Discord embed were never sent.
 *
 * Background — the pay-later race fixed in
 * src/core/services/stripeHelpers.js (notifyBookingsSettled): a reserve-now-
 * pay-later booking charged by the sweep (or admin "charge now", or booking
 * cleanup) settled the PaymentIntent *before* Stripe's
 * `payment_intent.succeeded` webhook arrived. The webhook then matched 0 rows
 * and skipped its post-commit side effects, so the customer and supplier never
 * received their "reservation charged" emails and #sales never got the
 * "New Booking Confirmed" embed. The DB state (paid, CONFIRMED, capacity) was
 * always correct — only the notifications were lost.
 *
 * This script re-runs exactly that side-effect set (customer email, supplier
 * email, #sales embed, admin "booking confirmed" alert, booking.completed
 * analytics) for the bookings you name. It performs NO database writes, so it
 * cannot double-charge, double-increment capacity, or alter booking state.
 *
 * Usage:
 *   node scripts/backfill-settled-notifications.js TRG-64945817-2026-13
 *   node scripts/backfill-settled-notifications.js BK-001 BK-002
 *   node scripts/backfill-settled-notifications.js --since 2026-10-01
 *
 * The `--since` form targets every SUCCEEDED pay-later booking paid on/after
 * the given date. It is an explicit opt-in and may re-send notifications for
 * bookings that were NEVER affected, so prefer naming the specific booking(s)
 * unless you have confirmed the whole window is missing its notifications.
 */
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

const prisma = require('../src/core/services/prismaClient');
const { notifyBookingsSettled } = require('../src/core/services/stripeHelpers');
const { closeAll } = require('../src/core/services/queue');

const BOOKING_INCLUDE = {
  customer: true,
  tour: { include: { supplier: true } },
};

function parseArgs(argv) {
  const sinceIdx = argv.indexOf('--since');
  const since = sinceIdx !== -1 ? argv[sinceIdx + 1] : null;
  if (sinceIdx !== -1 && !since) {
    throw new Error('--since requires an ISO date, e.g. --since 2026-10-01');
  }
  const numbers = argv.filter((arg, i) => !arg.startsWith('--') && i !== sinceIdx + 1);
  return { since, numbers };
}

async function resolveBookings({ since, numbers }) {
  if (since) {
    const paidAt = new Date(since);
    if (Number.isNaN(paidAt.getTime())) {
      throw new Error(`Invalid --since date: ${since}`);
    }
    return prisma.booking.findMany({
      where: {
        paymentTiming: 'later',
        paymentStatus: 'SUCCEEDED',
        paidAt: { gte: paidAt },
      },
      include: BOOKING_INCLUDE,
      orderBy: { paidAt: 'asc' },
    });
  }

  if (numbers.length === 0) {
    throw new Error('Pass at least one booking number, or --since <ISO date>.');
  }

  return prisma.booking.findMany({
    where: { bookingNumber: { in: numbers } },
    include: BOOKING_INCLUDE,
  });
}

async function main() {
  const bookings = await resolveBookings(parseArgs(process.argv.slice(2)));

  if (bookings.length === 0) {
    console.log('[backfill-settled-notifications] No matching bookings.');
    return;
  }

  console.log(`[backfill-settled-notifications] Re-sending settlement notifications for ${bookings.length} booking(s):`);
  for (const b of bookings) {
    const paidAt = b.paidAt ? b.paidAt.toISOString() : '—';
    console.log(`  • ${b.bookingNumber}  paidAt=${paidAt}  paymentStatus=${b.paymentStatus}  timing=${b.paymentTiming}`);
  }

  notifyBookingsSettled(bookings, { source: 'backfill' });

  console.log('[backfill-settled-notifications] Enqueued. Verify delivery in the email provider and #sales, then exit.');
  // Give BullMQ/Redis a moment to flush the enqueued jobs before shutdown.
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

main()
  .catch((err) => {
    console.error('[backfill-settled-notifications] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAll().catch(() => {});
    await prisma.$disconnect();
  });
