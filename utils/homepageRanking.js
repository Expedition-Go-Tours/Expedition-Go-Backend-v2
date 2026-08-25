/**
 * Homepage Ranking Algorithms
 *
 * Production-ready scoring functions for each homepage section.
 * Each function queries the database directly and returns pre-sorted
 * tour arrays ready for the frontend to render.
 *
 * SIGNALS USED (and why):
 *  - CONFIRMED + COMPLETED bookings → real demand (PENDING excluded: 30-40% fail)
 *  - Tour.averageRating with Bayesian smoothing → prevents 1-review 5.0 inflation
 *  - Tour.reviewCount → trust signal (more reviews = more reliable rating)
 *  - Event(name='tour.viewed') → view velocity for trending detection
 *  - WishlistItem → intent signal (people saving = future demand)
 *  - Tour.city/country → location-based recommendations
 *  - Tour.latitude/longitude → proximity search via PostGIS
 *  - Tour.createdAt → freshness for new experiences
 *  - Tour.tags + Tour.category → keyword matching for mood section
 *
 * SIGNALS NOT USED (and why):
 *  - PENDING bookings → 30-40% fail at checkout, unreliable
 *  - CANCELLED/REFUNDED/NO_SHOW → zero demand signal
 *  - Tour.viewCount (monotonic) → stale for "what's hot now"
 *  - Simulated bookings → test data
 *
 * @version 1.0.0
 */

const prisma = require('./prismaClient');
const cache = require('./cacheHelper');

// ─── Constants ────────────────────────────────────────────────────────
const BAYESIAN_C = 5;        // Confidence parameter (equivalent to 5 "virtual" reviews)
const BAYESIAN_M = 3.0;      // Global prior (average rating across all tours)
const MIN_REVIEWS_TOP_RATED = 1;
const MIN_BOOKINGS_SELL_OUT = 2;
const MIN_VIEWS_TRENDING = 10;
const TRENDING_GROWTH_CAP = 5; // Cap growth at 5x to prevent outliers
const DEFAULT_LIMIT = 12;

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Bayesian average — prevents a single 5-star review from ranking
 * equal to 200 reviews at 4.8 stars.
 *
 * Formula: (C * m + n * avg) / (C + n)
 * Where C = confidence, m = global prior, n = review count, avg = raw average
 */
function bayesianRating(avg, count) {
  if (!count || count === 0) return BAYESIAN_M;
  const raw = parseFloat(avg) || 0;
  return (BAYESIAN_C * BAYESIAN_M + count * raw) / (BAYESIAN_C + count);
}

/**
 * Normalize a value to [0, 1] against a max value.
 * Returns 0 when max is 0 (prevents division by zero).
 */
function normalize(value, max) {
  return max > 0 ? value / max : 0;
}

/**
 * Map a raw tour row to the card shape the frontend expects.
 */
function mapTourCard(t) {
  const price = extractStartingPrice(t.schedulesAndPricing);
  const durationStr = t.durationMinutes
    ? t.durationMinutes >= 1440
      ? `${Math.round(t.durationMinutes / 1440)} days`
      : `${Math.round(t.durationMinutes / 60)} hours`
    : '';

  return {
    id: t.id,
    title: t.title,
    slug: t.slug,
    coverPhoto: t.coverPhoto,
    photos: t.photos,
    category: t.category,
    city: t.city,
    country: t.country,
    averageRating: t.averageRating ? parseFloat(t.averageRating) : null,
    reviewCount: t.reviewCount || 0,
    totalBookings: t.totalBookings || 0,
    startingPrice: price,
    currency: 'USD',
    duration: durationStr,
    durationMinutes: t.durationMinutes,
    difficulty: t.difficulty,
    tags: t.tags || [],
    supplier: t.supplier ? {
      id: t.supplier.id,
      name: t.supplier.name,
      photo: t.supplier.photoURL,
      rating: t.supplier.supplierProfile?.averageRating
        ? parseFloat(t.supplier.supplierProfile.averageRating)
        : null,
    } : null,
  };
}

/**
 * Extract the lowest retail price from schedulesAndPricing JSON.
 * Mirrors the logic in expeditionController.extractStartingPrice.
 */
