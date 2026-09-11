/**
 * Place resolution for search + place-scoped ranking.
 *
 * Resolves a free-text query ("Accra", "Kakum", "Kakum National Park") to a
 * canonical place with coordinates, so the listings page can scope and rank
 * results around it — the way GetYourGuide scopes a search to a destination.
 *
 * Resolution order (cheapest / most reliable first):
 *   1. curated `Attraction` row (exact, then word-boundary contains)
 *   2. catalog city (`Tour.city`) centroid
 *   3. geocoder, biased and validated by the platform's catalog countries
 *
 * Everything is cached under the `hp:place:*` family so it is cleared together
 * with the rest of the homepage/location caches when a tour changes.
 */

const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const locationService = require('./locationService');
const { haversineKm, resolveCityCentroid } = require('./locationGeo');

const PLACE_TTL = 24 * 60 * 60; // 24h
const COUNTRIES_TTL = 60 * 60; // 1h
const NEARBY_RADIUS_KM = 50;

function scopeKey(scope = {}) {
  if (scope.ghanaOnly) return 'ghana';
  if (scope.expeditionOnly) return 'exp';
  return 'all';
}

function scopeWhere(scope = {}) {
  if (scope.ghanaOnly) return { travioGhanaTour: { isActive: true } };
  if (scope.expeditionOnly) return { expeditionTour: { isActive: true } };
  return {};
}

/**
 * Distinct countries present in the catalog for a scope, most common first.
 * Drives the geocoder bias + validation so "kakum" can never resolve to a
 * random village in Sudan when the platform only sells Ghana.
 *
 * @returns {Promise<Array<{ name: string, count: number }>>}
 */
