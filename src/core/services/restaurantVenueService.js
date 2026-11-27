/**
 * Restaurant venue read model.
 *
 * Everything here is a read path: the catalogue is curated/imported in this
 * slice, so there is no write endpoint yet. Two rules shape the queries:
 *
 *   1. A venue is only visible through an ACTIVE per-brand listing, exactly the
 *      way a Tour is only visible through TravioGhanaTour/ExpeditionTour.
 *   2. Ordering happens on stored columns (rankingScore, demandScore,
 *      combinedReviewCount, createdAt). Never on a computed aggregate — a
 *      value computed at request time cannot order a paginated list.
 *   3. Offers and high demand are stored facts. A request may filter on them,
 *      but never derives them from review rows.
 *
 * Pagination is keyset, not offset: the cursor carries the sort value and the
 * row id, so page 500 costs the same as page 1.
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const AppError = require('./appError');
const locationService = require('./locationService');
const { roundOne } = require('./restaurantVenueStats');

const LIST_TTL_SECONDS = 60;
const DETAIL_TTL_SECONDS = 300;
const REVIEWS_TTL_SECONDS = 120;

const BRANDS = ['ghana', 'africa', 'expedition'];
const SORTS = ['rating', 'reviews', 'newest', 'demand'];

const REVIEW_FEED_TTL_SECONDS = 120;

/* ── cursor helpers ─────────────────────────────────────────────────────── */

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode a cursor and refuse one minted for a different sort. A rating cursor
 * fed to a `newest` query would silently skip or repeat rows, so the mismatch
 * is a 400 rather than a wrong page.
 */
function decodeListCursor(cursor, sort) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new AppError('Invalid cursor', 400, { code: 'INVALID_CURSOR' });
  }
  if (!parsed || typeof parsed !== 'object' || !('v' in parsed) || !parsed.id) {
    throw new AppError('Invalid cursor', 400, { code: 'INVALID_CURSOR' });
  }
  if (parsed.s !== sort) {
    throw new AppError('Cursor does not match the requested sort', 400, {
      code: 'CURSOR_SORT_MISMATCH',
    });
  }
  return parsed;
}

function decodeReviewCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new AppError('Invalid cursor', 400, { code: 'INVALID_CURSOR' });
  }
  const at = parsed && parsed.c ? new Date(parsed.c) : null;
  if (!parsed || !parsed.id || !at || Number.isNaN(at.getTime())) {
    throw new AppError('Invalid cursor', 400, { code: 'INVALID_CURSOR' });
  }
  return { at, id: parsed.id };
}

/* ── where / order builders ─────────────────────────────────────────────── */

function listingFilter(brand, featured) {
  return {
    brand,
    isActive: true,
    ...(featured ? { isFeatured: true } : {}),
  };
}

/**
 * An offer is only public when it belongs to the requested brand, its switch
 * is on and "now" is inside its window. Null bounds are open-ended.
 * `offerWindowFilter` is the Prisma predicate used by the `hasOffer` facet;
 * `isPublicOffer` is the DTO guard. The relation is loaded without a time
 * filter so a cached row can be re-checked against the clock on every read.
 */
function offerWindowFilter(brand, now = new Date()) {
  return {
    brand,
    isActive: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
    ],
  };
}

function isPublicOffer(offer, brand, now) {
  if (!offer || offer.isActive === false || offer.brand !== brand) return false;
  if (offer.startsAt && new Date(offer.startsAt) > now) return false;
  if (offer.endsAt && new Date(offer.endsAt) < now) return false;
  return true;
}

/**
 * Load every switch-on offer for the brand, including ones whose window has
 * not opened yet. The DTO applies the clock; the cached payload records the
 * next boundary so a cache hit never outlives an offer start or expiry.
 */
function offerInclude(brand) {
  return {
    where: { brand, isActive: true },
    select: {
      id: true,
      brand: true,
      title: true,
      discountType: true,
      discountValue: true,
      promoCode: true,
      startsAt: true,
      endsAt: true,
      isActive: true,
    },
  };
}

