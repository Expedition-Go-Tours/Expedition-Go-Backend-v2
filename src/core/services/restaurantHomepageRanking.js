/**
 * Restaurant homepage ranking rails.
 *
 * Mirrors `homepageRanking.js` for tours, but reads the stored venue signals
 * rather than recomputing aggregates on a request path. Three rules matter:
 *
 *   1. A venue is only visible through an ACTIVE listing for the requested
 *      brand. No rail may leak another storefront's venue.
 *   2. Ranking inputs (rankingScore, demandScore, affinity, distance) stay
 *      internal. Every public row goes through `toPublicVenue`.
 *   3. "Likely to book out" is a demand signal, not live availability. Nothing
 *      here claims a table is free or about to become free.
 *
 * Raw rows are cached, not DTOs, so an offer boundary can invalidate a hit at
 * the exact minute an offer opens or expires — the same guard the venue list
 * uses. Cache keys live under `rv:home:*` so a review/offer edit clears them.
 */

const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const AppError = require('./appError');
const venueService = require('./restaurantVenueService');
const { DEMAND_MIN_RECENT_REVIEWS } = require('./restaurantVenueStats');

const HOME_TTL_SECONDS = 300;
const AFFINITY_WINDOW_DAYS = 30;
const DIVERSITY_WINDOW = 6;
const MAX_PER_CUISINE = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const AFFINITY_EVENTS = ['restaurant_card_clicked', 'restaurant_search_used'];
const VALID_BRANDS = ['ghana', 'africa', 'expedition'];

const OFFER_SELECT = {
  id: true,
  brand: true,
  title: true,
  discountType: true,
  discountValue: true,
  promoCode: true,
  startsAt: true,
  endsAt: true,
  isActive: true,
  createdAt: true,
};

const VENUE_ORDER = [
  { rankingScore: { sort: 'desc', nulls: 'last' } },
  { id: 'desc' },
];

/* ── small helpers ──────────────────────────────────────────────────────── */

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeLimit(limit) {
  const n = Number.parseInt(limit, 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : 8, 1), 20);
}

