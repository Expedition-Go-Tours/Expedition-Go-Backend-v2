/**
 * Backfill automated payout schedules for Ghana suppliers.
 *
 * A value in SupplierProfile.payoutCycle enrols the supplier in automated
 * payout runs (weekly / twice a month / monthly). Until now every supplier has
 * been on the legacy twice-monthly manual withdrawal windows, so this script
 * enrols the Ghana supplier base onto the schedule feature — using the same
 * `isGhanaSupplier` signal the auto-publish pipeline uses, so the enrolled set
 * matches exactly the suppliers whose dashboard is TravioGhana.
 *
 * Non-Ghana (TravioAfrica) suppliers are deliberately left untouched: they keep
 * the manual withdrawal windows until their dashboard adopts the feature.
 *
 * Usage:
 *   node scripts/backfill-payout-cycles.js --dry-run   # report only, no writes
 *   node scripts/backfill-payout-cycles.js             # apply
 *   node scripts/backfill-payout-cycles.js --all       # every approved supplier
 *   node scripts/backfill-payout-cycles.js --cycle=MONTHLY
 */
const prisma = require('../src/core/services/prismaClient');
const { isGhanaSupplier } = require('../src/core/services/supplierCountry');
const { getDefaultCycle, VALID_CYCLES } = require('../src/core/services/payoutRuns');

const DRY_RUN = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');
const cycleArg = (process.argv.find((a) => a.startsWith('--cycle=')) || '').split('=')[1];

async function main() {
  const cycle = cycleArg ? String(cycleArg).toUpperCase() : await getDefaultCycle();
  if (!VALID_CYCLES.includes(cycle)) {
    console.error(`Invalid --cycle "${cycleArg}". Expected one of ${VALID_CYCLES.join(', ')}`);
    process.exit(1);
  }

  const candidates = await prisma.supplierProfile.findMany({
    // APPROVED (admin-approved) and ACTIVE (fully verified, can receive
    // payouts) are the payable states. Suspended/rejected/expired suppliers are
    // deliberately never enrolled.
    where: { status: { in: ['APPROVED', 'ACTIVE'] }, payoutCycle: null },
    select: {
      id: true,
      userId: true,
      businessInfo: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const targets = candidates.filter(
    (p) => ALL || isGhanaSupplier(p.businessInfo?.country)
  );

  console.log(
    `Payout schedule backfill ${DRY_RUN ? '(DRY RUN — no writes)' : ''}\n` +
      `  cadence: ${cycle}\n` +
      `  payable suppliers without a schedule: ${candidates.length}\n` +
      `  to enrol: ${targets.length}${ALL ? ' (--all)' : ' (Ghana-based only)'}`
  );

  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const t of targets) {
    console.log(`  • ${t.user?.email || t.userId} (${t.user?.name || 'unnamed'}) → ${cycle}`);
  }

  if (DRY_RUN) {
    console.log('\nRe-run without --dry-run to apply.');
    return;
  }

  const result = await prisma.supplierProfile.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { payoutCycle: cycle, payoutCycleEffectiveAt: new Date() },
  });

  console.log(`\nEnrolled ${result.count} supplier(s) on the ${cycle} schedule.`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
