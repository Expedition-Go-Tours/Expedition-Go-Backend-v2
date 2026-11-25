#!/usr/bin/env node
/**
 * Seed the data behind the restaurant homepage rails.
 *
 * DEMO / STAGING ONLY. This script writes approved reviews and live-looking
 * offers into the database. It refuses to run unless NODE_ENV is `development`
 * or `staging`, and even there it only touches venues already listed on Ghana.
 *
 * Usage:
 *   NODE_ENV=development node scripts/seed-restaurant-home.js
 *   NODE_ENV=staging node scripts/seed-restaurant-home.js --limit 4
 *   node scripts/seed-restaurant-home.js --dry-run
 *
 * Idempotent: authors, reviews and offers use fixed keys, so re-running
 * updates the same rows instead of stacking duplicates. Review aggregates and
 * demand flags are rebuilt from the stored rows at the end, never computed on
 * a request.
 */

const prisma = require('../src/core/services/prismaClient');
const cache = require('../src/core/services/cacheHelper');
const { rebuildVenueRating } = require('../src/core/services/restaurantVenueRatings');
const { recomputeAllCityDemand, recomputeAllCityRanks } = require('../src/core/services/restaurantVenueStats');

const DEMO_ENVIRONMENTS = ['development', 'staging'];
const VISIT_KEY = 'seed-home';
const BRAND = 'ghana';

const DINERS = [
  {
    email: 'seed-home-diner-1@travio.test',
    name: 'Seed Diner One',
    photoURL: '',
    rating: 5,
    title: 'Booked out for a reason',
    body: 'The place was full by seven and the queue moved quickly. Jollof was smoky, the service was warm, and the whole room had a buzz. Worth booking ahead.',
  },
  {
    email: 'seed-home-diner-2@travio.test',
    name: 'Seed Diner Two',
    photoURL: '',
    rating: 5,
    title: 'Exactly the Accra night I wanted',
    body: 'Lively without being chaotic. We arrived early, got a table by the window, and stayed for dessert. The staff knew the menu properly and made good recommendations.',
  },
  {
    email: 'seed-home-diner-3@travio.test',
    name: 'Seed Diner Three',
    photoURL: '',
    rating: 4,
    title: 'Busy, friendly, and good value',
    body: 'There was a short wait even with a booking, but the food was worth it. Generous portions and a genuinely welcoming team. I would come back on a weeknight.',
  },
];

function parseArgs(argv) {
  const args = { limit: 4, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20) {
    throw new Error('--limit must be an integer between 1 and 20');
  }
  return args;
}

function assertNonProduction() {
  const env = process.env.NODE_ENV || 'development';
  if (!DEMO_ENVIRONMENTS.includes(env)) {
    throw new Error(
      `seed-restaurant-home is a demo seed and refuses NODE_ENV=${env}. ` +
        'Run it only with NODE_ENV=development or NODE_ENV=staging.',
    );
  }
}

async function seedReview(venue, diner, index) {
  const author = await prisma.user.upsert({
    where: { email: diner.email },
    update: { name: diner.name, photoURL: diner.photoURL },
    create: { email: diner.email, name: diner.name, photoURL: diner.photoURL },
  });

  const createdAt = new Date(Date.now() - (index + 1) * 2 * 24 * 60 * 60 * 1000);
  const visitedAt = new Date(createdAt.getTime() - 24 * 60 * 60 * 1000);
  const data = {
    rating: diner.rating,
    title: diner.title,
    body: diner.body,
    status: 'APPROVED',
    // A mix of provenance so the feed shows both badges.
    source: index === 1 ? 'TRAVIO_COMMUNITY' : 'TRAVIO_VERIFIED',
    companions: ['FRIENDS'],
    createdAt,
    visitedAt,
  };

  const existing = await prisma.restaurantVenueReview.findFirst({
    where: { venueId: venue.id, authorId: author.id, visitKey: VISIT_KEY },
    select: { id: true },
  });
  if (existing) {
    await prisma.restaurantVenueReview.update({ where: { id: existing.id }, data });
    return 'updated';
  }
  await prisma.restaurantVenueReview.create({
    data: { ...data, venueId: venue.id, authorId: author.id, visitKey: VISIT_KEY },
  });
  return 'created';
}

async function seedOffer(venue) {
  const id = `seed-offer-${venue.slug}`;
  const data = {
    venueId: venue.id,
    brand: BRAND,
    title: '20% off your table',
    discountType: 'PERCENTAGE',
    discountValue: 20,
    promoCode: 'GHANA20',
    startsAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    isActive: true,
    terms: 'Demo offer for the restaurant homepage. Dine-in only, one table per booking.',
  };

  const existing = await prisma.restaurantVenueOffer.findFirst({
    where: { venueId: venue.id, brand: BRAND, promoCode: data.promoCode },
    select: { id: true },
  });
  if (existing) {
    await prisma.restaurantVenueOffer.update({ where: { id: existing.id }, data });
    return 'updated';
  }
  await prisma.restaurantVenueOffer.create({ data: { id, ...data } });
  return 'created';
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/seed-restaurant-home.js [--limit 4] [--dry-run]');
    return;
  }
  assertNonProduction();

  const venues = await prisma.restaurantVenue.findMany({
    where: {
      status: 'ACTIVE',
      listings: { some: { brand: BRAND, isActive: true } },
    },
    select: { id: true, slug: true, name: true, city: true },
    orderBy: [{ city: 'asc' }, { name: 'asc' }],
    take: args.limit,
  });

  if (venues.length === 0) {
    console.log(`No active ${BRAND} venues to seed. Import and publish venues first.`);
    return;
  }

  if (args.dryRun) {
    console.log(`Would seed ${venues.length} venue(s): ${venues.map((v) => v.slug).join(', ')}.`);
    return;
  }

  let reviews = 0;
  let offers = 0;
  for (const venue of venues) {
    for (const [index, diner] of DINERS.entries()) {
      await seedReview(venue, diner, index);
      reviews += 1;
    }
    // Full rebuild from the review rows: safe to repeat and always consistent.
    await rebuildVenueRating(prisma, venue.id);
    await seedOffer(venue);
    offers += 1;
    await cache
      .invalidateRestaurantVenueCaches(venue.id, venue.slug)
      .catch((error) => console.warn('[cache] invalidation failed:', error.message));
  }

  const cities = await recomputeAllCityDemand();
  await recomputeAllCityRanks();
  console.log(
    `Seeded ${reviews} approved review(s) and ${offers} active offer(s) across ${venues.length} venue(s); ` +
      `demand recomputed for ${cities} city/cities.`,
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