function collectOffers(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectOffers(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    if ('startsAt' in value && 'endsAt' in value) out.push(value);
    for (const nested of [
      value.offers,
      value.venue,
      value.venues,
      value.restaurants,
      value.rows,
    ]) {
      collectOffers(nested, out);
    }
  }
  return out;
}

/** Earliest future start/end that can change a public offers[] payload. */
function offerValidUntil(payload, brand, now = new Date()) {
  const nowMs = now.getTime();
  let deadline = null;
  for (const offer of collectOffers(payload)) {
    if (offer.isActive === false || (offer.brand && offer.brand !== brand)) continue;
    for (const raw of [offer.startsAt, offer.endsAt]) {
      if (!raw) continue;
      const at = new Date(raw).getTime();
      if (Number.isNaN(at) || at <= nowMs) continue;
      if (deadline === null || at < deadline) deadline = at;
    }
  }
  return deadline;
}

/** Cache freshness guard passed to cacheHelper.getOrSet. */
function isOfferPayloadFresh(payload) {
  return !payload || !payload.offerValidUntil || payload.offerValidUntil > Date.now();
}

function isoOrNull(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function cursorFilter(sort, cursor) {
  if (!cursor) return null;

  if (sort === 'rating') {
    // Unrated venues sort last behind `rankingScore: null`; a cursor from that
    // tail carries v:null and continues within the null block by id.
    if (cursor.v === null) {
      return { AND: [{ rankingScore: null }, { id: { lt: cursor.id } }] };
    }
    return {
      OR: [
        { rankingScore: { lt: cursor.v } },
        { AND: [{ rankingScore: cursor.v }, { id: { lt: cursor.id } }] },
      ],
    };
  }

  if (sort === 'reviews') {
    return {
      OR: [
        { combinedReviewCount: { lt: cursor.v } },
        { AND: [{ combinedReviewCount: cursor.v }, { id: { lt: cursor.id } }] },
      ],
    };
  }

  if (sort === 'demand') {
    // Same shape as `rating`: an unrated venue has no demand score and sorts
    // last, with a null cursor continuing inside that tail by id.
    if (cursor.v === null) {
      return { AND: [{ demandScore: null }, { id: { lt: cursor.id } }] };
    }
    return {
      OR: [
        { demandScore: { lt: cursor.v } },
        { AND: [{ demandScore: cursor.v }, { id: { lt: cursor.id } }] },
      ],
    };
  }

  const at = new Date(cursor.v);
  if (Number.isNaN(at.getTime())) {
    throw new AppError('Invalid cursor', 400, { code: 'INVALID_CURSOR' });
  }
  return {
    OR: [
      { createdAt: { lt: at } },
      { AND: [{ createdAt: at }, { id: { lt: cursor.id } }] },
    ],
  };
}

function orderFor(sort) {
  if (sort === 'reviews') {
    return [{ combinedReviewCount: 'desc' }, { id: 'desc' }];
  }
  if (sort === 'newest') {
    return [{ createdAt: 'desc' }, { id: 'desc' }];
  }
  if (sort === 'demand') {
    return [{ demandScore: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
  }
  return [{ rankingScore: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
}

/* ── DTOs ───────────────────────────────────────────────────────────────── */

/**
 * Published menu DTO for the detail page.
 *
 * Kept local instead of importing `restaurantVenueMenuService`: that service
 * imports the access module, which imports `BRANDS` from this file, so
 * requiring it here would close a cycle and leave BRANDS undefined at load.
 */
function toPublicMenu(menu) {
  return {
    id: menu.id,
    name: menu.name,
    description: menu.description ?? null,
    currency: menu.currency,
    sections: (menu.sections || []).map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description ?? null,
      items: (section.items || []).map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description ?? null,
        priceMinor: item.priceMinor ?? null,
        currency: item.currency,
        dietary: item.dietary || [],
        isAvailable: item.isAvailable,
        photoUrl: item.photoUrl ?? null,
      })),
    })),
  };
}