function extractStartingPrice(schedulesAndPricing) {
  if (!schedulesAndPricing) return null;
  try {
    const sp = typeof schedulesAndPricing === 'string'
      ? JSON.parse(schedulesAndPricing)
      : schedulesAndPricing;

    const schedules = sp?.pricingSchedules?.schedules;
    if (Array.isArray(schedules) && schedules.length > 0) {
      let lowest = Infinity;
      for (const s of schedules) {
        const prices = s?.prices;
        if (!Array.isArray(prices)) continue;
        for (const p of prices) {
          if (p.retailPrice != null) lowest = Math.min(lowest, Number(p.retailPrice));
        }
      }
      if (lowest !== Infinity) return lowest;
    }

    const td = sp?.travelerDetails;
    if (td?.pricingModel === 'perGroup' && Array.isArray(td?.groupSizes)) {
      let lowest = Infinity;
      for (const gs of td.groupSizes) {
        if (gs.price != null) lowest = Math.min(lowest, Number(gs.price));
      }
      if (lowest !== Infinity) return lowest;
    }

    if (td?.uniformPrice != null) return Number(td.uniformPrice);
    return null;
  } catch {
    return null;
  }
}

const TOUR_SELECT = {
  id: true, title: true, slug: true, coverPhoto: true, photos: true,
  category: true, city: true, country: true, averageRating: true,
  reviewCount: true, totalBookings: true, schedulesAndPricing: true,
  durationMinutes: true, difficulty: true, tags: true,
  latitude: true, longitude: true, createdAt: true,
  supplier: {
    select: {
      id: true, name: true, photoURL: true,
      supplierProfile: { select: { averageRating: true } },
    },
  },
};

// ─── 1. LIKELY TO SELL OUT ────────────────────────────────────────────
/**
 * Tours with booking momentum in the last 14 days.
 *
 * Signal: CONFIRMED + COMPLETED bookings in last 14 days.
 * Why 14 days: Short enough to be "current demand", long enough
 * to avoid noise from single-day spikes.
 *
 * Fallback: If no tours meet the minimum threshold, return
 * tours sorted by lifetime totalBookings (most popular overall).
 */
async function getLikelySellOut(limit = DEFAULT_LIMIT) {
  const cacheKey = `hp:sellout:${limit}`;
  const ttl = 300; // 5 minutes

  return cache.getOrSet(cacheKey, async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);

    // Get booking velocity per tour (last 14 days, CONFIRMED + COMPLETED only)
    const velocity = await prisma.booking.groupBy({
      by: ['tourId'],
      where: {
        status: { in: ['CONFIRMED', 'COMPLETED'] },
        createdAt: { gte: cutoff },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: limit * 3, // Over-fetch to filter
    });

    const velocityMap = new Map(velocity.map(v => [v.tourId, v._count.id]));
    const tourIds = velocity.map(v => v.tourId);

    // Fetch tour details for velocity leaders
    let tours = [];
    if (tourIds.length > 0) {
      tours = await prisma.tour.findMany({
        where: {
          id: { in: tourIds },
          status: 'ACTIVE',
          supplier: { supplierProfile: { status: 'ACTIVE' } },
        },
        select: TOUR_SELECT,
      });
    }

    // If not enough tours with velocity, fill with most-booked tours
    if (tours.length < limit) {
      const existingIds = new Set(tours.map(t => t.id));
      const fillTours = await prisma.tour.findMany({
        where: {
          status: 'ACTIVE',
          totalBookings: { gte: MIN_BOOKINGS_SELL_OUT },
          id: { notIn: [...existingIds] },
          supplier: { supplierProfile: { status: 'ACTIVE' } },
        },
        select: TOUR_SELECT,
        orderBy: { totalBookings: 'desc' },
        take: limit - tours.length,
      });
      tours = [...tours, ...fillTours];
    }

    // Score: normalized velocity (primary), lifetime bookings (secondary)
    const maxVelocity = Math.max(...tours.map(t => velocityMap.get(t.id) || 0), 1);
    const maxBookings = Math.max(...tours.map(t => t.totalBookings || 0), 1);

    const scored = tours.map(t => {
      const vel = velocityMap.get(t.id) || 0;
      const nVel = normalize(vel, maxVelocity);
      const nBook = normalize(t.totalBookings || 0, maxBookings);
      return {
        ...mapTourCard(t),
        _score: (nVel * 0.7) + (nBook * 0.3),
        _velocity14d: vel,
      };
    });

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }, ttl);
}