async function getCatalogCountries(scope = {}) {
  const key = `hp:place:countries:${scopeKey(scope)}`;
  return cache.getOrSet(key, async () => {
    const join = scope.ghanaOnly
      ? 'JOIN "TravioGhanaTour" tgt ON tgt."tourId" = t.id AND tgt."isActive" = true'
      : scope.expeditionOnly
        ? 'JOIN "ExpeditionTour" et ON et."tourId" = t.id AND et."isActive" = true'
        : '';
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT t.country AS name, COUNT(*)::int AS count
           FROM "Tour" t
           ${join}
          WHERE t.status = 'ACTIVE' AND t.country IS NOT NULL AND t.country <> ''
          GROUP BY t.country
          ORDER BY count DESC
          LIMIT 5`
      );
      return rows
        .filter((r) => r.name && String(r.name).trim())
        .map((r) => ({ name: String(r.name).trim(), count: r.count }));
    } catch {
      return [];
    }
  }, COUNTRIES_TTL);
}

/** Curated attraction lookup — exact, then word-boundary contains. */
async function findAttraction(query) {
  const q = query.trim();
  const select = { name: true, latitude: true, longitude: true, tourCount: true };

  const exact = await prisma.attraction.findFirst({
    where: {
      status: 'ACTIVE',
      name: { equals: q, mode: 'insensitive' },
      latitude: { not: null },
      longitude: { not: null },
    },
    select,
  });
  if (exact) {
    return { name: exact.name, type: 'attraction', city: null, country: null, lat: exact.latitude, lng: exact.longitude };
  }

  // Word-boundary contains so "kakum" matches "Kakum National Park" without
  // matching unrelated names that merely embed the string.
  const fuzzy = await prisma.attraction.findFirst({
    where: {
      status: 'ACTIVE',
      name: { contains: q, mode: 'insensitive' },
      latitude: { not: null },
      longitude: { not: null },
    },
    select,
    orderBy: [{ tourCount: 'desc' }],
  });
  if (fuzzy) {
    return { name: fuzzy.name, type: 'attraction', city: null, country: null, lat: fuzzy.latitude, lng: fuzzy.longitude };
  }
  return null;
}

/** Catalog city lookup (exact, then contains) + its tour centroid. */
async function findCity(query, scope) {
  const base = { status: 'ACTIVE', ...scopeWhere(scope) };
  const select = { city: true, country: true };

  const exact = await prisma.tour.findFirst({
    where: { ...base, city: { equals: query.trim(), mode: 'insensitive' } },
    select,
    orderBy: { totalBookings: 'desc' },
  });
  const match = exact || await prisma.tour.findFirst({
    where: { ...base, city: { contains: query.trim(), mode: 'insensitive' } },
    select,
    orderBy: { totalBookings: 'desc' },
  });
  if (!match || !match.city) return null;

  const centroid = await resolveCityCentroid(match.city);
  return {
    name: match.city,
    type: 'city',
    city: match.city,
    country: match.country || null,
    lat: centroid ? centroid.lat : null,
    lng: centroid ? centroid.lng : null,
  };
}

/**
 * Geocode a query, biased to (and validated against) the catalog countries.
 * Tries "<query>, <primary country>" first, then the raw query, keeping only
 * results whose country is in the catalog.
 */
async function geocode(query, countries) {
  const names = countries.map((c) => c.name);
  const allowed = new Set(names.map((n) => n.toLowerCase()));
  const attempts = names.length ? [`${query}, ${names[0]}`, query] : [query];

  for (const attempt of attempts) {
    const results = await locationService.search(attempt, 5).catch(() => []);
    const hit = (results || []).find((r) => {
      if (r.latitude == null || r.longitude == null) return false;
      if (allowed.size === 0) return true;
      return allowed.has(String(r.country || '').toLowerCase());
    });
    if (hit) {
      return {
        name: hit.city || hit.formatted || query,
        type: 'landmark',
        city: hit.city || null,
        country: hit.country || null,
        lat: hit.latitude,
        lng: hit.longitude,
      };
    }
  }
  return null;
}

/**
 * Resolve a query to a place. Returns null when nothing sensible is found, so
 * callers can fall back to plain text search.
 *
 * @param {string} query
 * @param {{ ghanaOnly?: boolean, expeditionOnly?: boolean }} [scope]
 * @returns {Promise<{ name: string, type: string, city: string|null, country: string|null, lat: number|null, lng: number|null } | null>}
 */
async function resolvePlace(query, scope = {}) {
  const q = (query || '').trim();
  if (q.length < 2) return null;

  const key = `hp:place:${scopeKey(scope)}:${q.toLowerCase()}`;
  return cache.getOrSet(key, async () => {
    const attraction = await findAttraction(q);
    if (attraction) return attraction;

    const city = await findCity(q, scope);
    if (city && city.lat != null && city.lng != null) return city;

    const countries = await getCatalogCountries(scope);
    const geo = await geocode(q, countries);
    if (geo) return geo;

    // City with a name but no geolocated tours — still usable for name matching.
    return city || null;
  }, PLACE_TTL);
}

/**
 * GYG-style popularity score: ratings weighted by review volume, plus booking
 * momentum. Deterministic and cheap (no extra queries).
 */
function popularityScore(tour) {
  const rating = Number(tour.averageRating) || 0;
  const reviews = Number(tour.reviewCount) || 0;
  const bookings = Number(tour.totalBookings) || 0;
  return rating * Math.log10(reviews + 1) * 2 + Math.log10(bookings + 1);
}

/**
 * Rank tours around a resolved place into GetYourGuide-style bands:
 *   1 = in the place (based there / visits it / tagged with it)
 *   2 = near the place (within `radiusKm`)
 *   3 = everywhere else
 * Popularity decides the order inside each band, so a far-away popular tour
 * can never overtake a tour that belongs to the searched place.
 *
 * @param {Array} tours - raw tour rows (need id, latitude, longitude, city, averageRating, reviewCount, totalBookings)
 * @param {{ lat: number|null, lng: number|null, localIds?: Set<string>, radiusKm?: number }} opts
 */
function rankByPlace(tours, { lat = null, lng = null, localIds = new Set(), radiusKm = NEARBY_RADIUS_KM } = {}) {
  const hasPoint = lat != null && lng != null;
  const scored = tours.map((t) => {
    const hasCoords = t.latitude != null && t.longitude != null;
    const distanceKm = hasPoint && hasCoords
      ? Math.round(haversineKm(lat, lng, t.latitude, t.longitude) * 10) / 10
      : null;

    let band = 3;
    if (localIds.has(t.id)) band = 1;
    else if (distanceKm != null && distanceKm <= radiusKm) band = 2;

    return { ...t, distanceKm, _band: band, _pop: popularityScore(t) };
  });

  scored.sort((a, b) => {
    if (a._band !== b._band) return a._band - b._band;
    if (b._pop !== a._pop) return b._pop - a._pop;
    if ((b.averageRating ?? 0) !== (a.averageRating ?? 0)) return (b.averageRating ?? 0) - (a.averageRating ?? 0);
    return (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
  });

  return scored;
}

module.exports = {
  resolvePlace,
  getCatalogCountries,
  rankByPlace,
  popularityScore,
  NEARBY_RADIUS_KM,
};