function toPublicVenue(venue, { detail = false, brand = 'ghana', now = new Date() } = {}) {
  const dto = {
    id: venue.id,
    slug: venue.slug,
    name: venue.name,
    city: venue.city,
    region: venue.region,
    country: venue.country,
    neighbourhood: venue.neighbourhood,
    addressLine: venue.addressLine,
    latitude: venue.latitude,
    longitude: venue.longitude,
    cuisines: venue.cuisines || [],
    dietary: venue.dietary || [],
    priceBand: venue.priceBand,
    amenities: venue.amenities || [],
    hours: venue.hours || null,
    timezone: venue.timezone,
    phone: venue.phone,
    website: venue.website,
    photos: venue.photos || [],
    coverPhoto: venue.coverPhoto,
    // Our own rating only. External aggregates are returned beside it with the
    // source name — a blended star score is neither honest nor, when the
    // source is licensed, permitted.
    rating: venue.averageRating == null ? null : roundOne(venue.averageRating),
    reviewCount: venue.reviewCount || 0,
    recentRating: venue.recentRating == null ? null : roundOne(venue.recentRating),
    recentReviewCount: venue.recentReviewCount || 0,
    // Stored batch flag only. The score itself is an internal ranking input.
    highDemand: Boolean(venue.highDemand),
    external: venue.externalSource
      ? {
          source: venue.externalSource,
          rating: venue.externalRating == null ? null : roundOne(venue.externalRating),
          reviewCount: venue.externalReviewCount || 0,
        }
      : null,
    verifiedReviewCount: venue.verifiedReviewCount || 0,
    distribution: venue.distribution || null,
    rank:
      venue.rankInCity != null
        ? { position: venue.rankInCity, of: venue.cityVenueCount || null }
        : null,
    featured: Boolean(venue.listings && venue.listings[0] && venue.listings[0].isFeatured),
    displayOrder:
      venue.listings && venue.listings[0] ? venue.listings[0].displayOrder : 0,
    offers: (venue.offers || [])
      .filter((offer) => isPublicOffer(offer, brand, now))
      .map((offer) => ({
        id: offer.id,
        title: offer.title,
        discountType: offer.discountType,
        discountValue: offer.discountValue == null ? 0 : Number(offer.discountValue),
        promoCode: offer.promoCode || null,
        endsAt: isoOrNull(offer.endsAt),
      })),
  };

  if (detail) {
    dto.description = venue.description;
    dto.menuUrl = venue.menuUrl || null;
    dto.menus = (venue.menus || []).map(toPublicMenu);
    dto.mealTypes = venue.mealTypes || [];
    dto.externalStats = (venue.externalStats || []).map((row) => ({
      source: row.source,
      rating: row.rating == null ? null : roundOne(Number(row.rating)),
      reviewCount: row.reviewCount || 0,
      distribution: row.distribution || null,
      productUrl: row.productUrl || null,
      syncedAt: row.syncedAt,
    }));
  }

  return dto;
}

/**
 * Public review DTO. Built field by field on purpose: the row carries
 * `proofRef` (an internal token reference), `ipHash` and `userAgentHash`, and
 * none of those may leave the building. The author is name + avatar only —
 * never email or id.
 */
function toPublicReview(review) {
  return {
    id: review.id,
    rating: review.rating,
    foodRating: review.foodRating,
    serviceRating: review.serviceRating,
    atmosphereRating: review.atmosphereRating,
    valueRating: review.valueRating,
    title: review.title,
    body: review.body,
    photos: review.photos || [],
    companions: review.companions || [],
    visitedAt: review.visitedAt,
    source: review.source,
    verified: review.source === 'TRAVIO_VERIFIED',
    helpfulCount: review.helpfulCount || 0,
    author: {
      name: review.author ? review.author.name : null,
      photoURL: review.author ? review.author.photoURL : null,
    },
    createdAt: review.createdAt,
  };
}