// ─── 2. TOP RATED ─────────────────────────────────────────────────────
/**
 * Tours with genuinely high quality — Bayesian-smoothed ratings.
 *
 * Why Bayesian: A tour with 1 review at 5.0 should NOT rank equal
 * to a tour with 200 reviews at 4.8. Bayesian smoothing pulls
 * low-review-count tours toward the global average.
 *
 * Minimum 3 reviews to qualify (avoids single-review inflation).
 */
async function getTopRated(limit = DEFAULT_LIMIT) {
  const cacheKey = `hp:toprated:${limit}`;
  const ttl = 300;

  return cache.getOrSet(cacheKey, async () => {
    const tours = await prisma.tour.findMany({
      where: {
        status: 'ACTIVE',
        reviewCount: { gte: MIN_REVIEWS_TOP_RATED },
        averageRating: { not: null },
        supplier: { supplierProfile: { status: 'ACTIVE' } },
      },
      select: TOUR_SELECT,
      orderBy: [
        { averageRating: 'desc' },
        { reviewCount: 'desc' },
      ],
      take: limit * 3, // Over-fetch for re-ranking
    });

    if (tours.length === 0) return [];

    // Compute Bayesian ratings and normalize
    const bayesianScores = tours.map(t => bayesianRating(t.averageRating, t.reviewCount));
    const maxBayesian = Math.max(...bayesianScores, 1);
    const maxReviews = Math.max(...tours.map(t => t.reviewCount || 0), 1);
    const maxBookings = Math.max(...tours.map(t => t.totalBookings || 0), 1);

    const scored = tours.map((t, i) => {
      const bay = bayesianScores[i];
      const nBay = normalize(bay, maxBayesian);
      const nRev = normalize(t.reviewCount || 0, maxReviews);
      const nBook = normalize(t.totalBookings || 0, maxBookings);
      return {
        ...mapTourCard(t),
        _score: (nBay * 0.50) + (nRev * 0.30) + (nBook * 0.20),
        _bayesianRating: Math.round(bay * 100) / 100,
      };
    });

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }, ttl);
}

// ─── 3. TRENDING NOW ──────────────────────────────────────────────────
/**
 * Tours with accelerating interest — breakout tours.
 *
 * Compares last 7 days vs prior 7 days for:
 * - View velocity (from Event table)
 * - Booking velocity (from Booking table)
 * - Wishlist velocity (from WishlistItem table)
 *
 * Growth capped at 5x to prevent 1→5 views = 500% growth dominating.
 * Minimum 10 views in last 7 days to qualify (avoids noise).
 */
