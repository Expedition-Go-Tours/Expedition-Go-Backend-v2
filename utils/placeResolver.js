/**
 * Place resolution for search + place-scoped ranking.
 *
 * Resolves a free-text query ("Accra", "James Town", "Kakum", "Volta Region")
 * to a canonical place, so the listings page can scope and rank results around
 * it — the way GetYourGuide scopes a search to a destination.
 *
 * Resolution order (cheapest / most reliable first):
 *   1. catalog city   (Tour.city)
 *   2. catalog region (Tour.region)
 *   3. curated Attraction row
 *   4. geocoder, biased and validated by the platform's catalog countries
 *
 * Hardened for the messy cases: input normalisation (case / whitespace /
 * accents / punctuation / commas / length), a stopword guard, country
 * validation, POI→locality collapsing, a stable canonical `displayName`, and
 * a name-only fallback when coordinates are missing (so a match never geocodes
 * to a different place).
 */

const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const locationService = require('./locationService');
const { haversineKm, resolveCityCentroid, resolveRegionCentroid } = require('./locationGeo');

const PLACE_TTL = 6 * 60 * 60; // 6h — fresher than 24h after catalog changes
const COUNTRIES_TTL = 60 * 60; // 1h
const NEARBY_RADIUS_KM = 50;
const MAX_QUERY_LEN = 120;

/**
 * Words that must never resolve to a place on their own — either generic
 * travel nouns or the platform's own country. "Ho"/"Wa"/"Cape" are real
 * Ghanaian places and are intentionally NOT listed here.
 */
const STOPWORDS = new Set([
  'tour', 'tours', 'trip', 'trips', 'experience', 'experiences',
  'activity', 'activities', 'thing', 'things', 'place', 'places',
  'day', 'days', 'night', 'nights', 'package', 'packages',
  'ghana', 'africa', 'west africa',
]);

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

/** Lowercase, collapse whitespace, strip surrounding punctuation, cap length. */
function normalizeQuery(raw) {
  let q = String(raw || '').replace(/\s+/g, ' ').trim();
  q = q.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
  if (q.length > MAX_QUERY_LEN) q = q.slice(0, MAX_QUERY_LEN).trim();
  return q;
}

