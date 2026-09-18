/**
 * One-off, idempotent backfill: make every saved card redisplayable.
 *
 * The Payment Element only offers a customer's saved card when the
 * PaymentMethod has `allow_redisplay: 'always'`. Cards saved before the app
 * started passing that flag are stored as `'unspecified'` — attached to the
 * customer but hidden at checkout. This script upgrades them.
 *
 * Iterates the app's users (those with a Stripe customer) and their cards.
 * Safe to run repeatedly (cards already `'always'` are skipped).
 *
 * Usage:
 *   node scripts/backfill-allow-redisplay.js             # real run
 *   node scripts/backfill-allow-redisplay.js --dry-run   # report only, no writes
 */
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

const prisma = require('../utils/prismaClient');

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('[backfill-allow-redisplay] STRIPE_SECRET_KEY is required.');
  process.exit(1);
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

(async () => {
  let users = 0;
  let scanned = 0;
  let updated = 0;
  let failed = 0;

  try {
    const rows = await prisma.user.findMany({
      where: { stripeCustomerId: { not: null } },
      select: { id: true, email: true, stripeCustomerId: true },
    });

    for (const user of rows) {
      users += 1;
      let methods;
      try {
        methods = await stripe.paymentMethods.list({ customer: user.stripeCustomerId, type: 'card' });
      } catch (err) {
        if (err.code === 'resource_missing') {
          console.warn(`[backfill-allow-redisplay] stale customer ${user.stripeCustomerId} (user ${user.id}) — skipped`);
          continue;
        }
        failed += 1;
        console.warn(`[backfill-allow-redisplay] could not list cards for user ${user.id}:`, err.message);
        continue;
      }

      for (const pm of methods.data || []) {
        scanned += 1;
        if (pm.allow_redisplay === 'always') continue;

        if (DRY_RUN) {
          console.log(`[dry-run] would upgrade ${pm.id} (${pm.card?.brand} ****${pm.card?.last4}) from ${pm.allow_redisplay}`);
          updated += 1;
          continue;
        }

        try {
          await stripe.paymentMethods.update(pm.id, { allow_redisplay: 'always' });
          updated += 1;
        } catch (err) {
          failed += 1;
          console.warn(`[backfill-allow-redisplay] could not update ${pm.id}:`, err.message);
        }
      }
    }

    console.log(`[backfill-allow-redisplay] done users=${users} scanned=${scanned} updated=${updated} failed=${failed} dryRun=${DRY_RUN}`);
    process.exit(0);
  } catch (err) {
    console.error('[backfill-allow-redisplay] fatal:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
})();
