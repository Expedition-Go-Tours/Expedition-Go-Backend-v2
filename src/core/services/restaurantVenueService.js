/**
 * Restaurant venue read model.
 *
 * Everything here is a read path: the catalogue is curated/imported in this
 * slice, so there is no write endpoint yet. Two rules shape the queries:
 *
 *   1. A venue is only visible through an ACTIVE per-brand listing, exactly the
 *      way a Tour is only visible through TravioGhanaTour/ExpeditionTour.
 *   2. Ordering happens on stored columns (rankingScore, combinedReviewCount,
 *      createdAt). Never on a computed aggregate — a value computed at request
 *      time cannot order a paginated list consistently.
 *
 * Pagination is keyset, not offset: the cursor carries the sort value and the
 * row id, so page 500 costs the same as page 1.
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const AppError = require('./appError');
const { roundOne } = require('./restaurantVenueStats');

const LIST_TTL_SECONDS = 60;
const DETAIL_TTL_SECONDS = 300;
const REVIEWS_TTL_SECONDS = 120;

const BRANDS = ['ghana', 'africa', 'expedition'];
const SORTS = ['rating', 'reviews', 'newest'];

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
  return [{ rankingScore: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
}

/* ── DTOs ───────────────────────────────────────────────────────────────── */

function toPublicVenue(venue, { detail = false } = {}) {
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
  };

  if (detail) {
    dto.description = venue.description;
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
    minRating: params.minRating ?? null,
    minReviews: params.minReviews ?? null,
    sort: params.sort,
    limit: params.limit,
    cursor: params.cursor || null,
  };
  const hash = crypto.createHash('md5').update(JSON.stringify(normalized)).digest('hex');
  return `rv:list:${params.brand}:${hash}`;
}

function baseWhere({ brand, q, city, cuisine, dietary, priceBand, featured, minRating, minReviews }) {
  const where = {
    status: 'ACTIVE',
    listings: { some: listingFilter(brand, featured) },
  };
  const and = [];

  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { city: { contains: q, mode: 'insensitive' } },
        { neighbourhood: { contains: q, mode: 'insensitive' } },
      ],
    });
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

  return cache.getOrSet(
    key,
    async () => {
      const decoded = cursor ? decodeListCursor(cursor, sort) : null;
      const where = baseWhere({ ...params, brand });
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
              : last.createdAt.toISOString();
        nextCursor = encodeCursor({ s: sort, v, id: last.id });
      }

      return {
        venues: page.map((venue) => toPublicVenue(venue)),
        pagination: { limit, hasMore, nextCursor },
      };
    },
    LIST_TTL_SECONDS,
  );
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

  return cache.getOrSet(
    key,
    async () => {
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
      return toPublicVenue(venue, { detail: true });
    },
    DETAIL_TTL_SECONDS,
  );
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

module.exports = {
  BRANDS,
  SORTS,
  encodeCursor,
  decodeListCursor,
  decodeReviewCursor,
  listVenues,
  getVenue,
  resolveVenueId,
  listReviews,
  toPublicVenue,
  toPublicReview,
};