/**
 * Cross-venue feed DTO. Field by field, like toPublicReview: the review row
 * also carries proofRef/ipHash/userAgentHash, and none of them may leave. Only
 * the venue identity a storefront card needs is added.
 */
function toFeedReview(review) {
  const venue = review.venue;
  const venuePhotos = (venue && venue.photos) || [];

  return {
    id: review.id,
    venueId: review.venueId,
    venueName: venue ? venue.name : null,
    venueSlug: venue ? venue.slug : null,
    venueCity: venue ? venue.city : null,
    // The card artwork is the venue's cover photo, falling back to its first
    // gallery image. No internal venue fields are exposed here.
    venueCoverPhoto: venue ? venue.coverPhoto || venuePhotos[0] || null : null,
    rating: review.rating,
    title: review.title,
    body: review.body,
    createdAt: review.createdAt,
    author: {
      name: review.author ? review.author.name : null,
      photoURL: review.author ? review.author.photoURL : null,
    },
    verified: review.source === 'TRAVIO_VERIFIED',
  };
}

/* ── queries ────────────────────────────────────────────────────────────── */

function listCacheKey(params) {
  const normalized = {
    brand: params.brand,
    q: params.q || null,
    city: params.city || null,
    cuisine: params.cuisine || null,
    dietary: params.dietary || null,
    priceBand: params.priceBand || null,
    featured: Boolean(params.featured),
    highDemand: Boolean(params.highDemand),
    hasOffer: Boolean(params.hasOffer),
    minRating: params.minRating ?? null,
    minReviews: params.minReviews ?? null,
    lat: params.lat ?? null,
    lng: params.lng ?? null,
    radiusKm: params.radiusKm ?? null,
    sort: params.sort,
    limit: params.limit,
    cursor: params.cursor || null,
  };
  const hash = crypto.createHash('md5').update(JSON.stringify(normalized)).digest('hex');
  return `rv:list:${params.brand}:${hash}`;
}

/**
 * Approximate radius filter for map-server place searches.
 *
 * A true haversine sort would need raw SQL and would make keyset pagination
 * expensive. A latitude/longitude bounding box is enough for a 1–50 km
 * discovery radius, uses the existing lat/lng index, and never returns a
 * venue without coordinates.
 */
function nearFilter(lat, lng, radiusKm) {
  const radius = radiusKm || 10;
  const latDelta = radius / 111;
  const lngDelta = radius / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return {
    latitude: { gte: lat - latDelta, lte: lat + latDelta },
    longitude: { gte: lng - lngDelta, lte: lng + lngDelta },
  };
}

/* ── free-text search ───────────────────────────────────────────────────── */

/** Generic words that add no signal to a restaurant name search. */
const SEARCH_STOP_WORDS = new Set([
  'the',
  'and',
  'of',
  'a',
  'an',
  'restaurant',
  'restaurants',
]);

/**
 * Split a free-text restaurant query into matchable tokens.
 *
 * A plain `contains` on the raw query misses real catalogue names because the
 * stored name and what a diner types differ in punctuation:
 *
 *   "Vixies"                    → ["vixies"]   (callers also try "vixie")
 *   "Vixie's"                   → ["vixie"]
 *   "Simret – The Taste of..."  → ["simret", "taste", "ethiopia"]
 *   "vida e caffè"              → ["vida", "caffe"]
 *
 * Matching the ASCII slug as well as the name covers accented names, since
 * slugs are generated without diacritics ("Café de Kumasi" → cafe-de-kumasi).
 */
function searchTokens(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token));
}

/**
 * Fields a single token may match. Slugs are ASCII and indexed, which is what
 * lets "cafe" find "New Life Café" and "vixie" find "Vixie's Delicacies".
 */
