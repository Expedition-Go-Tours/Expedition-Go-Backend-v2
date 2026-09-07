/**
 * One-time data repair: repoint users whose stored stripeCustomerId points to a
 * different Stripe account than the server's current STRIPE_SECRET_KEY.
 *
 * Background: the server's Stripe key was switched from the legacy TravioAfrica
 * test account (acct_1MCqH…) to the current one (acct_1UBbKx…) around June 2026.
 * Users whose Stripe customer was created before the switch still hold a cus_ id
 * from the OLD account. Any pay-later checkout then fails with
 * "No such customer: 'cus_…'" because createPaymentIntent (until the companion
 * code fix) had no repair path.
 *
 * This script:
 *   1. Loads every user that has a stripeCustomerId.
 *   2. Verifies each id resolves on the CURRENT account (customers.retrieve).
 *   3. For ids that are missing/deleted, creates a fresh customer on the current
 *      account (same email/name/metadata) and persists the new id on the User row.
 *
 * It never touches customers that still resolve. Run it AFTER deploying the
 * createPaymentIntent repair as belt-and-braces so pay-later works first try.
 *
 * Usage: node scripts/repair-stale-stripe-customers.js
 * Dry run: DRY_RUN=1 node scripts/repair-stale-stripe-customers.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const DRY_RUN = process.env.DRY_RUN === '1';

function customerMissing(err) {
  return err && (err.raw?.code === 'resource_missing' || /No such customer/i.test(String(err.message || '')));
}

(async () => {
  const users = await p.user.findMany({
    where: { stripeCustomerId: { not: null } },
    select: { id: true, email: true, name: true, stripeCustomerId: true },
  });

  console.log(`Found ${users.length} user(s) with a stored stripeCustomerId${DRY_RUN ? ' (DRY RUN)' : ''}`);
  let repaired = 0;
  let ok = 0;
  let errors = 0;

  for (const u of users) {
    const cus = u.stripeCustomerId;
    try {
      const existing = await stripe.customers.retrieve(cus);
      if (existing.deleted) throw Object.assign(new Error(`Customer ${cus} is deleted`), { raw: { code: 'resource_missing' } });
      console.log(`  OK      ${u.email || u.id} -> ${cus}`);
      ok += 1;
      continue;
    } catch (err) {
      if (!customerMissing(err)) {
        console.error(`  ERROR   ${u.email || u.id}: ${err.message} (not a missing-customer error — skipped)`);
        errors += 1;
        continue;
      }
    }

    // Customer no longer exists on the current account — create a fresh one.
    console.log(`  STALE   ${u.email || u.id}: ${cus} missing on current account${DRY_RUN ? ' (would repair)' : ''}`);
    if (DRY_RUN) continue;

    try {
      const fresh = await stripe.customers.create({
        ...(u.email ? { email: u.email } : {}),
        ...(u.name ? { name: u.name } : {}),
        metadata: { userId: u.id, source: 'repair_stale_customer' },
      });
      await p.user.update({ where: { id: u.id }, data: { stripeCustomerId: fresh.id } });
      console.log(`    -> new ${fresh.id}`);
      repaired += 1;
    } catch (createErr) {
      console.error(`    FAILED to create fresh customer for ${u.email || u.id}: ${createErr.message}`);
      errors += 1;
    }
  }

  console.log(`\nDone: ${ok} ok, ${repaired} repaired, ${errors} errors${DRY_RUN ? ' (DRY RUN — nothing changed)' : ''}`);
  await p.$disconnect();
})().catch(async (e) => {
  console.error('Fatal:', e.message);
  await p.$disconnect().catch(() => {});
  process.exit(1);
});
