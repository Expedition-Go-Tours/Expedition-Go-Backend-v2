/**
 * One-off remediation for live tours whose derived `schedules[].prices` is
 * empty/stale (the server-authoritative prices fix).
 *
 * - Backfills `prices` on every ACTIVE tour via rebuildSchedulePrices (the
 *   same helper updateTour/createTour now run on write).
 * - Unpublishes (PAUSED) any ACTIVE tour that has no source-of-truth price at
 *   all, so it can never be priced at $0.
 * - Clears the dev-changelog "Product builder Phase 1" description on the
 *   known "Tower" tour so dev text stops showing publicly.
 *
 * Usage (from Backendv2 root):
 *   node prisma/backfillTourPrices.js            # apply
 *   node prisma/backfillTourPrices.js --dry-run  # preview only
 */
require('dotenv').config();
const prisma = require('../utils/prismaClient');
const { rebuildSchedulePrices } = require('../utils/tourHelpers');

const dryRun = process.argv.includes('--dry-run');
const TOWER_ID = 'cmrypuex70001117qmysomznp';

function parseBlob(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

function isEmptyPrices(blob) {
  const schedules = blob?.pricingSchedules?.schedules;
  if (!Array.isArray(schedules) || schedules.length === 0) return true;
  return schedules.every((s) => !Array.isArray(s?.prices) || s.prices.length === 0);
}

(async () => {
  const tours = await prisma.tour.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, title: true, status: true, description: true, schedulesAndPricing: true },
  });

  const backfilled = [];
  const unpublish = [];
  const scrubbed = [];

  for (const tour of tours) {
    const blob = parseBlob(tour.schedulesAndPricing);
    if (!blob) {
      unpublish.push({ id: tour.id, title: tour.title, reason: 'no pricing blob' });
      continue;
    }

    const beforeEmpty = isEmptyPrices(blob);
    const rebuilt = rebuildSchedulePrices(blob);
    const afterEmpty = isEmptyPrices(rebuilt);

    if (beforeEmpty && afterEmpty) {
      unpublish.push({ id: tour.id, title: tour.title, reason: 'no source-of-truth price' });
      continue;
    }
    if (beforeEmpty && !afterEmpty) {
      backfilled.push({ id: tour.id, title: tour.title });
    }

    const scrubDesc = tour.id === TOWER_ID
      && typeof tour.description === 'string'
      && /product builder phase 1/i.test(tour.description);
    if (scrubDesc) {
      scrubbed.push({ id: tour.id, title: tour.title });
    }

    if (dryRun) continue;

    const data = { schedulesAndPricing: rebuilt };
    if (scrubDesc) data.description = '';
    await prisma.tour.update({ where: { id: tour.id }, data });
  }

  console.log(`\nTotal ACTIVE tours scanned: ${tours.length}`);
  console.log(`Backfilled prices: ${backfilled.length}`);
  if (backfilled.length) console.table(backfilled);
  console.log(`Unpublishing (no price source): ${unpublish.length}`);
  if (unpublish.length) console.table(unpublish);
  console.log(`Scrubbed changelog description: ${scrubbed.length}`);
  if (scrubbed.length) console.table(scrubbed);
  console.log(dryRun ? '\nDRY RUN — no writes performed' : '\nWrites performed');

  if (!dryRun) {
    for (const u of unpublish) {
      await prisma.tour.update({ where: { id: u.id }, data: { status: 'PAUSED' } });
    }
  }

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