function tokenFields(token) {
  return [
    { name: { contains: token, mode: 'insensitive' } },
    { slug: { contains: token, mode: 'insensitive' } },
    { city: { contains: token, mode: 'insensitive' } },
    { region: { contains: token, mode: 'insensitive' } },
    { neighbourhood: { contains: token, mode: 'insensitive' } },
    { cuisines: { has: token } },
  ];
}

function baseWhere({
  brand,
  q,
  city,
  cuisine,
  dietary,
  priceBand,
  featured,
  highDemand,
  hasOffer,
  minRating,
  minReviews,
  lat,
  lng,
  radiusKm,
  now = new Date(),
}) {
  const where = {
    status: 'ACTIVE',
    listings: { some: listingFilter(brand, featured) },
  };
  const and = [];

  // Both filters are ANDed with the active-listing brand scope above: an
  // inactive listing or a different brand's offer can never satisfy them.
  if (highDemand === true) where.highDemand = true;
  if (hasOffer === true) where.offers = { some: offerWindowFilter(brand, now) };

  if (q) {
    const tokens = searchTokens(q);
    const tokenGroups = tokens.map((token) => {
      // Possessive/plural names: "Vixies" should still find "Vixie's".
      const variants = [token];
      if (token.length > 4 && token.endsWith('s')) variants.push(token.slice(0, -1));
      return {
        OR: variants.flatMap((variant) => tokenFields(variant)),
      };
    });

    and.push({
      OR: [
        // Exact phrase / facet hit first — keeps the existing behaviour for
        // clean queries and cuisine names.
        { name: { contains: q, mode: 'insensitive' } },
        { city: { contains: q, mode: 'insensitive' } },
        { region: { contains: q, mode: 'insensitive' } },
        { neighbourhood: { contains: q, mode: 'insensitive' } },
        { cuisines: { has: q.toLowerCase() } },
        // Punctuation/possessive/accent-tolerant: every meaningful token must
        // appear somewhere (name or ASCII slug, or a place facet).
        ...(tokenGroups.length > 0 ? [{ AND: tokenGroups }] : []),
      ],
    });
  }
  if (lat != null && lng != null) {
    and.push(nearFilter(lat, lng, radiusKm));
  }
  if (city) where.city = { equals: city, mode: 'insensitive' };
  if (cuisine) where.cuisines = { has: cuisine };
  if (Array.isArray(dietary) && dietary.length > 0) where.dietary = { hasEvery: dietary };
  if (priceBand) where.priceBand = priceBand;
  if (minRating != null) where.combinedRating = { gte: minRating };
  if (minReviews != null) where.combinedReviewCount = { gte: minReviews };

  if (and.length > 0) where.AND = and;
  return where;
}

