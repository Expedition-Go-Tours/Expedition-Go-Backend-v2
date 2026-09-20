#!/usr/bin/env node
/**
 * Backfill Tour.destinationCity (see utils/destinationCities.js).
 *
 * Run after the add_tour_destination_city migration, and again whenever the
 * curated attractions XLSX or the region → capital map changes.
 *
 *   node scripts/backfill-destination-city.js [--dry-run]
 */

const prisma = require('../src/core/services/prismaClient');
const logger = require('../src/core/services/logger');
const { buildMajorCityIndex, destinationCityFor } = require('../src/core/services/destinationCities');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const index = await buildMajorCityIndex();
  const tours = await prisma.tour.findMany({
    select: {
      id: true,
      title: true,
      city: true,
      region: true,
      country: true,
      itineraryRegions: true,
      latitude: true,
      longitude: true,
      attractions: true,
      destinationCity: true,
    },
  });

  const updates = [];
  for (const tour of tours) {
    const next = destinationCityFor(tour, index);
    if (next !== (tour.destinationCity ?? null)) {
      updates.push({ id: tour.id, title: tour.title, from: tour.destinationCity, to: next });
    }
  }

  logger.info(
    `[backfill-destination-city] ${updates.length} of ${tours.length} tour(s) change${dryRun ? ' (dry-run)' : ''}`
  );
  for (const u of updates.slice(0, 40)) {
    logger.info(`  ${u.from || '(none)'} -> ${u.to || '(none)'}  ${u.title}`);
  }
  if (updates.length > 40) logger.info(`  ... and ${updates.length - 40} more`);

  if (dryRun) return;

  for (const u of updates) {
    await prisma.tour.update({ where: { id: u.id }, data: { destinationCity: u.to } });
  }
  logger.info(`[backfill-destination-city] applied ${updates.length} update(s)`);
}

main()
  .catch((err) => {
    logger.error(`[backfill-destination-city] failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(process.exitCode || 0);
  });
