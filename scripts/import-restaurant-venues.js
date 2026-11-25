#!/usr/bin/env node
/**
 * Import restaurant venues from a JSON file.
 *
 * Usage:
 *   node scripts/import-restaurant-venues.js --file data/accra-restaurants.json
 *   node scripts/import-restaurant-venues.js --file ... --brand ghana --draft
 *   node scripts/import-restaurant-venues.js --file ... --dry-run
 *
 * Idempotent by slug: re-running updates the same row. External aggregates are
 * upserted per (venue, source) and the venue's combined/bayes ranking columns
 * are recomputed at the end, so the API can sort on them immediately.
 *
 * This script never calls Google. It consumes numbers a human or a separate
 * sync job already fetched, which keeps the Places API key out of the import
 * path and keeps the legal question (what may be cached) in one place.
 *
 * Payload shape:
 * {
 *   "venues": [
 *     {
 *       "slug": "buka-restaurant-accra",
 *       "name": "Buka Restaurant",
 *       "status": "ACTIVE",
 *       "city": "Accra",
 *       "neighbourhood": "Osu",
 *       "addressLine": "10th Ave, Osu",
 *       "latitude": 5.5566,
 *       "longitude": -0.1866,
 *       "cuisines": ["west-african"],
 *       "dietary": ["vegetarian"],
 *       "priceBand": 2,
 *       "amenities": ["outdoor-seating"],
 *       "phone": "+233302123456",
 *       "website": "https://example.com",
 *       "description": "…",
 *       "photos": ["https://res.cloudinary.com/…"],
 *       "coverPhoto": "https://res.cloudinary.com/…",
 *       "hours": { "mon": [["11:00","22:00"]] },
 *       "googlePlaceId": "ChIJ…",
 *       "isFeatured": false,
 *       "displayOrder": 0,
 *       "external": [
 *         { "source": "GOOGLE", "rating": 4.6, "reviewCount": 1204,
 *           "productUrl": "https://maps.google.com/?cid=…" }
 *       ]
 *     }
 *   ]
 * }
 *
 * The venue is only reachable through an ACTIVE listing, so a new venue is
 * invisible until this script publishes it. `--draft` creates/updates the row
 * but leaves the listing inactive.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../src/core/services/prismaClient');
const {
  recomputeVenueStats,
  recomputeRecentStats,
  recomputeCityRanks,
  recomputeCityDemand,
} = require('../src/core/services/restaurantVenueStats');

const BRANDS = ['ghana', 'africa', 'expedition'];
const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED'];

function parseArgs(argv) {
  const args = { brand: 'ghana', file: null, dryRun: false, draft: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') args.file = argv[++i];
    else if (arg === '--brand') args.brand = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--draft') args.draft = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toUrlOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

/** Only known columns — a typo in the JSON must not become a Prisma error. */
function toVenueData(raw) {
  const status = STATUSES.includes(String(raw.status || '').toUpperCase())
    ? String(raw.status).toUpperCase()
    : 'ACTIVE';

  return {
    slug: raw.slug ? slugify(raw.slug) : slugify(raw.name),
    name: String(raw.name || '').trim(),
    status,
    city: raw.city ? String(raw.city).trim() : null,
    region: raw.region ? String(raw.region).trim() : null,
    country: raw.country ? String(raw.country).trim() : 'Ghana',
    neighbourhood: raw.neighbourhood ? String(raw.neighbourhood).trim() : null,
    addressLine: raw.addressLine ? String(raw.addressLine).trim() : null,
    latitude: toNumberOrNull(raw.latitude),
    longitude: toNumberOrNull(raw.longitude),
    cuisines: toStringArray(raw.cuisines),
    dietary: toStringArray(raw.dietary),
    amenities: toStringArray(raw.amenities),
    priceBand: toNumberOrNull(raw.priceBand),
    phone: raw.phone ? String(raw.phone).trim() : null,
    website: raw.website ? String(raw.website).trim() : null,
    description: raw.description ? String(raw.description).trim() : null,
    // The source workbook keeps the menu link and meal services under
    // sourceMeta; accept either shape so a future export can flatten them.
    menuUrl: toUrlOrNull(raw.menuUrl || raw.sourceMeta?.menuUrl),
    mealTypes: toStringArray(raw.mealTypes || raw.sourceMeta?.mealTypes),
    photos: Array.isArray(raw.photos) ? raw.photos.filter(Boolean) : [],
    coverPhoto: raw.coverPhoto || null,
    hours: raw.hours && typeof raw.hours === 'object' ? raw.hours : null,
    timezone: raw.timezone ? String(raw.timezone).trim() : 'Africa/Accra',
    googlePlaceId: raw.googlePlaceId ? String(raw.googlePlaceId).trim() : null,
  };
}

function toExternalRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row) => row && row.source)
    .map((row) => ({
      source: String(row.source).toUpperCase(),
      rating: toNumberOrNull(row.rating),
      reviewCount: Math.max(0, Math.trunc(Number(row.reviewCount) || 0)),
      distribution: row.distribution && typeof row.distribution === 'object' ? row.distribution : null,
      productId: row.productId ? String(row.productId) : null,
      productUrl: row.productUrl ? String(row.productUrl) : null,
      syncedAt: new Date(),
    }));
}

async function importVenue(raw, { brand, draft, dryRun }) {
  if (!raw || !raw.name) throw new Error('Each venue needs a name');

  const data = toVenueData(raw);
  if (!data.slug) throw new Error(`Could not derive a slug for ${data.name}`);

  const listing = {
    brand,
    isActive: draft ? false : data.status === 'ACTIVE',
    isFeatured: Boolean(raw.isFeatured),
    displayOrder: Number.isFinite(Number(raw.displayOrder)) ? Number(raw.displayOrder) : 0,
    publishedAt: draft ? null : new Date(),
  };

  if (dryRun) {
    return { slug: data.slug, action: 'would-upsert', external: toExternalRows(raw.external).length };
  }

  const venue = await prisma.restaurantVenue.upsert({
    where: { slug: data.slug },
    create: data,
    update: data,
    select: { id: true, slug: true },
  });

  await prisma.restaurantVenueListing.upsert({
    where: { brand_venueId: { brand, venueId: venue.id } },
    create: { venueId: venue.id, ...listing },
    update: listing,
  });

  const external = toExternalRows(raw.external);
  for (const row of external) {
    await prisma.restaurantVenueExternalStat.upsert({
      where: { venueId_source: { venueId: venue.id, source: row.source } },
      create: { venueId: venue.id, ...row },
      update: row,
    });
  }

  // Aggregates are recomputed in one batch after the loop: a per-venue write
  // would recompute the city rank N times, and the last venue would win.
  return {
    slug: venue.slug,
    id: venue.id,
    city: data.city,
    action: 'upserted',
    external: external.length,
  };
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || !args.file) {
    console.log(
      'Usage: node scripts/import-restaurant-venues.js --file <path.json> ' +
        '[--brand ghana|africa|expedition] [--draft] [--dry-run]',
    );
    process.exit(args.help ? 0 : 1);
  }
  if (!BRANDS.includes(args.brand)) {
    throw new Error(`--brand must be one of ${BRANDS.join(', ')}`);
  }

  const resolved = path.resolve(process.cwd(), args.file);
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const venues = Array.isArray(payload) ? payload : payload.venues;

  if (!Array.isArray(venues) || venues.length === 0) {
    throw new Error('Payload must be an array or { "venues": [...] } with at least one entry');
  }

  console.log(
    `Importing ${venues.length} venue(s) for brand "${args.brand}"` +
      `${args.dryRun ? ' (dry run)' : ''}${args.draft ? ' as drafts' : ''}`,
  );

  const results = [];
  const errors = [];
  const seen = new Set();

  for (const raw of venues) {
    const label = raw && (raw.slug || raw.name) ? raw.slug || raw.name : '(unnamed)';
    try {
      const result = await importVenue(raw, args);
      if (seen.has(result.slug)) {
        console.warn(`  ! duplicate slug in payload: ${result.slug}`);
      }
      seen.add(result.slug);
      results.push(result);
      console.log(`  ✓ ${result.slug} (${result.action}, ${result.external} external source(s))`);
    } catch (error) {
      errors.push({ venue: label, error: error.message });
      console.error(`  ✗ ${label}: ${error.message}`);
    }
  }

  if (!args.dryRun && results.length > 0) {
    const ids = results.map((row) => row.id).filter(Boolean);
    const cities = [...new Set(results.map((row) => row.city).filter(Boolean))];

    await recomputeRecentStats(ids);
    await recomputeVenueStats(ids);
    for (const city of cities) {
      await recomputeCityDemand(city);
      await recomputeCityRanks(city);
    }
    console.log(
      `\nRecomputed ${ids.length} venue aggregate(s); demand and ranks for ${cities.length} city/cities.`,
    );
  }

  console.log(`\nDone. ${results.length} imported, ${errors.length} failed.`);
  if (errors.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
