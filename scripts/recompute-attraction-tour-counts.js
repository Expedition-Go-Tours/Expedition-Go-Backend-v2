#!/usr/bin/env node
/**
 * Recompute Attraction.tourCount with alias-aware matching.
 *
 * An itinerary stop ("Boti Waterfalls") and the curated attraction ("Boti
 * Falls") often differ in spelling. Counting with the attraction's name AND its
 * aliases credits it for every tour that actually visits it, and lets the
 * "Top Attractions Nearby" section surface attractions it previously hid.
 *
 *   node scripts/recompute-attraction-tour-counts.js [--dry-run]
 */

const prisma = require('../utils/prismaClient');
const logger = require('../utils/logger');
const { normalizeName, variantsFor } = require('../utils/attractionMatch');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const [attractions, tours] = await Promise.all([
    prisma.attraction.findMany({ select: { id: true, name: true, aliases: true, tourCount: true } }),
    prisma.tour.findMany({ where: { status: 'ACTIVE' }, select: { attractions: true } }),
  ]);

  // Normalized stop names per tour, so each attraction is a single pass.
  const tourStops = tours.map(
    (t) => new Set((t.attractions || []).map(normalizeName).filter(Boolean))
  );

  const updates = [];
  for (const a of attractions) {
    const variants = variantsFor(a).map(normalizeName).filter(Boolean);
    if (variants.length === 0) continue;

    let count = 0;
    for (const stops of tourStops) {
      if (variants.some((v) => stops.has(v))) count += 1;
    }

    if (count !== (a.tourCount || 0)) {
      updates.push({ id: a.id, name: a.name, from: a.tourCount || 0, to: count });
    }
  }

  logger.info(
    `[recompute-attraction-tour-counts] ${updates.length} of ${attractions.length} attractions change` +
      `${dryRun ? ' (dry-run)' : ''}`
  );
  for (const u of updates.slice(0, 40)) logger.info(`  ${u.from} -> ${u.to}  ${u.name}`);
  if (updates.length > 40) logger.info(`  ... and ${updates.length - 40} more`);

  if (dryRun) return;

  for (const u of updates) {
    await prisma.attraction.update({
      where: { id: u.id },
      data: { tourCount: u.to, lastComputedAt: new Date() },
    });
  }
  logger.info(`[recompute-attraction-tour-counts] applied ${updates.length} updates`);
}

main()
  .catch((err) => {
    logger.error(`[recompute-attraction-tour-counts] failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(process.exitCode || 0);
  });