async function listVenues(params) {
  const { sort = 'rating', limit = 20, cursor, brand } = params;

  if (!BRANDS.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }
  if (!SORTS.includes(sort)) {
    throw new AppError('Unknown sort', 400, { code: 'INVALID_SORT' });
  }

  const key = listCacheKey({ ...params, brand, sort, limit });

  // Cache raw rows, not DTOs: offers[] is rebuilt with the current clock on
  // every return, so an expired discount can never be served from a hit.
  const cached = await cache.getOrSet(
    key,
    async () => {
      const decoded = cursor ? decodeListCursor(cursor, sort) : null;
      const now = new Date();
      const where = baseWhere({ ...params, brand, now });
      const cursorWhere = cursorFilter(sort, decoded);
      if (cursorWhere) {
        where.AND = [...(where.AND || []), cursorWhere];
      }

      // +1 decides hasMore without a second COUNT over the same predicate.
      const rows = await prisma.restaurantVenue.findMany({
        where,
        orderBy: orderFor(sort),
        take: limit + 1,
        include: {
          listings: {
            where: { brand },
            select: { isFeatured: true, displayOrder: true },
          },
          offers: offerInclude(brand),
        },
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];

      let nextCursor = null;
      if (hasMore && last) {
        const v =
          sort === 'rating'
            ? last.rankingScore
            : sort === 'reviews'
              ? last.combinedReviewCount
              : sort === 'demand'
                ? last.demandScore
                : last.createdAt.toISOString();
        nextCursor = encodeCursor({ s: sort, v, id: last.id });
      }

      return {
        rows: page,
        pagination: { limit, hasMore, nextCursor },
        offerValidUntil: offerValidUntil(page, brand, now),
      };
    },
    LIST_TTL_SECONDS,
    { isValid: isOfferPayloadFresh },
  );

  return {
    venues: cached.rows.map((venue) => toPublicVenue(venue, { brand, now: new Date() })),
    pagination: cached.pagination,
  };
}

function mapPlaceLabel(row, needle) {
  const parts = String(row.formatted || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/^ghana$/i.test(part));
  const query = String(needle || '').toLowerCase().trim();
  // Prefer the exact segment the reader typed: "La, Osu, Accra" + "Osu" must
  // read as "Osu", not as the first segment or the containing city.
  const matched = parts.find((part) => part.toLowerCase().includes(query));
  if (query && matched) return matched;
  const city = String(row.city || '').trim();
  if (city && parts[0] && parts[0].toLowerCase() === city.toLowerCase()) return city;
  if (parts.length > 1) return parts.slice(0, 2).join(', ');
  return city || parts[0] || String(row.formatted || '').trim();
}

/**
 * Typeahead for the restaurant search bar.
 *
 * Restaurants answer name/cuisine queries. Places answer "where" queries:
 * directory cities come from our own listings, and the map server fills in
 * neighbourhoods and towns. A map place is only returned when at least one
 * restaurant falls inside its 10 km box, so selecting "Osu" cannot land on an
 * empty namesake in another region.
 */
async function suggestVenues({ brand = 'ghana', q, limit = 6 }) {
  if (!BRANDS.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }
  const needle = String(q || '').trim();
  const max = Math.min(Math.max(Number(limit) || 6, 1), 8);
  if (needle.length < 2) return { restaurants: [], places: [] };

  const key = `rv:suggest:${brand}:${crypto
    .createHash('md5')
    .update(`${needle.toLowerCase()}:${max}`)
    .digest('hex')}`;

  const cached = await cache.getOrSet(
    key,
    async () => {
      const now = new Date();
      const restaurantRows = await prisma.restaurantVenue.findMany({
        where: baseWhere({ brand, q: needle, now }),
        orderBy: orderFor('rating'),
        take: max,
        include: {
          listings: {
            where: { brand },
            select: { isFeatured: true, displayOrder: true },
          },
          offers: offerInclude(brand),
        },
      });

      const cityRows = await prisma.restaurantVenue
        .groupBy({
          by: ['city', 'region'],
          where: {
            status: 'ACTIVE',
            city: { contains: needle, mode: 'insensitive' },
            listings: { some: listingFilter(brand) },
          },
          _count: { _all: true },
        })
        .catch(() => []);

      const places = cityRows
        .filter((row) => row.city)
        .map((row) => ({
          name: row.city,
          subtitle: [row.region, 'Ghana'].filter(Boolean).join(', '),
          region: row.region || null,
          latitude: null,
          longitude: null,
          restaurantCount: row._count?._all || 0,
          radiusKm: null,
          source: 'directory',
        }));

      const mapRows = await locationService.autocomplete(needle, 8).catch(() => []);
      const ghanaMapRows = mapRows.filter((row) => {
        const code = String(row.countryCode || '').toLowerCase();
        const country = String(row.country || '').toLowerCase();
        return code === 'gh' || country === 'ghana';
      });

      await Promise.all(
        ghanaMapRows.map(async (row) => {
          if (row.latitude == null || row.longitude == null) return;
          const count = await prisma.restaurantVenue
            .count({
              where: {
                ...baseWhere({ brand }),
                ...nearFilter(row.latitude, row.longitude, 10),
              },
            })
            .catch(() => 0);
          if (count <= 0) return;
          places.push({
            name: mapPlaceLabel(row, needle),
            subtitle: [row.region, 'Ghana'].filter(Boolean).join(', '),
            region: row.region || null,
            latitude: row.latitude,
            longitude: row.longitude,
            restaurantCount: count,
            radiusKm: 10,
            source: 'map',
          });
        }),
      );

      const deduped = [];
      const seen = new Set();
      for (const place of places.sort((a, b) => b.restaurantCount - a.restaurantCount)) {
        const keyName = String(place.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const keyPoint =
          place.latitude == null ? 'directory' : `${place.latitude.toFixed(3)}:${place.longitude.toFixed(3)}`;
        const dedupeKey = `${keyName}:${keyPoint}`;
        if (!keyName || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        deduped.push(place);
      }

      return {
        restaurants: restaurantRows,
        places: deduped.slice(0, max),
        offerValidUntil: offerValidUntil(restaurantRows, brand, now),
      };
    },
    60,
    { isValid: isOfferPayloadFresh },
  );

  return {
    restaurants: cached.restaurants.map((venue) =>
      toPublicVenue(venue, { brand, now: new Date() }),
    ),
    places: cached.places,
  };
}

async function getVenue(slugOrId, brand) {
  if (!BRANDS.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }
  const needle = String(slugOrId || '').trim();
  if (!needle) {
    throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });
  }

  const key = `rv:detail:${brand}:${needle}`;

  const cached = await cache.getOrSet(
    key,
    async () => {
      const now = new Date();
      const venue = await prisma.restaurantVenue.findFirst({
        where: {
          status: 'ACTIVE',
          listings: { some: { brand, isActive: true } },
          OR: [{ slug: needle }, { id: needle }],
        },
        include: {
          listings: {
            where: { brand },
            select: { isFeatured: true, displayOrder: true },
          },
          offers: offerInclude(brand),
          menus: {
            where: { status: 'PUBLISHED' },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            include: {
              sections: {
                orderBy: { position: 'asc' },
                include: { items: { orderBy: { position: 'asc' } } },
              },
            },
          },
          externalStats: {
            orderBy: { source: 'asc' },
            select: {
              source: true,
              rating: true,
              reviewCount: true,
              distribution: true,
              productUrl: true,
              syncedAt: true,
            },
          },
        },
      });

      if (!venue) return null;
      return {
        venue,
        offerValidUntil: offerValidUntil(venue, brand, now),
      };
    },
    DETAIL_TTL_SECONDS,
    { isValid: isOfferPayloadFresh },
  );

  if (!cached || !cached.venue) return null;
  return toPublicVenue(cached.venue, { detail: true, brand, now: new Date() });
}

/**
 * Resolve a slug or id to a venue id without loading the detail payload.
 * The reviews endpoint needs the identity only; fetching hours, photos and
 * external stats to then throw them away is wasted work on every page.
 */
async function resolveVenueId(slugOrId, brand) {
  if (!BRANDS.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }
  const needle = String(slugOrId || '').trim();
  if (!needle) return null;

  const venue = await prisma.restaurantVenue.findFirst({
    where: {
      status: 'ACTIVE',
      listings: { some: { brand, isActive: true } },
      OR: [{ slug: needle }, { id: needle }],
    },
    select: { id: true },
  });
  return venue ? venue.id : null;
}

async function listReviews(venueId, { limit = 10, cursor, rating, verified } = {}) {
  const key = `rv:reviews:${venueId}:${crypto
    .createHash('md5')
    .update(JSON.stringify({ limit, cursor: cursor || null, rating: rating ?? null, verified: verified ?? null }))
    .digest('hex')}`;

  return cache.getOrSet(
    key,
    async () => {
      const venue = await prisma.restaurantVenue.findFirst({
        where: { id: venueId, status: 'ACTIVE' },
        select: { id: true, distribution: true, combinedRating: true, combinedReviewCount: true },
      });
      if (!venue) return null;

      const where = { venueId, status: 'APPROVED' };
      if (rating) where.rating = rating;
      if (verified === true) where.source = 'TRAVIO_VERIFIED';
      if (verified === false) where.source = { not: 'TRAVIO_VERIFIED' };

      const decoded = cursor ? decodeReviewCursor(cursor) : null;
      if (decoded) {
        where.OR = [
          { createdAt: { lt: decoded.at } },
          { AND: [{ createdAt: decoded.at }, { id: { lt: decoded.id } }] },
        ];
      }

      const rows = await prisma.restaurantVenueReview.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          rating: true,
          foodRating: true,
          serviceRating: true,
          atmosphereRating: true,
          valueRating: true,
          title: true,
          body: true,
          photos: true,
          companions: true,
          visitedAt: true,
          source: true,
          helpfulCount: true,
          createdAt: true,
          author: { select: { name: true, photoURL: true } },
        },
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];

      return {
        reviews: page.map(toPublicReview),
        distribution: venue.distribution || null,
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && last
              ? encodeCursor({ c: last.createdAt.toISOString(), id: last.id })
              : null,
        },
      };
    },
    REVIEWS_TTL_SECONDS,
  );
}

