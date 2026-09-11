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
  'the', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'by', 'with', 'near', 'around',
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
 * Word-boundary contains — "kumasi" matches "Kumasi" but NOT "Nyankumasi
 * Ahenkro". Prisma's `contains` is a raw substring, so candidate rows are
 * fetched and filtered here.
 */
function wordBoundaryMatch(haystack, needle) {
  if (!haystack || !needle) return false;
  const idx = haystack.indexOf(needle);
  if (idx === -1) return false;
  const before = idx === 0 || !/[a-z0-9]/.test(haystack[idx - 1]);
  const afterIdx = idx + needle.length;
  const after = afterIdx === haystack.length || !/[a-z0-9]/.test(haystack[afterIdx]);
  return before && after;
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

/** Catalog city lookup — exact, then word-boundary contains. */
async function findCity(query, scope) {
  const base = { status: 'ACTIVE', ...scopeWhere(scope) };
  const select = { city: true, country: true };

  const exact = await prisma.tour.findFirst({
    where: { ...base, city: { equals: query, mode: 'insensitive' } },
    select,
    orderBy: { totalBookings: 'desc' },
  });
  let match = exact;
  let matchedBy = 'city:exact';

  if (!match) {
    const target = foldAccents(query.toLowerCase());
    const candidates = await prisma.tour.findMany({
      where: { ...base, city: { contains: query, mode: 'insensitive' } },
      select,
      orderBy: { totalBookings: 'desc' },
      take: 50,
    });
    match = candidates.find((c) => c.city && wordBoundaryMatch(foldAccents(c.city.toLowerCase()), target));
    matchedBy = 'city:contains';
  }
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
    matchedBy,
  };
}

/** Catalog region lookup — exact, then word-boundary contains (e.g. "Volta Region"). */
async function findRegion(query, scope) {
  const base = { status: 'ACTIVE', ...scopeWhere(scope) };
  const select = { region: true, country: true };

  const exact = await prisma.tour.findFirst({
    where: { ...base, region: { equals: query, mode: 'insensitive' } },
    select,
    orderBy: { totalBookings: 'desc' },
  });
  let match = exact;
  let matchedBy = 'region:exact';

  if (!match) {
    const target = foldAccents(query.toLowerCase());
    const candidates = await prisma.tour.findMany({
      where: { ...base, region: { contains: query, mode: 'insensitive' } },
      select,
      orderBy: { totalBookings: 'desc' },
      take: 50,
    });
    match = candidates.find((c) => c.region && wordBoundaryMatch(foldAccents(c.region.toLowerCase()), target));
    matchedBy = 'region:contains';
  }
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
    matchedBy,
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

  // Prefix match: "kakum" → "Kakum National Park", but "kumasi" does NOT match
  // "The Kumasi NightLife Experience" (so a major city falls through to the
  // geocoder and resolves as the city, not a tour-like attraction).
  const target = foldAccents(query.toLowerCase());
  const candidates = await prisma.attraction.findMany({
    where: {
      status: 'ACTIVE',
      name: { contains: query, mode: 'insensitive' },
      latitude: { not: null },
      longitude: { not: null },
    },
    select,
    orderBy: [{ tourCount: 'desc' }],
    take: 50,
  });
  const fuzzy = candidates.find((a) => a.name && foldAccents(a.name.toLowerCase()).startsWith(target));
  if (fuzzy) {
    return {
      name: fuzzy.name, type: 'attraction', city: null, region: null, country: null,
      lat: fuzzy.latitude, lng: fuzzy.longitude, matchedBy: 'attraction:prefix',
    };
  }
  return null;
}

/**
 * Geocode a query and keep only results inside the catalog countries.
 *
 * The query is geocoded AS-IS — we deliberately do NOT append the catalog
 * country, because that makes foreign names resolve to arbitrary streets in
 * Ghana ("Dubai, Ghana" → "Kumasi - Techiman"). A hit is accepted only when
 * its country is in the catalog; otherwise the query is not a place here.
 *
 * The display name comes from the matched locality (street / first formatted
 * segment), never the containing city, and POIs collapse to their locality.
 */
