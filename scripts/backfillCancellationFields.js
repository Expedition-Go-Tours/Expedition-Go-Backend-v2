/**
 * Backfill structured cancellation fields on historical bookings.
 *
 * Run ONCE after the 20260922 migration:
 *   node scripts/backfillCancellationFields.js           (apply)
 *   node scripts/backfillCancellationFields.js --dry-run (report only)
 *
 * Maps every historical cancel into the structured shape so the cancellation
 * rate query (cancellationController.isSupplierCaused) reads the same shape
 * for old and new rows:
 *
 *   origin    ← inferred: keyword heuristic ⇒ SUPPLIER, "customer"/"refund"
 *               status ⇒ CUSTOMER, everything unpaid ⇒ SYSTEM
 *   category  ← keyword heuristic: weather/force majeure ⇒ FORCE_MAJEURE,
 *               customer-requested ⇒ CUSTOMER_REQUESTED, else OPERATIONAL
 *   code      ← best-matching taxonomy code (OPERATIONAL_OTHER /
 *               FORCE_MAJEURE_OTHER / CUSTOMER_REQUESTED_CANCEL when unsure)
 *   counts    ← category rule (OPERATIONAL counts, others don't)
 *   refundStatus ← NOT_APPLICABLE (never paid / no refund) |
 *                  SUCCEEDED (paymentStatus REFUNDED or refundedAt set) |
 *                  PENDING (cancelled + paid + no refund recorded → needs
 *                           manual review; we do NOT invent Stripe refunds)
 *
 * NO RETROACTIVE FEES: historical cancellations never get a SupplierCharge —
 * cancellationFee stays NULL on every backfilled row. This is a data-shape
 * backfill only; it changes no money.
 *
 * Idempotent: only touches rows where cancellationOrigin IS NULL.
 */

const prisma = require('../src/core/services/prismaClient');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 500;

// Legacy keyword heuristic — must stay in sync with the old
// EXCLUDED_REASON_KEYWORDS so historical rates don't shift during the rollout.
const FORCE_MAJEURE_WORDS = ['weather', 'force majeure'];
const CUSTOMER_WORDS = ['customer-requested', 'customer requested', 'customer cancel', 'customer requested cancellation'];

function classify(booking) {
  const reason = (booking.cancellationReason || '').toLowerCase();
  const paid = booking.paymentStatus === 'SUCCEEDED' || booking.paymentStatus === 'REFUNDED';

  // Customer-caused: explicit keyword OR the legacy REFUNDED status flip.
  const customerRequested = CUSTOMER_WORDS.some((w) => reason.includes(w));
  const refundedStatus = booking.status === 'REFUNDED' && !FORCE_MAJEURE_WORDS.some((w) => reason.includes(w));

  if (!paid && !reason) {
    return { origin: 'SYSTEM', category: null, code: 'PAYMENT_NOT_COMPLETED', counts: false };
  }
  if (customerRequested || (refundedStatus && !paid)) {
    return { origin: 'CUSTOMER', category: 'CUSTOMER_REQUESTED', code: 'CUSTOMER_REQUESTED_CANCEL', counts: false };
  }
  if (FORCE_MAJEURE_WORDS.some((w) => reason.includes(w))) {
    return { origin: 'SUPPLIER', category: 'FORCE_MAJEURE', code: 'FORCE_MAJEURE_OTHER', counts: false };
  }
  // Keyword-free customer cancels (refunded but never paid again — historical
  // self-cancels that ended REFUNDED): treat as customer-origin.
  if (booking.status === 'REFUNDED') {
    return { origin: 'CUSTOMER', category: 'CUSTOMER_REQUESTED', code: 'CUSTOMER_REQUESTED_CANCEL', counts: false };
  }
  return { origin: 'SUPPLIER', category: 'OPERATIONAL', code: 'OPERATIONAL_OTHER', counts: true };
}

function refundStateFor(booking) {
  if (booking.paymentStatus !== 'SUCCEEDED') {
    return booking.paymentStatus === 'REFUNDED' ? 'SUCCEEDED' : 'NOT_APPLICABLE';
  }
  if (booking.paymentStatus === 'REFUNDED' || booking.refundedAt) return 'SUCCEEDED';
  // Paid + cancelled with no refund recorded: honest PENDING (needs human
  // review) — we never fabricate a completed refund during a backfill.
  return 'PENDING';
}

async function main() {
  const total = await prisma.booking.count({
    where: { cancellationOrigin: null, status: { in: ['CANCELLED', 'REFUNDED'] } },
  });
  console.log(`[Backfill] ${total} historical cancellations to normalize${DRY_RUN ? ' (dry run)' : ''}`);
  if (total === 0) return;

  let cursor = null;
  let done = 0;
  let counts = { SUPPLIER: 0, CUSTOMER: 0, SYSTEM: 0 };

  while (true) {
    const rows = await prisma.booking.findMany({
      where: { cancellationOrigin: null, status: { in: ['CANCELLED', 'REFUNDED'] } },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        cancellationReason: true,
        refundedAt: true,
      },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const c = classify(row);
      const refundStatus = refundStateFor(row);
      counts[c.origin] += 1;

      if (!DRY_RUN) {
        await prisma.booking.update({
          where: { id: row.id },
          data: {
            cancellationOrigin: c.origin,
            cancellationCategory: c.category,
            cancellationCode: c.code,
            countsTowardRate: c.counts,
            refundStatus,
            // No retroactive fees, ever: cancellationFee stays null.
          },
        });
      }
      done += 1;
      cursor = row.id;
    }
    console.log(`[Backfill] ${done}/${total}…`);
  }

  console.log(
    `[Backfill] ${DRY_RUN ? 'would update' : 'updated'} ${done} bookings ` +
      `(supplier-caused: ${counts.SUPPLIER}, customer: ${counts.CUSTOMER}, system: ${counts.SYSTEM})`
  );
  if (!DRY_RUN) console.log('[Backfill] Done. cancellationOrigin IS NULL should now return 0.');
}

main()
  .catch((err) => {
    console.error('[Backfill] Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
