/**
 * One-off remediation for the `durationMinutes` normalization bug.
 *
 * The dashboard sends categorization.duration as `{ value, unit }`, but the
 * old controller normalization only understood legacy `{ hours|days|weeks|minutes }`
 * keys, leaving `durationMinutes` null (breaking duration filters and public
 * duration display). This backfills the column from the stored blob.
 *
 * It also pauses public exposure of tours whose content is not production-ready
 * (Ghana/Marrakech mismatch + test gibberish on the live "Heights" tour) by
 * setting Tour.status = PAUSED and expeditionTour.isActive = false.
 *
 * Usage (from Backendv2 root):
 *   node prisma/backfillDurationMinutes.js            # apply
 *   node prisma/backfillDurationMinutes.js --dry-run  # preview only
 */
require('dotenv').config();
const prisma = require('../utils/prismaClient');
const { durationToMinutes } = require('../utils/tourHelpers');

const dryRun = process.argv.includes('--dry-run');
const PAUSE_TOURS = ['cms92wn6o002rzhyk6uol6hh0']; // Heights — content not production-ready

function parseCategorization(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

(async () => {
  const tours = await prisma.tour.findMany({
    where: { durationMinutes: null },
    select: { id: true, title: true, status: true, categorization: true },
  });

  const updated = [];

  for (const tour of tours) {
    const cat = parseCategorization(tour.categorization);
    const minutes = durationToMinutes(cat?.duration);
    if (minutes == null) continue;
    updated.push({ id: tour.id, title: tour.title, minutes });

    if (dryRun) continue;
    await prisma.tour.update({ where: { id: tour.id }, data: { durationMinutes: minutes } });
  }

  console.log(`\nTours missing durationMinutes: ${tours.length}`);
  console.log(`Backfillable (categorization.duration present): ${updated.length}`);
  if (updated.length) console.table(updated);

  const paused = await prisma.tour.findMany({
    where: { id: { in: PAUSE_TOURS } },
    select: { id: true, title: true, status: true },
  });
  console.log(`\nPausing public exposure for: ${PAUSE_TOURS.length}`);
  if (paused.length) console.table(paused);

  if (!dryRun) {
    for (const tour of paused) {
      await prisma.tour.update({ where: { id: tour.id }, data: { status: 'PAUSED' } });
      const expedition = await prisma.expeditionTour.findFirst({ where: { tourId: tour.id }, select: { id: true } });
      if (expedition) {
        await prisma.expeditionTour.update({ where: { id: expedition.id }, data: { isActive: false } });
      }
    }
  }

  console.log(dryRun ? '\nDRY RUN — no writes performed' : '\nWrites performed');

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