async function geocode(query, countries) {
  const allowed = new Set(countries.map((c) => foldAccents(c.name.toLowerCase())));

  const results = await locationService.search(query, 8).catch(() => []);
  const hit = (results || []).find((r) => {
    if (r.latitude == null || r.longitude == null) return false;
    if (allowed.size === 0) return true;
    return allowed.has(foldAccents(String(r.country || '').toLowerCase()));
  });
  if (!hit) return null;

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

/** Is `name` a catalog city or region in this scope? (for comma-tail checks) */
async function isCatalogPlaceName(name, scope) {
  const base = { status: 'ACTIVE', ...scopeWhere(scope) };
  const [city, region] = await Promise.all([
    prisma.tour.findFirst({ where: { ...base, city: { equals: name, mode: 'insensitive' } }, select: { id: true } }),
    prisma.tour.findFirst({ where: { ...base, region: { equals: name, mode: 'insensitive' } }, select: { id: true } }),
  ]);
  return !!(city || region);
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

  // "Accra, Ghana" / "Kakum, Sudan" — resolve the head term, then validate any
  // qualifier tail so a foreign country can't ride along on a matching head.
  const parts = q0.split(',').map((s) => s.trim()).filter(Boolean);
  const head = parts[0] || q0;
  const tail = parts.slice(1).join(' ').trim();
  if (head.length < 2) return null;

  const key = `hp:place:${scopeKey(scope)}:${keyOf(head)}`;
  const resolved = await cache.getOrSet(key, async () => {
    // 1. Catalog exacts — city, region, attraction.
    const city = await findCity(head, scope);
    if (city && city.lat != null && city.lng != null) return finalize(city);

    const region = await findRegion(head, scope);
    if (region && region.lat != null && region.lng != null) return finalize(region);

    const attraction = await findAttraction(head);
    if (attraction) return finalize(attraction);

    // 2. Geocoder — resolves cities/regions/towns the catalog has no tours for
    //    (e.g. "Kumasi"), keeping only results inside the catalog countries.
    const countries = await getCatalogCountries(scope);
    const geo = await geocode(head, countries);
    if (geo) return finalize(geo);

    // 3. Name-only fallbacks (no coords) — still usable for in-place matching.
    if (city) return finalize(city);
    if (region) return finalize(region);
    return null;
  }, PLACE_TTL, { cacheEmpty: false, cacheNull: false });

  if (resolved && tail) {
    const tailFold = foldAccents(tail.toLowerCase());
    const countries = await getCatalogCountries(scope);
    const isCatalogCountry = countries.some((c) => foldAccents(c.name.toLowerCase()) === tailFold);
    const placeCountry = resolved.country ? foldAccents(resolved.country.toLowerCase()) : null;

    if (isCatalogCountry) {
      if (placeCountry && placeCountry !== tailFold) return null;
    } else if (!(await isCatalogPlaceName(tail, scope))) {
      // Unknown qualifier (e.g. "Kakum, Sudan" / "Accra, Togo") — reject.
      return null;
    }
  }

  return resolved;
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
 * Relevance of a tour to a place, GetYourGuide-style — content matching, not
 * distance. Lower = stronger:
 *   1 = title contains the place
 *   2 = attractions / tags contain it
 *   3 = the tour's city / region equals it
 *   4 = description contains it
 *   0 = no match
 */
function placeRelevance(tour, place) {
  const target = foldAccents(String(place || '').toLowerCase()).trim();
  if (!target || !tour) return 0;
  const text = (s) => (s ? wordBoundaryMatch(foldAccents(String(s).toLowerCase()), target) : false);
  const list = (arr) => Array.isArray(arr) && arr.some((v) => text(v));

  if (text(tour.title)) return 1;
  if (list(tour.attractions) || list(tour.tags)) return 2;
  if (tour.city && foldAccents(tour.city.toLowerCase()) === target) return 3;
  if (tour.region && foldAccents(tour.region.toLowerCase()) === target) return 3;
  if (text(tour.description)) return 4;
  return 0;
}

/**
 * Rank tours for a place: relevance tier first (title > attractions/tags >
 * city/region > description), then popularity. Tours that don't match at all
 * (tier 0) are dropped — a place with no relevant tours returns nothing, never
 * the whole catalogue. `radiusKm` (optional) adds a weak proximity fallback
 * band for tours with no textual match.
 */
function rankByPlace(tours, { place = '', lat = null, lng = null, localIds = null, radiusKm = 0 } = {}) {
  const hasPoint = lat != null && lng != null && radiusKm > 0;
  const scored = [];

  for (const t of tours) {
    let tier = placeRelevance(t, place);
    let distanceKm = null;

    if (hasPoint && t.latitude != null && t.longitude != null) {
      distanceKm = Math.round(haversineKm(lat, lng, t.latitude, t.longitude) * 10) / 10;
    }
    if (tier === 0) {
      if (localIds && localIds.has(t.id)) tier = 3;
      else if (distanceKm != null && distanceKm <= radiusKm) tier = 5;
    }
    if (tier === 0) continue;

    scored.push({ ...t, distanceKm, _band: tier, _pop: popularityScore(t) });
  }

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
  placeRelevance,
  popularityScore,
  displayName,
  normalizeQuery,
  foldAccents,
  NEARBY_RADIUS_KM,
};
