/**
 * Backfill: move existing reserve-now-pay-later bookings from CONFIRMED to
 * PENDING so they appear in the supplier "Pending" queue alongside the new
 * pay-later bookings (which are created PENDING from checkout).
 *
 * Only untouched, unpaid reservations are affected — settled or cancelled
 * bookings are left alone. Idempotent; safe to re-run.
 *
 * Usage: node scripts/backfill-pay-later-status.js
 */

const prisma = require('../utils/prismaClient');

async function main() {
  const result = await prisma.$executeRaw`
    UPDATE "Booking"
    SET status = 'PENDING'
    WHERE "paymentTiming" = 'later'
      AND "paymentStatus" IN ('PENDING', 'PROCESSING')
      AND "paidAt" IS NULL
      AND status = 'CONFIRMED'
  `;
  console.log(`Backfill complete: ${result} reserve-now-pay-later booking(s) moved from CONFIRMED to PENDING.`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