/**
 * Cross-venue "What Diners Are Saying" feed.
 *
 * Approved reviews only, from ACTIVE venues with an ACTIVE listing for the
 * requested brand — the same visibility rule as the catalogue, not a looser
 * one. Ordering and cursor are identical to the per-venue list so a feed page
 * can be resumed without a second sort key. The stats block always describes
 * the full visible feed, never the current cursor page.
 */
async function listReviewFeed({ brand, limit = 10, cursor } = {}) {
  if (!BRANDS.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }

  const key = `rv:feed:${brand}:${crypto
    .createHash('md5')
    .update(JSON.stringify({ limit, cursor: cursor || null }))
    .digest('hex')}`;

  return cache.getOrSet(
    key,
    async () => {
      // Stats describe the whole visible feed, not the current cursor page.
      const statsWhere = {
        status: 'APPROVED',
        venue: {
          status: 'ACTIVE',
          listings: { some: listingFilter(brand) },
        },
      };
      const where = { ...statsWhere };

      const decoded = cursor ? decodeReviewCursor(cursor) : null;
      if (decoded) {
        where.OR = [
          { createdAt: { lt: decoded.at } },
          { AND: [{ createdAt: decoded.at }, { id: { lt: decoded.id } }] },
        ];
      }

      const [rows, stats] = await Promise.all([
        prisma.restaurantVenueReview.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          select: {
            id: true,
            venueId: true,
            rating: true,
            title: true,
            body: true,
            source: true,
            createdAt: true,
            venue: {
              select: {
                id: true,
                name: true,
                slug: true,
                city: true,
                coverPhoto: true,
                photos: true,
              },
            },
            author: { select: { name: true, photoURL: true } },
          },
        }),
        prisma.restaurantVenueReview.aggregate({
          where: statsWhere,
          _avg: { rating: true },
          _count: { _all: true },
        }),
      ]);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const average = stats && stats._avg ? stats._avg.rating : null;
      const total = stats && stats._count ? stats._count._all : 0;

      return {
        reviews: page.map(toFeedReview),
        stats: {
          averageRating: average == null ? null : Math.round(average * 10) / 10,
          totalReviews: total || 0,
        },
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && last
              ? encodeCursor({ c: last.createdAt.toISOString(), id: last.id })
              : null,
        },
      };
    },
    REVIEW_FEED_TTL_SECONDS,
  );
}

module.exports = {
  BRANDS,
  SORTS,
  encodeCursor,
  decodeListCursor,
  decodeReviewCursor,
  searchTokens,
  listVenues,
  suggestVenues,
  getVenue,
  resolveVenueId,
  listReviews,
  listReviewFeed,
  toPublicVenue,
  toPublicReview,
  toFeedReview,
  offerWindowFilter,
  isPublicOffer,
  offerValidUntil,
  isOfferPayloadFresh,
};