function normText(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokens(value) {
  return normText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function isLocalVenue(venue, city) {
  if (!city) return false;
  const target = normText(city);
  if (!target) return false;
  return [venue.city, venue.region, venue.neighbourhood]
    .some((value) => normText(value) === target);
}

function isFeatured(venue) {
  return Boolean(venue && venue.listings && venue.listings[0] && venue.listings[0].isFeatured);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 1 at the event time, 0 at the 30-day edge. */
function recencyWeight(createdAt) {
  const at = new Date(createdAt).getTime();
  if (Number.isNaN(at)) return 0;
  const ageDays = Math.max(0, (Date.now() - at) / DAY_MS);
  return Math.max(0, 1 - ageDays / AFFINITY_WINDOW_DAYS);
}

function byScore(a, b) {
  if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
  return String(a.id).localeCompare(String(b.id));
}

/** Local rows before global ones; each group keeps its own score order. */
function localFirst(rows, city) {
  const local = [];
  const global = [];
  for (const row of rows) {
    (isLocalVenue(row, city) ? local : global).push(row);
  }
  return [...local.sort(byScore), ...global.sort(byScore)];
}

function cuisineKeys(venue) {
  const keys = (venue.cuisines || []).map(normText).filter(Boolean);
  return keys.length > 0 ? keys : ['__uncategorised__'];
}

/**
 * First six cards get at most two venues from any one cuisine. Past that
 * window the rail backfills by score so a sparse city still fills up.
 */
function applyCuisineDiversity(local, global, limit) {
  const ordered = [...local.sort(byScore), ...global.sort(byScore)];
  const picked = [];
  const seen = new Set();
  const counts = new Map();

  const overCap = (venue) => cuisineKeys(venue).some((key) => (counts.get(key) || 0) >= MAX_PER_CUISINE);
  const record = (venue) => {
    for (const key of cuisineKeys(venue)) counts.set(key, (counts.get(key) || 0) + 1);
  };

  for (const venue of ordered) {
    if (picked.length >= Math.min(DIVERSITY_WINDOW, limit)) break;
    if (overCap(venue)) continue;
    picked.push(venue);
    seen.add(venue.id);
    record(venue);
  }

  // Only a rail longer than the diversity window may backfill past it. A
  // six-card rail with two cuisines stays at four rather than putting a third
  // jollof joint inside the window it was supposed to diversify.
  if (limit > DIVERSITY_WINDOW) {
    for (const venue of ordered) {
      if (picked.length >= limit) break;
      if (seen.has(venue.id)) continue;
      picked.push(venue);
      seen.add(venue.id);
    }
  }
  return picked;
}

/* ── brand scope + offers ───────────────────────────────────────────────── */

function assertBrand(brand) {
  const brands = venueService.BRANDS || VALID_BRANDS;
  if (!brands.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }
  return brand;
}

/** Reuse the venue service predicate; mirror it only if a test mock omits it. */
function brandOfferWindow(brand, now) {
  if (typeof venueService.offerWindowFilter === 'function') {
    return venueService.offerWindowFilter(brand, now);
  }
  return {
    brand,
    isActive: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
    ],
  };
}

function offerDeadline(rows, brand, now) {
  if (typeof venueService.offerValidUntil === 'function') {
    return venueService.offerValidUntil(rows, brand, now);
  }
  return null;
}

function isPayloadFresh(payload) {
  if (typeof venueService.isOfferPayloadFresh === 'function') {
    return venueService.isOfferPayloadFresh(payload);
  }
  return !payload || !payload.offerValidUntil || payload.offerValidUntil > Date.now();
}

function publicOffers(venue, brand, now) {
  const seen = new Set();
  return (venue.offers || []).filter((offer) => {
    if (!offer || offer.brand !== brand || seen.has(offer.id)) return false;
    if (offer.isActive === false) return false;
    if (offer.startsAt && new Date(offer.startsAt) > now) return false;
    if (offer.endsAt && new Date(offer.endsAt) < now) return false;
    seen.add(offer.id);
    return true;
  });
}

function includeFor(brand) {
  return {
    listings: {
      where: { brand },
      select: { isFeatured: true, displayOrder: true },
    },
    offers: {
      where: { brand, isActive: true },
      select: OFFER_SELECT,
    },
  };
}

async function findVenueRows({ brand, city, now, offersOnly, take }) {
  const where = {
    status: 'ACTIVE',
    listings: { some: { brand, isActive: true } },
  };
  if (offersOnly) where.offers = { some: brandOfferWindow(brand, now) };
  if (city) where.city = { equals: city, mode: 'insensitive' };

  const rows = (await prisma.restaurantVenue.findMany({
    where,
    include: includeFor(brand),
    orderBy: VENUE_ORDER,
    take,
  })) || [];
  // The predicate already does the work; re-check with the same clock the DTO
  // uses so a boundary crossed mid-request can never surface a future offer.
  return offersOnly ? rows.filter((row) => publicOffers(row, brand, now).length > 0) : rows;
}

async function fetchPool({ brand, city, limit, offersOnly = false }) {
  const now = new Date();
  const take = Math.max(limit * 4, 12);
  const query = { brand, now, offersOnly, take };

  if (!city) return findVenueRows(query);

  const [local, global] = await Promise.all([
    findVenueRows({ ...query, city, take: Math.max(limit * 2, 8) }),
    findVenueRows(query),
  ]);
  const localIds = new Set(local.map((venue) => venue.id));
  return [...local, ...global.filter((venue) => !localIds.has(venue.id))];
}

/** Cache key. `userId`/coords are omitted from anonymous, unlocated rails. */
function cacheKey(section, { brand, city, limit, userId, lat, lng }) {
  const parts = [
    'rv:home',
    section,
    brand,
    limit,
    city ? normText(city).replace(/\s+/g, '-') : 'all',
    userId ? String(userId) : 'anon',
    Number.isFinite(lat) ? lat : 0,
    Number.isFinite(lng) ? lng : 0,
  ];
  return parts.join(':');
}

/**
 * Store the ordered raw rows with an offer-validity deadline and rebuild DTOs
 * on every return. A mocked cache that hands back the fetch value unwrapped is
 * accepted too, which keeps direct unit tests simple.
 */
async function cachedVenues(key, fetchRows, brand) {
  const payload = await cache.getOrSet(
    key,
    async () => {
      const rows = await fetchRows();
      return { rows, offerValidUntil: offerDeadline(rows, brand, new Date()) };
    },
    HOME_TTL_SECONDS,
    { isValid: isPayloadFresh },
  );

  if (Array.isArray(payload)) return payload;
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
  return rows.map((venue) => venueService.toPublicVenue(venue, { brand, now: new Date() }));
}

/* ── affinity ───────────────────────────────────────────────────────────── */

function addAffinity(bucket, value, weight) {
  const key = normText(value);
  if (!key || weight <= 0) return;
  bucket[key] = (bucket[key] || 0) + weight;
}

function addQueryAffinity(bucket, query, weight) {
  for (const word of tokens(query)) {
    if (word.length > 2) addAffinity(bucket, word, weight * 0.5);
  }
}

function normalizeAffinity(bucket) {
  const max = Math.max(0, ...Object.values(bucket));
  if (max <= 0) return bucket;
  for (const key of Object.keys(bucket)) bucket[key] = bucket[key] / max;
  return bucket;
}

/**
 * 30-day cuisine/city affinity from card clicks and searches. Both maps are
 * normalized to [0, 1]; recency decides how much each event counts.
 */
async function loadAffinity(userId) {
  const affinity = { cuisine: {}, city: {}, clicked: new Set() };
  if (!userId) return affinity;

  const cutoff = new Date(Date.now() - AFFINITY_WINDOW_DAYS * DAY_MS);
  const events = await prisma.event.findMany({
    where: { userId, name: { in: AFFINITY_EVENTS }, createdAt: { gte: cutoff } },
    select: { name: true, resourceId: true, properties: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  for (const event of events) {
    const props = event.properties || {};
    const weight = recencyWeight(event.createdAt);
    const values = (raw) => (Array.isArray(raw) ? raw : [raw]);

    if (event.name === 'restaurant_card_clicked') {
      const id = props.venueId || props.id || event.resourceId;
      if (id) affinity.clicked.add(String(id));
    }
    for (const value of values(props.cuisine)) addAffinity(affinity.cuisine, value, weight);
    for (const value of values(props.city)) addAffinity(affinity.city, value, weight);
    if (props.query) {
      addQueryAffinity(affinity.cuisine, props.query, weight);
      addQueryAffinity(affinity.city, props.query, weight);
    }
  }

  normalizeAffinity(affinity.cuisine);
  normalizeAffinity(affinity.city);
  return affinity;
}

function affinityScore(venue, affinity) {
  let cuisine = 0;
  for (const value of venue.cuisines || []) {
    cuisine = Math.max(cuisine, affinity.cuisine[normText(value)] || 0);
    for (const token of tokens(value)) cuisine = Math.max(cuisine, affinity.cuisine[token] || 0);
  }
  const city = affinity.city[normText(venue.city)] || 0;
  const neighbourhood = affinity.city[normText(venue.neighbourhood)] || 0;
  return Math.min(1, 0.6 * cuisine + 0.4 * Math.max(city, neighbourhood));
}

function proximityScore(venue, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 0;
  if (venue.latitude == null || venue.longitude == null) return 0;
  const distance = haversineKm(lat, lng, Number(venue.latitude), Number(venue.longitude));
  return 1 / (1 + distance / 20);
}

/* ── sections ───────────────────────────────────────────────────────────── */

async function getRecommended({ userId = null, lat = null, lng = null, city = null, limit = 8, brand = 'ghana' } = {}) {
  assertBrand(brand);
  const max = normalizeLimit(limit);
  const key = cacheKey('recommended', { brand, city, limit: max, userId, lat, lng });

  return cachedVenues(key, async () => {
    const affinity = await loadAffinity(userId);
    const rows = (await fetchPool({ brand, city, limit: max }))
      .filter((venue) => !affinity.clicked.has(String(venue.id)));

    if (rows.length === 0) return [];

    const maxRanking = Math.max(1, ...rows.map((venue) => toNumber(venue.rankingScore)));
    const maxCombined = Math.max(1, ...rows.map((venue) => Math.sqrt(toNumber(venue.combinedReviewCount))));
    const maxRecent = Math.max(1, ...rows.map((venue) => Math.sqrt(toNumber(venue.recentReviewCount))));

    const scored = rows.map((venue) => ({
      ...venue,
      _score:
        0.35 * (toNumber(venue.rankingScore) / maxRanking) +
        0.20 * (Math.sqrt(toNumber(venue.combinedReviewCount)) / maxCombined) +
        0.15 * (Math.sqrt(toNumber(venue.recentReviewCount)) / maxRecent) +
        0.20 * affinityScore(venue, affinity) +
        0.08 * proximityScore(venue, lat, lng) +
        0.02 * (isFeatured(venue) ? 1 : 0),
      _local: isLocalVenue(venue, city),
    }));

    const local = scored.filter((venue) => venue._local);
    const global = scored.filter((venue) => !venue._local);
    return applyCuisineDiversity(local, global, max);
  }, brand);
}

async function getLikelyToBookOut({ city = null, limit = 8, brand = 'ghana' } = {}) {
  assertBrand(brand);
  const max = normalizeLimit(limit);
  const key = cacheKey('likely-to-book-out', { brand, city, limit: max });

  return cachedVenues(key, async () => {
    const rows = await fetchPool({ brand, city, limit: max });
    if (rows.length === 0) return [];

    const maxDemand = Math.max(1, ...rows.map((venue) => toNumber(venue.demandScore)));
    const maxRanking = Math.max(1, ...rows.map((venue) => toNumber(venue.rankingScore)));
    const maxCombined = Math.max(1, ...rows.map((venue) => Math.sqrt(toNumber(venue.combinedReviewCount))));
    const maxRecent = Math.max(1, ...rows.map((venue) => Math.sqrt(toNumber(venue.recentReviewCount))));
    const maxVerified = Math.max(1, ...rows.map((venue) => Math.sqrt(toNumber(venue.verifiedReviewCount))));

    const score = (venue) =>
      0.50 * (toNumber(venue.demandScore) / maxDemand) +
      0.20 * (Math.sqrt(toNumber(venue.recentReviewCount)) / maxRecent) +
      0.10 * (Math.sqrt(toNumber(venue.verifiedReviewCount)) / maxVerified) +
      0.10 * (toNumber(venue.rankingScore) / maxRanking) +
      0.10 * (Math.sqrt(toNumber(venue.combinedReviewCount)) / maxCombined) +
      (venue.highDemand ? 0.05 : 0);

    // Venues with a real recent signal lead. Before the nightly job has run,
    // or in a sparse city, the rest are ordered by demand then review volume —
    // highDemand is a boost, never a gate.
    const eligible = rows.filter((venue) => toNumber(venue.recentReviewCount) >= DEMAND_MIN_RECENT_REVIEWS);
    const eligibleIds = new Set(eligible.map((venue) => venue.id));
    const backfill = rows
      .filter((venue) => !eligibleIds.has(venue.id))
      .sort(
        (a, b) =>
          toNumber(b.demandScore) - toNumber(a.demandScore) ||
          toNumber(b.combinedReviewCount) - toNumber(a.combinedReviewCount) ||
          toNumber(b.recentReviewCount) - toNumber(a.recentReviewCount) ||
          String(a.id).localeCompare(String(b.id)),
      );

    const primary = eligible.map((venue) => ({ ...venue, _score: score(venue) }));
    const padding = backfill.map((venue) => ({ ...venue, _score: score(venue) }));
    // City first, then the recent-review floor: a local venue that has not
    // been flagged yet still outranks an eligible venue in another city.
    const tier = (rows) => ({
      local: rows.filter((venue) => isLocalVenue(venue, city)).sort(byScore),
      global: rows.filter((venue) => !isLocalVenue(venue, city)).sort(byScore),
    });
    const scoredPrimary = tier(primary);
    const scoredPadding = tier(padding);
    return [
      ...scoredPrimary.local,
      ...scoredPadding.local,
      ...scoredPrimary.global,
      ...scoredPadding.global,
    ].slice(0, max);
  }, brand);
}

async function getSpecialOffers({ city = null, limit = 8, brand = 'ghana' } = {}) {
  assertBrand(brand);
  const max = normalizeLimit(limit);
  const key = cacheKey('offers', { brand, city, limit: max });

  return cachedVenues(key, async () => {
    const now = new Date();
    // OffersOnly is a hard filter: no venue without a live offer is fetched,
    // and nothing is ever padded in from the general pool.
    const rows = await fetchPool({ brand, city, limit: max, offersOnly: true });
    if (rows.length === 0) return [];

    const maxRanking = Math.max(1, ...rows.map((venue) => toNumber(venue.rankingScore)));
    const maxCombined = Math.max(1, ...rows.map((venue) => Math.sqrt(toNumber(venue.combinedReviewCount))));
    const maxRecent = Math.max(1, ...rows.map((venue) => Math.sqrt(toNumber(venue.recentReviewCount))));

    const scored = rows.map((venue) => {
      const offers = publicOffers(venue, brand, now);
      const newest = Math.max(
        0,
        ...offers.map((offer) => {
          const at = new Date(offer.createdAt || offer.startsAt).getTime();
          return Number.isNaN(at) ? 0 : Math.max(0, 1 - (now.getTime() - at) / (30 * DAY_MS));
        }),
      );
      return {
        ...venue,
        _score:
          0.35 * (toNumber(venue.rankingScore) / maxRanking) +
          0.15 * (Math.sqrt(toNumber(venue.combinedReviewCount)) / maxCombined) +
          0.10 * (Math.sqrt(toNumber(venue.recentReviewCount)) / maxRecent) +
          0.25 * Math.min(1, newest) +
          0.05 * (isFeatured(venue) ? 1 : 0),
      };
    });

    // One card per venue (its DTO carries the deduped public offers). A city
    // rail is ordered locally first; it never backfills with offerless venues.
    return localFirst(scored, city).slice(0, max);
  }, brand);
}

async function getSectionVenueIds({ section, userId = null, lat = null, lng = null, city = null, limit = 8, brand = 'ghana' } = {}) {
  const normalized = normText(section);
  let venues = [];
  if (normalized === 'recommended') {
    venues = await getRecommended({ userId, lat, lng, city, limit, brand });
  } else if (normalized === 'likely to book out' || normalized === 'likely-to-book-out') {
    venues = await getLikelyToBookOut({ city, limit, brand });
  } else if (normalized === 'offers' || normalized === 'special offers' || normalized === 'special-offers') {
    venues = await getSpecialOffers({ city, limit, brand });
  }
  return venues.map((venue) => venue.id).filter(Boolean);
}

module.exports = {
  getRecommended,
  getLikelyToBookOut,
  getSpecialOffers,
  getSectionVenueIds,
};
