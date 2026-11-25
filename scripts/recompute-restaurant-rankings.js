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
 * Order matters: recency first, then the combined/ranking score (which also
 * stores the raw demand score), then the per-city demand flag and the ordinal —
 * both city-wide passes read the scores the previous step just wrote.
 *
 * Every write goes through the stats service, the only writer of those
 * columns. This script adds no aggregation logic of its own, so a manual run
 * and a scheduled run cannot disagree.
 */

const prisma = require('../src/core/services/prismaClient');
const {
  recomputeRecentStats,
  recomputeVenueStats,
  recomputeCityRanks,
  recomputeCityDemand,
  recomputeAllRestaurantRankings,
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

  if (!args.city) {
    const result = await recomputeAllRestaurantRankings();
    console.log(
      `Recomputed ${result.recency} recency window(s), ${result.aggregates} aggregate(s), demand for ${result.demandCities} city/cities, ranked ${result.rankCities} city/cities.`,
    );
    return;
  }

  const recent = await recomputeRecentStats(ids);
  const aggregates = await recomputeVenueStats(ids);
  const demandCities = await recomputeCityDemand(args.city).then(() => 1);
  const cities = await recomputeCityRanks(args.city).then(() => 1);

  console.log(
    `Recomputed ${recent} recency window(s), ${aggregates} aggregate(s), demand for ${demandCities} city/cities, ranked ${cities} city/cities.`,
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
