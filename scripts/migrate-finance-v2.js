/* eslint-disable no-console */
/**
 * Finance v2 migration — backfills Booking.payoutStatus and converts legacy
 * auto-created Payout rows into the new request-based flow.
 *
 * Usage:
 *   node scripts/migrate-finance-v2.js --dry-run   # report only, no writes
 *   node scripts/migrate-finance-v2.js             # apply changes
 *
 * Steps:
 *  1. Backfill Booking.payoutStatus:
 *     - CANCELLED/REFUNDED bookings                       → CANCELLED
 *     - paid + confirmed/completed, travelDate < today    → ELIGIBLE
 *     - paid + confirmed/completed, travelDate >= today   → PENDING
 *  2. Legacy ledger reconciliation:
 *     - legacy PAID payouts        → booking.payoutStatus = PAID
 *     - legacy open payouts (PENDING/APPROVED/PROCESSING) are grouped into one
 *       backfill PayoutRequest per supplier+currency (status PROCESSING) and
 *       the legacy rows are marked CANCELLED with a migration note.
 */
const prisma = require('../utils/prismaClient');

const DRY_RUN = process.argv.includes('--dry-run');

function toNumber(v) {
  return v == null ? 0 : parseFloat(v);
}

async function backfillPayoutStatus() {
  const now = new Date();

  const cancelled = await prisma.booking.updateMany({
    where: { status: { in: ['CANCELLED', 'REFUNDED'] }, payoutStatus: 'PENDING' },
    data: { payoutStatus: 'CANCELLED' },
  });

  const eligible = await prisma.booking.updateMany({
    where: {
      payoutStatus: 'PENDING',
      paymentStatus: 'SUCCEEDED',
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      travelDate: { lt: now },
    },
    data: { payoutStatus: 'ELIGIBLE' },
  });

  const stillPending = await prisma.booking.count({
    where: {
      payoutStatus: 'PENDING',
      paymentStatus: 'SUCCEEDED',
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      travelDate: { gte: now },
    },
  });

  console.log(`[migrate] payoutStatus backfill: ${cancelled.count} → CANCELLED, ${eligible.count} → ELIGIBLE, ${stillPending} remain PENDING (travel date in future)`);
  return { cancelled: cancelled.count, eligible: eligible.count };
}

async function reconcileLegacyPayouts() {
  // 1. Legacy PAID payouts → mark bookings PAID
  const paidPayouts = await prisma.payout.findMany({
    where: { status: 'PAID' },
    select: { bookingId: true },
  });
  const paidBookingIds = [...new Set(paidPayouts.map((p) => p.bookingId))];

  if (!DRY_RUN && paidBookingIds.length > 0) {
    await prisma.booking.updateMany({
      where: { id: { in: paidBookingIds }, payoutStatus: { in: ['ELIGIBLE', 'PENDING'] } },
      data: { payoutStatus: 'PAID' },
    });
  }
  console.log(`[migrate] legacy PAID payouts: ${paidBookingIds.length} booking(s) marked PAID`);

  // 2. Open legacy payouts → one backfill PayoutRequest per supplier+currency
  const openPayouts = await prisma.payout.findMany({
    where: { status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] } },
    include: {
      booking: { select: { id: true, grossAmount: true, platformCommission: true, supplierPayout: true, currency: true } },
    },
  });

  if (openPayouts.length === 0) {
    console.log('[migrate] legacy open payouts: none');
    return;
  }

  const groups = {};
  for (const p of openPayouts) {
    if (!p.booking) continue;
    const key = `${p.supplierId}:${p.currency}`;
    (groups[key] = groups[key] || []).push(p);
  }

  for (const [key, payouts] of Object.entries(groups)) {
    const [supplierId, currency] = key.split(':');
    const amount = payouts.reduce((s, p) => s + toNumber(p.amount), 0);
    console.log(`[migrate] supplier ${supplierId} (${currency}): ${payouts.length} legacy payout(s), total ${amount.toFixed(2)} → backfill PayoutRequest`);

    if (DRY_RUN) continue;

    const ts = Date.now().toString().slice(-6);
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    await prisma.$transaction(async (tx) => {
      const request = await tx.payoutRequest.create({
        data: {
          requestNumber: `PR-MIGRATED-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${ts}${rand}`,
          supplierId,
          amount,
          currency,
          bookingCount: payouts.length,
          status: 'PROCESSING',
          cycleStartDate: payouts[0].createdAt,
          cycleEndDate: new Date(),
          cycleLabel: 'Migrated (pre finance v2)',
          notes: 'Auto-migrated from legacy per-booking payout queue',
          items: {
            create: payouts.map((p) => ({
              bookingId: p.booking.id,
              grossAmount: p.booking.grossAmount,
              platformCommission: p.booking.platformCommission,
              supplierPayout: p.booking.supplierPayout,
              currency,
            })),
          },
        },
      });

      await tx.payout.updateMany({
        where: { id: { in: payouts.map((p) => p.id) } },
        data: { status: 'CANCELLED', notes: `Migrated to PayoutRequest ${request.requestNumber}` },
      });

      await tx.booking.updateMany({
        where: { id: { in: payouts.map((p) => p.booking.id) }, payoutStatus: { in: ['ELIGIBLE', 'PENDING'] } },
        data: { payoutStatus: 'REQUESTED' },
      });
    });
  }
}

async function main() {
  console.log(`[migrate] Finance v2 migration starting${DRY_RUN ? ' (DRY RUN)' : ''}...`);
  try {
    await backfillPayoutStatus();
    await reconcileLegacyPayouts();
    console.log('[migrate] Done.');
  } catch (err) {
    console.error('[migrate] FAILED:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
