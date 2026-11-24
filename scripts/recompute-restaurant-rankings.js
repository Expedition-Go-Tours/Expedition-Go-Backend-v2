#!/usr/bin/env node
/**
 * Recompute restaurant venue aggregates and city rankings.
 *
 * Usage:
 *   node scripts/recompute-restaurant-rankings.js
 *   node scripts/recompute-restaurant-rankings.js --city Accra
 *   node scripts/recompute-restaurant-rankings.js --dry-run
 *
 * Why this is a job and not a request:
 *   - the 12-month recency window needs a GROUP BY over review rows;
 *   - the ordinal rank ("#8 of 143 in Osu") changes when *other* venues get
 *     reviews, so it cannot be derived from one venue's data;
 *   - Tripadvisor recalculates its ranking daily, which is the right cadence
 *     for something travellers read as a league table.
 *
 * Order matters: recency first, then the combined/ranking score, then the
 * ordinal — the rank sorts on the score the previous step just wrote.
 *
 * Every write goes through recomputeVenueStats()/recomputeCityRanks(), the
 * only writers of those columns. This script adds no aggregation logic of its
 * own, so a manual run and a scheduled run cannot disagree.
 */

const prisma = require('../src/core/services/prismaClient');
const {
  recomputeRecentStats,
  recomputeVenueStats,
  recomputeCityRanks,
  recomputeAllCityRanks,
} = require('../src/core/services/restaurantVenueStats');

function parseArgs(argv) {
  const args = { city: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--city') args.city = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: node scripts/recompute-restaurant-rankings.js [--city <name>] [--dry-run]',
    );
    return;
  }

  const where = { status: 'ACTIVE' };
  if (args.city) where.city = { equals: args.city, mode: 'insensitive' };

  const venues = await prisma.restaurantVenue.findMany({ where, select: { id: true } });
  const ids = venues.map((venue) => venue.id);

  if (ids.length === 0) {
    console.log(`No active venues${args.city ? ` in ${args.city}` : ''}.`);
    return;
  }

  if (args.dryRun) {
    console.log(`Would recompute ${ids.length} venue(s)${args.city ? ` in ${args.city}` : ''}.`);
    return;
  }

  const recent = await recomputeRecentStats(ids);
  const aggregates = await recomputeVenueStats(ids);
  const cities = args.city
    ? await recomputeCityRanks(args.city).then(() => 1)
    : await recomputeAllCityRanks();

  console.log(
    `Recomputed ${recent} recency window(s), ${aggregates} aggregate(s), ranked ${cities} city/cities.`,
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