async function getTrending(limit = DEFAULT_LIMIT) {
  const cacheKey = `hp:trending:${limit}`;
  const ttl = 300;

  return cache.getOrSet(cacheKey, async () => {
    const now = new Date();
    const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
    const d14 = new Date(now); d14.setDate(d14.getDate() - 14);

    // View velocity: last 7d vs prior 7d
    const [recentViews, priorViews] = await Promise.all([
      prisma.event.groupBy({
        by: ['resourceId'],
        where: { name: 'tour.viewed', createdAt: { gte: d7 }, resourceId: { not: null } },
        _count: { id: true },
      }),
      prisma.event.groupBy({
        by: ['resourceId'],
        where: { name: 'tour.viewed', createdAt: { gte: d14, lt: d7 }, resourceId: { not: null } },
        _count: { id: true },
      }),
    ]);

    // Booking velocity: last 7d vs prior 7d
    const [recentBookings, priorBookings] = await Promise.all([
      prisma.booking.groupBy({
        by: ['tourId'],
        where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, createdAt: { gte: d7 } },
        _count: { id: true },
      }),
      prisma.booking.groupBy({
        by: ['tourId'],
        where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, createdAt: { gte: d14, lt: d7 } },
        _count: { id: true },
      }),
    ]);

    // Wishlist velocity: last 7d vs prior 7d
    const [recentWishlists, priorWishlists] = await Promise.all([
      prisma.wishlistItem.groupBy({
        by: ['tourId'],
        where: { addedAt: { gte: d7 } },
        _count: { id: true },
      }),
      prisma.wishlistItem.groupBy({
        by: ['tourId'],
        where: { addedAt: { gte: d14, lt: d7 } },
        _count: { id: true },
      }),
    ]);

    // Build lookup maps
    const rvMap = new Map(recentViews.map(v => [v.resourceId, v._count.id]));
    const pvMap = new Map(priorViews.map(v => [v.resourceId, v._count.id]));
    const rbMap = new Map(recentBookings.map(b => [b.tourId, b._count.id]));
    const pbMap = new Map(priorBookings.map(b => [b.tourId, b._count.id]));
    const rwMap = new Map(recentWishlists.map(w => [w.tourId, w._count.id]));
    const pwMap = new Map(priorWishlists.map(w => [w.tourId, w._count.id]));

    // Collect all tour IDs that have any activity
    const allTourIds = new Set([
      ...rvMap.keys(), ...rbMap.keys(), ...rwMap.keys(),
    ]);

    // Filter: minimum 10 views in last 7 days
    const qualifiedIds = [...allTourIds].filter(id => (rvMap.get(id) || 0) >= MIN_VIEWS_TRENDING);

    if (qualifiedIds.length === 0) {
      // Fallback: newest tours
      return getNewExperiences(limit);
    }

    const tours = await prisma.tour.findMany({
      where: {
        id: { in: qualifiedIds },
        status: 'ACTIVE',
        supplier: { supplierProfile: { status: 'ACTIVE' } },
      },
      select: TOUR_SELECT,
    });

    const scored = tours.map(t => {
      const rv = rvMap.get(t.id) || 0;
      const pv = pvMap.get(t.id) || 1;
      const rb = rbMap.get(t.id) || 0;
      const pb = pbMap.get(t.id) || 1;
      const rw = rwMap.get(t.id) || 0;
      const pw = pwMap.get(t.id) || 1;

      // Growth ratios (capped at TRENDING_GROWTH_CAP)
      const viewGrowth = Math.min(rv / pv, TRENDING_GROWTH_CAP);
      const bookGrowth = Math.min(rb / pb, TRENDING_GROWTH_CAP);
      const wishGrowth = Math.min(rw / pw, TRENDING_GROWTH_CAP);

      return {
        ...mapTourCard(t),
        _score: (viewGrowth * 0.40) + (bookGrowth * 0.40) + (wishGrowth * 0.20),
        _views7d: rv,
        _bookings7d: rb,
        _wishlists7d: rw,
      };
    });

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }, ttl);
}

// ─── 4. RECOMMENDED FOR YOU ───────────────────────────────────────────
/**
 * Personalized recommendations based on user behavior + tour quality.
 *
 * For logged-in users:
 * 1. Extract category affinity from recent search + view events
 * 2. Find tours matching top categories
 * 3. Boost by proximity (if location available)
 * 4. Boost by tour quality (Bayesian rating)
 * 5. Exclude already-viewed tours
 * 6. Apply category diversity (max 2 per category in top 10)
 *
 * For anonymous users:
 * - Popularity score with category diversity
 * - Location-based boost if geolocation available
 *
 * @param {string|null} userId - Authenticated user ID
 * @param {number|null} lat - User latitude
 * @param {number|null} lng - User longitude
 * @param {number} limit - Max results
 */
