/**
 * Backfill Tour Coordinates
 *
 * Fills `Tour.latitude` / `Tour.longitude` (and therefore the PostGIS
 * `location_geom` column, via the DB trigger) for ACTIVE tours that have a
 * city but no coordinates. Resolution order per city:
 *   1. the centroid of sibling tours in the same city that already have coords
 *   2. the geocoder (Geoapify -> Nominatim -> Photon) for "<city>, <country>"
 *
 * Usage:
 *   node scripts/backfill-tour-coords.js                 # dry run (stats + plan)
 *   node scripts/backfill-tour-coords.js --apply         # write changes
 *   node scripts/backfill-tour-coords.js --apply --limit=50
 */

const prisma = require('../utils/prismaClient');
const locationService = require('../utils/locationService');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

function round(n) {
  return Math.round(n * 100000) / 100000;
}

async function siblingCentroid(city) {
  const rows = await prisma.tour.findMany({
    where: {
      status: 'ACTIVE',
      city: { equals: city, mode: 'insensitive' },
      latitude: { not: null },
      longitude: { not: null },
    },
    select: { latitude: true, longitude: true },
    take: 200,
  });
  if (rows.length === 0) return null;
  return {
    lat: rows.reduce((s, r) => s + r.latitude, 0) / rows.length,
    lng: rows.reduce((s, r) => s + r.longitude, 0) / rows.length,
    source: 'sibling',
  };
}

async function geocode(city, country) {
  const query = [city, country].filter(Boolean).join(', ');
  try {
    const results = await locationService.search(query, 1);
    const hit = results?.[0];
    if (hit && hit.latitude != null && hit.longitude != null) {
      return { lat: hit.latitude, lng: hit.longitude, source: 'geocoder' };
    }
  } catch (err) {
    console.warn(`  ! geocode failed for "${query}": ${err.message}`);
  }
  return null;
}

async function main() {
  console.log('=== Tour coordinate backfill ===');
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const missing = await prisma.tour.findMany({
    where: {
      status: 'ACTIVE',
      city: { not: null },
      OR: [{ latitude: null }, { longitude: null }],
    },
    select: { id: true, city: true, country: true },
    orderBy: { city: 'asc' },
  });

  console.log(`ACTIVE tours missing coordinates (with a city): ${missing.length}`);

  const byCity = new Map();
  for (const t of missing) {
    const key = `${t.city}||${t.country || ''}`;
    if (!byCity.has(key)) byCity.set(key, { city: t.city, country: t.country, ids: [] });
    byCity.get(key).ids.push(t.id);
  }

  let cities = [...byCity.values()];
  if (LIMIT > 0) cities = cities.slice(0, LIMIT);
  console.log(`Distinct cities to resolve: ${cities.length}\n`);

  let resolved = 0;
  let unresolved = 0;

  for (const { city, country, ids } of cities) {
    let point = await siblingCentroid(city);
    if (!point) point = await geocode(city, country);
    if (!point) {
      unresolved += ids.length;
      console.log(`  x ${city} - no coordinates found (${ids.length} tours)`);
      continue;
    }
    console.log(`  + ${city} - ${round(point.lat)}, ${round(point.lng)} [${point.source}] -> ${ids.length} tours`);
    resolved += ids.length;
    if (APPLY) {
      await prisma.tour.updateMany({
        where: { id: { in: ids } },
        data: { latitude: round(point.lat), longitude: round(point.lng) },
      });
    }
  }

  console.log('');
  console.log(APPLY ? `Updated ${resolved} tours.` : `Would update ${resolved} tours.`);
  if (unresolved) console.log(`Unresolved: ${unresolved} tours (no city match / geocoder miss).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
