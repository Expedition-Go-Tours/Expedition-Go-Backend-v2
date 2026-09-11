/**
 * Backfill Attraction Coordinates
 *
 * Fills `Attraction.latitude` / `Attraction.longitude` for ACTIVE attractions
 * so the search can resolve place names like "Kakum" to a point and scope the
 * listing around it. Geocodes "<name>, <country>" biased to the platform's
 * catalog countries (Ghana today) — without the country hint, "Kakum" resolves
 * to a village in Sudan.
 *
 * Usage:
 *   node scripts/backfill-attraction-coords.js                 # dry run
 *   node scripts/backfill-attraction-coords.js --apply
 *   node scripts/backfill-attraction-coords.js --apply --limit=25
 */

const prisma = require('../utils/prismaClient');
const locationService = require('../utils/locationService');
const { getCatalogCountries } = require('../utils/placeResolver');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

function round(n) {
  return Math.round(n * 100000) / 100000;
}

async function geocode(name, countries) {
  const names = countries.map((c) => c.name);
  const allowed = new Set(names.map((n) => n.toLowerCase()));
  const attempts = names.length ? [`${name}, ${names[0]}`, name] : [name];

  for (const attempt of attempts) {
    const results = await locationService.search(attempt, 3).catch(() => []);
    const hit = (results || []).find((r) => {
      if (r.latitude == null || r.longitude == null) return false;
      if (allowed.size === 0) return true;
      return allowed.has(String(r.country || '').toLowerCase());
    });
    if (hit) return { lat: hit.latitude, lng: hit.longitude };
  }
  return null;
}

async function main() {
  console.log('=== Attraction coordinate backfill ===');
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const countries = await getCatalogCountries({});
  console.log(`Catalog countries: ${countries.map((c) => `${c.name} (${c.count})`).join(', ') || 'none'}\n`);

  const missing = await prisma.attraction.findMany({
    where: {
      status: 'ACTIVE',
      OR: [{ latitude: null }, { longitude: null }],
    },
    select: { id: true, name: true, tourCount: true },
    orderBy: [{ tourCount: 'desc' }, { name: 'asc' }],
  });

  let targets = missing;
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  console.log(`ACTIVE attractions missing coordinates: ${missing.length}`);
  console.log(`Resolving: ${targets.length}\n`);

  let resolved = 0;
  let unresolved = 0;

  for (const attraction of targets) {
    const point = await geocode(attraction.name, countries);
    if (!point) {
      unresolved += 1;
      console.log(`  x ${attraction.name} — no coordinates found`);
      continue;
    }
    console.log(`  + ${attraction.name} — ${round(point.lat)}, ${round(point.lng)} (${attraction.tourCount} tours)`);
    resolved += 1;
    if (APPLY) {
      await prisma.attraction.update({
        where: { id: attraction.id },
        data: { latitude: round(point.lat), longitude: round(point.lng) },
      });
    }
  }

  console.log('');
  console.log(APPLY ? `Updated ${resolved} attractions.` : `Would update ${resolved} attractions.`);
  if (unresolved) console.log(`Unresolved: ${unresolved} (no geocoder match / outside catalog countries).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