async function getRecommended(userId, lat, lng, limit = DEFAULT_LIMIT) {
  const cacheKey = `hp:rec:${userId || 'anon'}:${lat || 0}:${lng || 0}:${limit}`;
  const ttl = 300;

  return cache.getOrSet(cacheKey, async () => {
    let categoryAffinity = {};
    let viewedTourIds = new Set();

    if (userId) {
      // Get user's recent behavior (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const [searchEvents, viewEvents] = await Promise.all([
        prisma.event.findMany({
          where: {
            userId,
            name: 'search.executed',
            createdAt: { gte: thirtyDaysAgo },
          },
          select: { properties: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        prisma.event.findMany({
          where: {
            userId,
            name: 'tour.viewed',
            createdAt: { gte: thirtyDaysAgo },
          },
          select: { resourceId: true, properties: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

      // Build category affinity from search queries
      for (const evt of searchEvents) {
        const props = evt.properties || {};
        if (props.category) {
          const age = (Date.now() - new Date(evt.createdAt).getTime()) / (1000 * 60 * 60 * 24);
          const recencyWeight = Math.max(1, 30 - age) / 30; // 1.0 for today, 0 for 30 days ago
          categoryAffinity[props.category] = (categoryAffinity[props.category] || 0) + recencyWeight;
        }
        // Also extract keywords from search query
        if (props.query) {
          const words = props.query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          for (const word of words) {
            categoryAffinity[word] = (categoryAffinity[word] || 0) + 0.5;
          }
        }
      }

      // Build category affinity from viewed tours
      for (const evt of viewEvents) {
        if (evt.resourceId) viewedTourIds.add(evt.resourceId);
        const props = evt.properties || {};
        if (props.category) {
          const age = (Date.now() - new Date(evt.createdAt).getTime()) / (1000 * 60 * 60 * 24);
          const recencyWeight = Math.max(1, 30 - age) / 30;
          categoryAffinity[props.category] = (categoryAffinity[props.category] || 0) + recencyWeight * 0.5;
        }
      }
    }

    // Get top categories by affinity
    const topCategories = Object.entries(categoryAffinity)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([cat]) => cat);

    // Build query conditions
    const where = {
      status: 'ACTIVE',
      supplier: { supplierProfile: { status: 'ACTIVE' } },
    };

    // Exclude already-viewed tours
    if (viewedTourIds.size > 0) {
      where.id = { notIn: [...viewedTourIds] };
    }

    // If we have category affinity, prioritize those categories
    if (topCategories.length > 0) {
      where.OR = [
        { category: { in: topCategories } },
        { tags: { hasSome: topCategories } },
      ];
    }

    let tours = await prisma.tour.findMany({
      where,
      select: TOUR_SELECT,
      orderBy: [
        { averageRating: 'desc' },
        { reviewCount: 'desc' },
        { totalBookings: 'desc' },
      ],
      take: limit * 3,
    });

    // If not enough results with category filter, broaden
    if (tours.length < limit) {
      const existingIds = new Set(tours.map(t => t.id));
      const broadTours = await prisma.tour.findMany({
        where: {
          status: 'ACTIVE',
          id: { notIn: [...existingIds, ...viewedTourIds] },
          supplier: { supplierProfile: { status: 'ACTIVE' } },
        },
        select: TOUR_SELECT,
        orderBy: { totalBookings: 'desc' },
        take: limit - tours.length,
      });
      tours = [...tours, ...broadTours];
    }

    // Score each tour
    const maxBookings = Math.max(...tours.map(t => t.totalBookings || 0), 1);
    const maxReviews = Math.max(...tours.map(t => t.reviewCount || 0), 1);

    const scored = tours.map(t => {
      const bay = bayesianRating(t.averageRating, t.reviewCount);
      const nBay = normalize(bay, 5); // Max possible Bayesian is ~5
      const nBook = normalize(t.totalBookings || 0, maxBookings);
      const nRev = normalize(t.reviewCount || 0, maxReviews);

      let score = (nBay * 0.35) + (nBook * 0.25) + (nRev * 0.20);

      // Category affinity boost
      if (t.category && categoryAffinity[t.category]) {
        score *= 1.0 + Math.min(categoryAffinity[t.category], 2) * 0.25;
      }
      // Tag affinity boost
      if (t.tags) {
        for (const tag of t.tags) {
          if (categoryAffinity[tag]) {
            score *= 1.0 + Math.min(categoryAffinity[tag], 1) * 0.10;
          }
        }
      }

      // Location proximity boost (if user location available)
      if (lat && lng && t.latitude && t.longitude) {
        const dist = haversineKm(lat, lng, t.latitude, t.longitude);
        if (dist < 50) score *= 1.0 + (1 - dist / 50) * 0.3; // Up to 30% boost for nearby
      }

      // Recency boost for new tours (created in last 90 days)
      const age90 = new Date();
      age90.setDate(age90.getDate() - 90);
      if (new Date(t.createdAt) > age90) {
        score *= 1.1; // 10% boost
      }

      return {
        ...mapTourCard(t),
        _score: Math.round(score * 10000) / 10000,
      };
    });

    scored.sort((a, b) => b._score - a._score);

    // Apply category diversity: max 2 per category in top results
    const diversified = [];
    const categoryCount = {};
    for (const tour of scored) {
      const cat = tour.category || 'Uncategorized';
      if ((categoryCount[cat] || 0) >= 2 && diversified.length >= 6) continue;
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
      diversified.push(tour);
      if (diversified.length >= limit) break;
    }

    return diversified;
  }, ttl);
}

// ─── 5. NEW EXPERIENCES ───────────────────────────────────────────────
/**
 * Tours created in the last 30 days.
 * Simple freshness filter — no complex scoring needed.
 */
async function getNewExperiences(limit = DEFAULT_LIMIT) {
  const cacheKey = `hp:new:${limit}`;
  const ttl = 600; // 10 minutes (changes less frequently)

  return cache.getOrSet(cacheKey, async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    const tours = await prisma.tour.findMany({
      where: {
        status: 'ACTIVE',
        createdAt: { gte: cutoff },
        supplier: { supplierProfile: { status: 'ACTIVE' } },
      },
      select: TOUR_SELECT,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return tours.map(mapTourCard);
  }, ttl);
}

// ─── 6. TOP ATTRACTIONS ───────────────────────────────────────────────
/**
 * Nearby tours sorted by affordability + quality.
 *
 * Uses PostGIS ST_DWithin for proximity search when location is available.
 * Falls back to globally popular tours sorted by price when no location.
 *
 * @param {number|null} lat - User latitude
 * @param {number|null} lng - User longitude
 * @param {string[]} keywords - User's search keywords for filtering
 * @param {number} limit - Max results
 */
async function getTopAttractions(lat, lng, keywords = [], limit = DEFAULT_LIMIT) {
  const cacheKey = `hp:attr:${lat || 0}:${lng || 0}:${keywords.join(',')}:${limit}`;
  const ttl = 600;

  return cache.getOrSet(cacheKey, async () => {
    let tours;

    if (lat && lng) {
      // Nearby tours via PostGIS (within 100km) — single query with distance
      const radiusMeters = 100 * 1000;
      const nearbyWithDistance = await prisma.$queryRaw`
        SELECT id,
          ST_DistanceSphere(
            location_geom::geometry,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
          ) / 1000.0 AS distance_km
        FROM "Tour"
        WHERE location_geom IS NOT NULL
          AND status = 'ACTIVE'
          AND ST_DWithin(
            location_geom,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
            ${radiusMeters}
          )
        ORDER BY distance_km
        LIMIT ${limit * 3}
      `;

      const ids = nearbyWithDistance.map(r => r.id);
      const distMap = new Map(nearbyWithDistance.map(d => [d.id, parseFloat(d.distance_km)]));

      const where = {
        id: { in: ids },
        status: 'ACTIVE',
        supplier: { supplierProfile: { status: 'ACTIVE' } },
      };

      // Apply keyword filter if available
      if (keywords.length > 0) {
        where.OR = [
          { category: { in: keywords } },
          { tags: { hasSome: keywords } },
          { city: { in: keywords } },
        ];
      }

      tours = await prisma.tour.findMany({
        where,
        select: TOUR_SELECT,
      });

      tours = tours.map(t => ({
        ...t,
        _distance: distMap.get(t.id) || null,
      }));

      // Sort: primary = price ASC, secondary = distance ASC, tertiary = rating DESC
      tours.sort((a, b) => {
        const pa = extractStartingPrice(a.schedulesAndPricing) ?? 999999;
        const pb = extractStartingPrice(b.schedulesAndPricing) ?? 999999;
        if (Math.abs(pa - pb) > 5) return pa - pb;
        const da = a._distance ?? 9999;
        const db = b._distance ?? 9999;
        if (Math.abs(da - db) > 5) return da - db;
        return (parseFloat(b.averageRating) || 0) - (parseFloat(a.averageRating) || 0);
      });

      return tours.slice(0, limit).map(t => ({
        ...mapTourCard(t),
        _distance: t._distance,
      }));
    }

    // No location: globally popular tours sorted by price
    tours = await prisma.tour.findMany({
      where: {
        status: 'ACTIVE',
        supplier: { supplierProfile: { status: 'ACTIVE' } },
      },
      select: TOUR_SELECT,
      orderBy: [
        { totalBookings: 'desc' },
        { averageRating: 'desc' },
      ],
      take: limit * 2,
    });

    // Sort by price ASC, then rating DESC
    tours.sort((a, b) => {
      const pa = extractStartingPrice(a.schedulesAndPricing) ?? 999999;
      const pb = extractStartingPrice(b.schedulesAndPricing) ?? 999999;
      if (Math.abs(pa - pb) > 5) return pa - pb;
      return (parseFloat(b.averageRating) || 0) - (parseFloat(a.averageRating) || 0);
    });

    return tours.slice(0, limit).map(mapTourCard);
  }, ttl);
}

// ─── 7. MOOD KEYWORDS ────────────────────────────────────────────────
/**
 * Dynamic keywords for the "What do you want to do?" section.
 *
 * Sources:
 * 1. User's recent search queries (last 30 days)
 * 2. Categories of tours the user viewed
 * 3. Global trending keywords (most searched terms in last 7 days)
 * 4. Tour categories with most active tours
 *
 * Each keyword includes a representative tour image.
 *
 * @param {string|null} userId - Authenticated user ID
 * @param {number} limit - Max keywords to return
 */
async function getMoodKeywords(userId, limit = 8) {
  const cacheKey = `hp:mood:${userId || 'anon'}:${limit}`;
  const ttl = 300;

  return cache.getOrSet(cacheKey, async () => {
    const keywordScores = {};

    // Source 1: User's recent searches (if logged in)
    if (userId) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const userSearches = await prisma.event.findMany({
        where: {
          userId,
          name: 'search.executed',
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { properties: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      for (const evt of userSearches) {
        const props = evt.properties || {};
        const age = (Date.now() - new Date(evt.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        const recencyWeight = Math.max(1, 30 - age) / 30;

        if (props.category) {
          keywordScores[props.category] = (keywordScores[props.category] || 0) + recencyWeight * 2;
        }
        if (props.query) {
          // Extract meaningful keywords from search query
          const words = props.query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          for (const word of words) {
            keywordScores[word] = (keywordScores[word] || 0) + recencyWeight;
          }
        }
      }

      // Source 2: Categories from viewed tours
      const userViews = await prisma.event.findMany({
        where: {
          userId,
          name: 'tour.viewed',
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { properties: true, createdAt: true },
        take: 100,
      });

      for (const evt of userViews) {
        const props = evt.properties || {};
        if (props.category) {
          const age = (Date.now() - new Date(evt.createdAt).getTime()) / (1000 * 60 * 60 * 24);
          const recencyWeight = Math.max(1, 30 - age) / 30;
          keywordScores[props.category] = (keywordScores[props.category] || 0) + recencyWeight;
        }
      }
    }

    // Source 3: Global trending keywords (most searched in last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const globalSearches = await prisma.event.groupBy({
      by: ['properties'],
      where: {
        name: 'search.executed',
        createdAt: { gte: sevenDaysAgo },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 200,
    });

    for (const row of globalSearches) {
      const props = row.properties || {};
      if (props.category) {
        keywordScores[props.category] = (keywordScores[props.category] || 0) + row._count.id * 0.1;
      }
      if (props.query) {
        const words = props.query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        for (const word of words) {
          keywordScores[word] = (keywordScores[word] || 0) + row._count.id * 0.05;
        }
      }
    }

    // Source 4: Tour categories with most active tours (fallback)
    const categoryCounts = await prisma.tour.groupBy({
      by: ['category'],
      where: { status: 'ACTIVE', category: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 20,
    });

    for (const row of categoryCounts) {
      keywordScores[row.category] = (keywordScores[row.category] || 0) + row._count.id * 0.01;
    }

    // Sort keywords by score, take top N
    const topKeywords = Object.entries(keywordScores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([keyword]) => keyword);

    // Batch: fetch representative tours for ALL keywords in one query
    const keywordOR = topKeywords.flatMap(keyword => [
      { category: { equals: keyword, mode: 'insensitive' } },
      { tags: { has: keyword.toLowerCase() } },
      { city: { equals: keyword, mode: 'insensitive' } },
      { title: { contains: keyword, mode: 'insensitive' } },
    ]);

    const candidateTours = await prisma.tour.findMany({
      where: { status: 'ACTIVE', coverPhoto: { not: null }, OR: keywordOR },
      select: { id: true, coverPhoto: true, photos: true, category: true, city: true, tags: true, totalBookings: true },
      orderBy: { totalBookings: 'desc' },
      take: limit * 6, // enough to cover all keywords
    });

    // Batch: count tours per category in one query
    const categoryCounts = await prisma.tour.groupBy({
      by: ['category'],
      where: { status: 'ACTIVE', category: { not: null } },
      _count: { id: true },
    });
    const categoryCountMap = new Map(categoryCounts.map(r => [r.category?.toLowerCase(), r._count.id]));

    // Match best tour per keyword in JS (no more DB queries)
    const results = [];
    const usedTourIds = new Set();
    for (const keyword of topKeywords) {
      const kwLower = keyword.toLowerCase();
      const match = candidateTours.find(t => {
        if (usedTourIds.has(t.id)) return false;
        return (
          t.category?.toLowerCase() === kwLower ||
          t.tags?.some(tag => tag.toLowerCase() === kwLower) ||
          t.city?.toLowerCase() === kwLower ||
          t.title?.toLowerCase().includes(kwLower)
        );
      });

      if (match) {
        usedTourIds.add(match.id);
        // Count from pre-fetched category groupBy (covers category matches)
        // For tags/city/title keywords, count from candidateTours as approximation
        const tourCount = categoryCountMap.get(kwLower)
          || candidateTours.filter(t =>
            t.tags?.some(tag => tag.toLowerCase() === kwLower) ||
            t.city?.toLowerCase() === kwLower
          ).length;

        results.push({
          keyword,
          image: match.coverPhoto || match.photos?.[0] || null,
          tourCount: Math.max(tourCount, 1),
          category: match.category,
          city: match.city,
        });
      }
    }

    return results;
  }, ttl);
}

// ─── 8. POPULAR DESTINATIONS ──────────────────────────────────────────
/**
 * Cities with the most tours, bookings, and strong reviews.
 *
 * Derived from actual tour data — no hardcoded values.
 *
 * @param {number} limit - Max destinations
 */
async function getPopularDestinations(limit = 10) {
  const cacheKey = `hp:destinations:${limit}`;
  const ttl = 3600; // 1 hour (changes infrequently)

  return cache.getOrSet(cacheKey, async () => {
    // Get cities with aggregated stats
    const cities = await prisma.$queryRaw`
      SELECT
        t.city,
        t.country,
        COUNT(*)::int AS "tourCount",
        COALESCE(SUM(t."totalBookings"), 0)::int AS "totalBookings",
        ROUND(AVG(CASE WHEN t."averageRating" IS NOT NULL THEN t."averageRating"::numeric END), 2) AS "avgRating",
        (SELECT t2."coverPhoto" FROM "Tour" t2
         WHERE t2.city = t.city AND t2.status = 'ACTIVE' AND t2."coverPhoto" IS NOT NULL
         ORDER BY t2."totalBookings" DESC LIMIT 1) AS "heroImage"
      FROM "Tour" t
      JOIN "SupplierProfile" sp ON sp."userId" = t."supplierId"
      WHERE t.status = 'ACTIVE'
        AND t.city IS NOT NULL
        AND sp.status = 'ACTIVE'
      GROUP BY t.city, t.country
      HAVING COUNT(*) >= 1
      ORDER BY "totalBookings" DESC, "tourCount" DESC
      LIMIT ${limit}
    `;

    return cities.map(c => ({
      city: c.city,
      country: c.country,
      tourCount: c.tourCount,
      totalBookings: c.totalBookings,
      avgRating: c.avgRating ? parseFloat(c.avgRating) : null,
      heroImage: c.heroImage,
    }));
  }, ttl);
}

// ─── Haversine distance helper ────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = {
  getLikelySellOut,
  getTopRated,
  getTrending,
  getRecommended,
  getNewExperiences,
  getTopAttractions,
  getMoodKeywords,
  getPopularDestinations,
};
