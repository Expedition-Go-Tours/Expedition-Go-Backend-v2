/**
 * One-off, idempotent backfill: ensure every user has a Stripe Customer.
 *
 * A user's Stripe customer is normally created by the async STRIPE queue worker
 * right after signup. If Redis was unavailable at the time (workers never
 * registered / jobs dropped), the customer was never created and checkout
 * would fail. This script closes that gap for existing accounts.
 *
 * Safe to run repeatedly:
 *   - Users with a valid `cus_...` ID are skipped.
 *   - Before creating, it reuses an existing Stripe Customer already linked to
 *     the user (metadata.userId) or an unattached customer on the same email,
 *     so it never creates duplicates.
 *
 * Usage:
 *   node scripts/backfillStripeCustomers.js             # real run
 *   node scripts/backfillStripeCustomers.js --dry-run   # report only, no writes
 *   node scripts/backfillStripeCustomers.js --limit 50  # cap how many users to process
 */
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

const prisma = require('../utils/prismaClient');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  const val = idx > -1 ? parseInt(process.argv[idx + 1], 10) : NaN;
  return Number.isFinite(val) && val > 0 ? val : Infinity;
})();
const CONCURRENCY = 10;

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('[backfill-stripe-customers] STRIPE_SECRET_KEY is required.');
  process.exit(1);
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Reuse an existing Stripe Customer where safe:
 *  1. A customer already tagged with this user's id (metadata.userId) — the
 *     authoritative link (e.g. from a lazy checkout creation).
 *  2. Otherwise an unattached customer on the same email. A shared email
 *     matching a customer that is attached to ANOTHER userId is NOT reused.
 */
async function findExistingCustomer(user) {
  if (!user.email) return null;

  const customers = await stripe.customers.list({ email: user.email, limit: 100 });
  const byUserId = customers.data.find(
    (c) => c.metadata && String(c.metadata.userId) === String(user.id)
  );
  if (byUserId) return byUserId;

  return customers.data.find((c) => !c.metadata || !c.metadata.userId) || null;
}

async function ensureCustomer(user) {
  const existing = await findExistingCustomer(user);
  if (existing) {
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: existing.id },
    });
    return { status: 'reused', id: existing.id };
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: user.id, source: 'backfill' },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });
  return { status: 'created', id: customer.id };
}

async function backfill() {
  const users = await prisma.user.findMany({
    where: { OR: [{ stripeCustomerId: null }, { stripeCustomerId: '' }] },
    select: { id: true, email: true, name: true },
    orderBy: { createdAt: 'asc' },
    take: Number.isFinite(LIMIT) ? LIMIT : undefined,
  });

  const stats = { total: users.length, created: 0, reused: 0, failed: 0, skipped: 0 };

  console.log(
    `[backfill-stripe-customers] ${DRY_RUN ? 'DRY-RUN' : 'RUN'} found ${stats.total} user(s) without a Stripe customer`
  );
  if (stats.total === 0) {
    await prisma.$disconnect();
    return;
  }

  if (DRY_RUN) {
    // Read-only pass: report what WOULD happen without creating anything.
    let idx = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (idx < users.length) {
        const user = users[idx++];
        try {
          const existing = await findExistingCustomer(user);
          stats[existing ? 'reused' : 'created'] += 1;
          console.log(
            `  [dry-run] user=${user.id} -> ${existing ? `reuse ${existing.id}` : 'create new'}`
          );
        } catch (err) {
          stats.failed += 1;
          console.error(`  [dry-run] user=${user.id} lookup failed: ${err.message}`);
        }
      }
    });
    await Promise.all(workers);

    await prisma.$disconnect();
    console.log(
      `[backfill-stripe-customers] dry-run complete: total=${stats.total} wouldCreate=${stats.created} wouldReuse=${stats.reused} lookupFailed=${stats.failed}`
    );
    return;
  }

  let idx = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < users.length) {
      const user = users[idx++];
      try {
        const { status, id } = await ensureCustomer(user);
        stats[status] += 1;
        console.log(`  user=${user.id} ${status} ${id}`);
      } catch (err) {
        stats.failed += 1;
        console.error(`  user=${user.id} failed: ${err.message}`);
      }
    }
  });

  await Promise.all(workers);

  await prisma.$disconnect();
  console.log(
    `[backfill-stripe-customers] complete: total=${stats.total} created=${stats.created} reused=${stats.reused} failed=${stats.failed}`
  );
}

backfill().catch(async (e) => {
  console.error('[backfill-stripe-customers] failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
