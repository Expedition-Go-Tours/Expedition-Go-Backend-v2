/**
 * Cancellation routing audit — read-only.
 *
 * Recomputes, from live data, which cancellation email every recently
 * cancelled booking would receive under `resolveCancellationOutcome`, and
 * prints the old-vs-new routing so a deploy can be checked against real
 * bookings instead of assumptions. Sends nothing and writes nothing.
 *
 * Usage:
 *   node scripts/auditCancellationRouting.js            # last 60 days
 *   node scripts/auditCancellationRouting.js --days 180
 *   node scripts/auditCancellationRouting.js --json
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const prisma = require('../src/core/services/prismaClient');
const { resolveCancellationOutcome } = require('../src/core/services/cancellationOutcome');

/**
 * What the pre-acd4cde routing would have picked. Kept here so the audit can
 * show what actually changed, not just what is now true.
 */
function legacyKeys(booking) {
  const refunded = Number(booking.refundAmount) > 0 || booking.paymentStatus === 'REFUNDED';
  return {
    customer: refunded ? 'customer-cancelled-full-refund' : 'customer-cancelled-no-refund',
    supplier: refunded ? 'supplier-customer-cancelled-free' : 'supplier-customer-cancelled-late',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const days = Number((args.find((a) => a.startsWith('--days')) || '').split('=')[1]
    || args[args.indexOf('--days') + 1]
    || 60);
  const asJson = args.includes('--json');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const bookings = await prisma.booking.findMany({
    where: { status: 'CANCELLED', cancelledAt: { gte: since } },
    include: { tour: { include: { supplier: { select: { id: true, name: true } } } } },
    orderBy: { cancelledAt: 'desc' },
  });

  const rows = bookings.map((b) => {
    const outcome = resolveCancellationOutcome(b, b.tour || {}, {});
    const legacy = legacyKeys(b);
    return {
      bookingNumber: b.bookingNumber,
      cancelledAt: b.cancelledAt ? b.cancelledAt.toISOString().slice(0, 16).replace('T', ' ') : '—',
      origin: b.cancellationOrigin || '(none)',
      code: b.cancellationCode || '',
      paymentStatus: b.paymentStatus || '—',
      refundStatus: b.refundStatus || '—',
      policy: outcome.policyType,
      isLate: outcome.isLate,
      branch: outcome.branch,
      customer: outcome.customerTemplateKey,
      supplier: outcome.supplierTemplateKey,
      legacyCustomer: legacy.customer,
      legacySupplier: legacy.supplier,
      changed: legacy.customer !== outcome.customerTemplateKey || legacy.supplier !== outcome.supplierTemplateKey,
    };
  });

  const counts = rows.reduce((acc, r) => {
    acc[r.branch] = (acc[r.branch] || 0) + 1;
    return acc;
  }, {});
  const misrouted = rows.filter((r) => r.changed);
  const lateCount = rows.filter((r) => r.isLate).length;

  if (asJson) {
    console.log(JSON.stringify({ since: since.toISOString(), total: rows.length, counts, rows }, null, 2));
  } else {
    console.log(`\nCancellations since ${since.toISOString().slice(0, 10)} — ${rows.length} booking(s)\n`);
    console.log('Branch counts:', JSON.stringify(counts));
    console.log(`Genuinely late: ${lateCount}   Routed differently than before: ${misrouted.length}\n`);
    const header = ['booking', 'cancelled', 'origin', 'payment', 'refund', 'late', 'branch', 'customer template'];
    const widths = [22, 18, 11, 10, 14, 5, 14, 36];
    console.log(header.map((h, i) => h.padEnd(widths[i])).join(''));
    for (const r of rows) {
      const cells = [r.bookingNumber, r.cancelledAt, r.origin, r.paymentStatus, r.refundStatus, r.isLate ? 'YES' : 'no', r.branch, r.customer];
      console.log(cells.map((c, i) => String(c).slice(0, widths[i] - 1).padEnd(widths[i])).join(''));
    }
    console.log('\nMisrouted before (these now go somewhere else):\n');
    for (const r of misrouted) {
      console.log(`  ${r.bookingNumber}  ${r.legacyCustomer} → ${r.customer}   |   ${r.legacySupplier} → ${r.supplier}`);
    }
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Audit failed:', err.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