/** Fold diacritics so "São" matches "Sao" (and vice-versa). */
function foldAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Cache-key-safe form (folded + lowercased). */
function keyOf(q) {
  return foldAccents(q.toLowerCase());
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

/** Catalog city lookup — exact, then accent-folded contains. */
async function findCity(query, scope) {
  const base = { status: 'ACTIVE', ...scopeWhere(scope) };
  const select = { city: true, country: true };

  const exact = await prisma.tour.findFirst({
    where: { ...base, city: { equals: query, mode: 'insensitive' } },
    select,
    orderBy: { totalBookings: 'desc' },
  });
  const match = exact || await prisma.tour.findFirst({
    where: { ...base, city: { contains: query, mode: 'insensitive' } },
    select,
    orderBy: { totalBookings: 'desc' },
  });
  if (!match || !match.city) return null;

  const centroid = await resolveCityCentroid(match.city);
  return {
    name: match.city,
    type: 'city',
    city: match.city,
    region: null,
    country: match.country || null,
    lat: centroid ? centroid.lat : null,
    lng: centroid ? centroid.lng : null,
    matchedBy: exact ? 'city:exact' : 'city:contains',
  };
}

/** Catalog region lookup — exact, then contains (e.g. "Volta Region"). */
async function findRegion(query, scope) {
  const base = { status: 'ACTIVE', ...scopeWhere(scope) };
  const select = { region: true, country: true };

  const exact = await prisma.tour.findFirst({
    where: { ...base, region: { equals: query, mode: 'insensitive' } },
    select,
    orderBy: { totalBookings: 'desc' },
  });
  const match = exact || await prisma.tour.findFirst({
    where: { ...base, region: { contains: query, mode: 'insensitive' } },
    select,
    orderBy: { totalBookings: 'desc' },
  });
  if (!match || !match.region) return null;

  const centroid = await resolveRegionCentroid(match.region);
  return {
    name: match.region,
    type: 'region',
    city: null,
    region: match.region,
    country: match.country || null,
    lat: centroid ? centroid.lat : null,
    lng: centroid ? centroid.lng : null,
    matchedBy: exact ? 'region:exact' : 'region:contains',
  };
}

/** Curated attraction lookup — exact, then word-boundary contains. */
async function findAttraction(query) {
  const select = { name: true, latitude: true, longitude: true, tourCount: true };

  const exact = await prisma.attraction.findFirst({
    where: {
      status: 'ACTIVE',
      name: { equals: query, mode: 'insensitive' },
      latitude: { not: null },
      longitude: { not: null },
    },
    select,
  });
  if (exact) {
    return {
      name: exact.name, type: 'attraction', city: null, region: null, country: null,
      lat: exact.latitude, lng: exact.longitude, matchedBy: 'attraction:exact',
    };
  }

  const fuzzy = await prisma.attraction.findFirst({
    where: {
      status: 'ACTIVE',
      name: { contains: query, mode: 'insensitive' },
      latitude: { not: null },
      longitude: { not: null },
    },
    select,
    orderBy: [{ tourCount: 'desc' }],
  });
  if (fuzzy) {
    return {
      name: fuzzy.name, type: 'attraction', city: null, region: null, country: null,
      lat: fuzzy.latitude, lng: fuzzy.longitude, matchedBy: 'attraction:contains',
    };
  }
  return null;
}

/**
 * Geocode a query, biased to (and validated against) the catalog countries.
 * Tries "<query>, <primary country>" first, then the raw query. The display
 * name comes from the matched locality (street / first formatted segment),
 * never the containing city, and POIs collapse to their locality so we never
 * scope a listing to a single building.
 */
async function geocode(query, countries) {
  const names = countries.map((c) => c.name);
  const allowed = new Set(names.map((n) => foldAccents(n.toLowerCase())));
  const attempts = names.length ? [`${query}, ${names[0]}`, query] : [query];

  for (const attempt of attempts) {
    const results = await locationService.search(attempt, 5).catch(() => []);
    const hit = (results || []).find((r) => {
      if (r.latitude == null || r.longitude == null) return false;
      if (allowed.size === 0) return true;
      return allowed.has(foldAccents(String(r.country || '').toLowerCase()));
    });
    if (!hit) continue;

    const formattedHead = String(hit.formatted || '').split(',')[0].trim();
    const name = hit.street || formattedHead || hit.city || query;

    return {
      name,
      type: 'locality',
      city: hit.city || null,
      region: hit.region || null,
      country: hit.country || null,
      lat: hit.latitude,
      lng: hit.longitude,
      matchedBy: 'geocoder',
    };
  }
  return null;
}

/**
 * Canonical display name. Cities/regions/countries stand alone ("Accra",
 * "Central Region"); localities/attractions get their nearest qualifier for
 * disambiguation + SEO ("James Town, Accra") unless it's already in the name.
 */
function displayName(place) {
  if (!place) return '';
  if (place.type === 'city' || place.type === 'region' || place.type === 'country') return place.name;
  const qualifier = place.city || place.region;
  if (qualifier && !foldAccents(place.name.toLowerCase()).includes(foldAccents(qualifier.toLowerCase()))) {
    return `${place.name}, ${qualifier}`;
  }
  return place.name;
}

function finalize(place) {
  return { ...place, displayName: displayName(place) };
}

/**
 * Resolve a query to a place. Returns null when nothing sensible is found, so
 * callers can fall back to plain text search.
 *
 * @param {string} query
 * @param {{ ghanaOnly?: boolean, expeditionOnly?: boolean }} [scope]
 * @returns {Promise<{ name: string, displayName: string, type: string, city: string|null, region: string|null, country: string|null, lat: number|null, lng: number|null, matchedBy: string } | null>}
 */
async function resolvePlace(query, scope = {}) {
  const q0 = normalizeQuery(query);
  if (q0.length < 2) return null;

  // Stopword guard: a lone generic word is never a place.
  const lower = q0.toLowerCase();
  if (STOPWORDS.has(lower)) return null;

  // "Accra, Ghana" / "Kakum, Ghana" — resolve the head term.
  const head = (q0.split(',')[0] || q0).trim();
  if (head.length < 2) return null;

  const key = `hp:place:${scopeKey(scope)}:${keyOf(head)}`;
  return cache.getOrSet(key, async () => {
    const city = await findCity(head, scope);
    if (city && city.lat != null && city.lng != null) return finalize(city);

    const region = await findRegion(head, scope);
    if (region && region.lat != null && region.lng != null) return finalize(region);

    const attraction = await findAttraction(head);
    if (attraction) return finalize(attraction);

    const countries = await getCatalogCountries(scope);
    const geo = await geocode(head, countries);
    if (geo) return finalize(geo);

    // Name-only fallbacks (no coords) — still usable for in-place matching.
    if (city) return finalize(city);
    if (region) return finalize(region);
    return null;
  }, PLACE_TTL, { cacheEmpty: false, cacheNull: false });
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
 *   3 = everywhere else (callers scoping to a place DROP this band)
 * Popularity decides the order inside each band, so a far-away popular tour
 * can never overtake a tour that belongs to the searched place.
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
  displayName,
  normalizeQuery,
  foldAccents,
  NEARBY_RADIUS_KM,
};
