/**
 * Backfill card-on-file brand + last4 for reserve-now-pay-later bookings.
 *
 * Run ONCE after the 20261015120000 migration:
 *   node scripts/backfill-payment-method-labels.js            (apply)
 *   node scripts/backfill-payment-method-labels.js --dry-run  (report only)
 *   node scripts/backfill-payment-method-labels.js --force    (refetch filled rows)
 *
 * A pay-later booking stores the Stripe PaymentIntent id but not the card it
 * holds, so every "which card is on file?" question needed a live Stripe call.
 * Re-read the intent (expanding payment_method) and copy brand + last4 onto the
 * booking.
 *
 * Idempotent: a row that already has both brand and last4 is skipped unless
 * --force. Rows whose intent is gone, or that never saved a card, stay NULL and
 * are counted in the summary. No money moves here.
 */
const prisma = require('../src/core/services/prismaClient');
const { getStripe } = require('../src/core/services/stripeHelpers');
const { cardSummaryFromIntent } = require('../src/core/services/stripeCardSummary');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const BATCH = 200;

async function main() {
  const where = {
    paymentTiming: 'later',
    stripePaymentIntentId: { not: null },
    ...(FORCE ? {} : { OR: [{ paymentMethodBrand: null }, { paymentMethodLast4: null }] }),
  };

  const total = await prisma.booking.count({ where });
  console.log(`[Backfill] ${total} pay-later booking(s) to inspect${DRY_RUN ? ' (dry run)' : ''}`);

  let cursor = null;
  let done = 0;
  let filled = 0;
  let missing = 0;

  for (;;) {
    const rows = await prisma.booking.findMany({
      where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { id: true, bookingNumber: true, stripePaymentIntentId: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      let summary = { brand: null, last4: null };
      try {
        const intent = await getStripe().paymentIntents.retrieve(row.stripePaymentIntentId, {
          expand: ['payment_method'],
        });
        summary = cardSummaryFromIntent(intent);
      } catch (err) {
        console.warn(`[Backfill] ${row.bookingNumber}: Stripe lookup failed (${err.message})`);
      }

      if (summary.brand || summary.last4) {
        if (!DRY_RUN) {
          await prisma.booking.update({
            where: { id: row.id },
            data: { paymentMethodBrand: summary.brand, paymentMethodLast4: summary.last4 },
          });
        }
        filled += 1;
      } else {
        missing += 1;
      }

      done += 1;
      cursor = row.id;
    }
    console.log(`[Backfill] ${done}/${total}…`);
  }

  console.log(
    `[Backfill] ${DRY_RUN ? 'would fill' : 'filled'} ${filled} booking(s); ` +
      `${missing} had no recoverable card; ${done} inspected.`
  );
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[Backfill] Failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
