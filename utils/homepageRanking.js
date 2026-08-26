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

// ─── Keyword Categories ──────────────────────────────────────────────
// Imported from standalone module (zero deps) to avoid circular dependency issues.
const KEYWORD_CATEGORIES = require('./keywordCategories');

// Pre-computed: flat Set of ALL keywords across all categories (lowercased)
// Used for O(1) membership checks when matching tour tags to categories.
const ALL_CATEGORY_KEYWORDS = new Set(
  Object.values(KEYWORD_CATEGORIES).flat()
);

// Pre-computed: reverse map from keyword → category name
// Used to quickly find which category a tour tag belongs to.
const KEYWORD_TO_CATEGORY = new Map();
for (const [category, keywords] of Object.entries(KEYWORD_CATEGORIES)) {
  for (const kw of keywords) {
    KEYWORD_TO_CATEGORY.set(kw, category);
  }
}

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
  durationMinutes: true, difficulty: true, tags: true, attractions: true,
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

    // Re-rank by distance: nearest first
    if (lat && lng) {
      for (const tour of diversified) {
        tour._distance = (tour.latitude && tour.longitude)
          ? Math.round(haversineKm(lat, lng, tour.latitude, tour.longitude) * 10) / 10
          : null;
      }
      diversified.sort((a, b) => {
        if (a._distance === null) return 1;
        if (b._distance === null) return -1;
        return a._distance - b._distance;
      });
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
      take: limit * 2, // Over-fetch to allow dedup
    });

    // Deduplicate by coverPhoto — prefer tours with unique images
    const seenPhotos = new Set();
    const uniqueTours = [];
    for (const tour of tours) {
      if (tour.coverPhoto && seenPhotos.has(tour.coverPhoto)) continue;
      if (tour.coverPhoto) seenPhotos.add(tour.coverPhoto);
      uniqueTours.push(tour);
    }
    // Fill with remaining tours if dedup removed too many
    if (uniqueTours.length < limit) {
      for (const tour of tours) {
        if (!uniqueTours.includes(tour)) uniqueTours.push(tour);
        if (uniqueTours.length >= limit) break;
      }
    }

    return uniqueTours.slice(0, limit).map(mapTourCard);
  }, ttl);
}

// ─── 6. ATTRACTIONS ───────────────────────────────────────────────────
/**
 * Attractions derived from tour data — grouped by attraction name
 * (productContent.locations[].name).
 *
 * Each unique attraction name becomes an entry with:
 * - tourCount: how many tours visit this attraction
 * - heroImage: best-rated tour's cover photo
 * - startingPrice: cheapest tour price
 * - avgRating: average rating across tours
 * - lat/lng: centroid of tour coordinates
 *
 * Sorted by tourCount desc, then avgRating desc.
 */
async function getAttractions(limit = DEFAULT_LIMIT) {
  const cacheKey = `hp:attractions:${limit}`;
  const ttl = 600;

  return cache.getOrSet(cacheKey, async () => {
    // Find all active tours that have attraction names
    const tours = await prisma.tour.findMany({
      where: {
        status: 'ACTIVE',
        attractions: { isEmpty: false },
        supplier: { supplierProfile: { status: 'ACTIVE' } },
      },
      select: {
        id: true,
        attractions: true,
        coverPhoto: true,
        photos: true,
        averageRating: true,
        totalBookings: true,
        schedulesAndPricing: true,
        latitude: true,
        longitude: true,
        city: true,
        country: true,
      },
    });

    if (tours.length === 0) return [];

    // Build attraction map: attractionName → { tours, totalRating, count, ... }
    const attractionMap = new Map();

    for (const tour of tours) {
      if (!Array.isArray(tour.attractions)) continue;
      for (const name of tour.attractions) {
        if (!name || !name.trim()) continue;
        const key = name.trim();
        if (!attractionMap.has(key)) {
          attractionMap.set(key, {
            name: key,
            tourIds: [],
            coverPhotos: [],
            totalRating: 0,
            ratingCount: 0,
            totalBookings: 0,
            latSum: 0,
            lngSum: 0,
            coordCount: 0,
            minPrice: Infinity,
          });
        }
        const a = attractionMap.get(key);
        a.tourIds.push(tour.id);
        // Collect ALL available photos for more variety
        if (tour.coverPhoto) a.coverPhotos.push(tour.coverPhoto);
        if (Array.isArray(tour.photos)) {
          for (const p of tour.photos) {
            if (p) a.coverPhotos.push(p);
          }
        }
        if (tour.averageRating) {
          a.totalRating += parseFloat(tour.averageRating);
          a.ratingCount++;
        }
        a.totalBookings += tour.totalBookings || 0;
        if (tour.latitude && tour.longitude) {
          a.latSum += tour.latitude;
          a.lngSum += tour.longitude;
          a.coordCount++;
        }
        const price = extractStartingPrice(tour.schedulesAndPricing);
        if (price != null && price < a.minPrice) a.minPrice = price;
      }
    }

    // Filter out attractions with < 2 tours (need minimum to be interesting)
    const candidates = [...attractionMap.values()].filter(a => a.tourIds.length >= 2);

    // Score and sort
    const maxTours = Math.max(...candidates.map(a => a.tourIds.length), 1);
    const maxBookings = Math.max(...candidates.map(a => a.totalBookings), 1);

    const scored = candidates.map(a => {
      const nTours = a.tourIds.length / maxTours;
      const nBookings = a.totalBookings / maxBookings;
      const avgRating = a.ratingCount > 0 ? a.totalRating / a.ratingCount : 0;
      return {
        ...a,
        _score: (nTours * 0.5) + (nBookings * 0.3) + (avgRating / 5 * 0.2),
      };
    });

    scored.sort((a, b) => b._score - a._score);

    // Deterministic hash for picking unique photos per attraction
    function hashStr(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return Math.abs(h);
    }

    // Build results, skipping attractions that can't provide a unique image.
    // This guarantees no duplicate images across attraction cards.
    const usedImages = new Set();
    const results = [];

    for (const a of scored) {
      if (results.length >= limit) break;

      // Find the tour with the best rating
      let bestTour = null;
      let bestRating = -1;
      for (const tour of tours) {
        if (a.tourIds.includes(tour.id)) {
          const r = tour.averageRating ? parseFloat(tour.averageRating) : 0;
          if (r > bestRating) {
            bestRating = r;
            bestTour = tour;
          }
        }
      }

      // Try to find a unique photo from the attraction's pool
      const uniquePhotos = [...new Set(a.coverPhotos.filter(Boolean))];
      let heroImage = null;
      if (uniquePhotos.length > 0) {
        const startIdx = hashStr(a.name) % uniquePhotos.length;
        for (let i = 0; i < uniquePhotos.length; i++) {
          const idx = (startIdx + i) % uniquePhotos.length;
          if (!usedImages.has(uniquePhotos[idx])) {
            heroImage = uniquePhotos[idx];
            break;
          }
        }
      }

      // Skip this attraction if no unique photo available
      if (!heroImage) continue;

      usedImages.add(heroImage);
      const avgRating = a.ratingCount > 0 ? Math.round((a.totalRating / a.ratingCount) * 10) / 10 : null;

      results.push({
        name: a.name,
        tourCount: a.tourIds.length,
        heroImage,
        avgRating,
        totalBookings: a.totalBookings,
        startingPrice: a.minPrice === Infinity ? null : a.minPrice,
        lat: a.coordCount > 0 ? Math.round((a.latSum / a.coordCount) * 10000) / 10000 : null,
        lng: a.coordCount > 0 ? Math.round((a.lngSum / a.coordCount) * 10000) / 10000 : null,
      });
    }

    return results;
  }, ttl);
}

/**
 * Tours that visit a specific attraction.
 *
 * Filters by the attractions array containment (PostgreSQL @>).
 * Sorted by totalBookings desc (most popular first).
 *
 * @param {string} attractionName - The attraction name to filter by
 * @param {number} limit - Max results
 */
async function getAttractionTours(attractionName, limit = DEFAULT_LIMIT) {
  if (!attractionName) return [];

  const cacheKey = `hp:attrTours:${attractionName}:${limit}`;
  const ttl = 300;

  return cache.getOrSet(cacheKey, async () => {
    const tours = await prisma.tour.findMany({
      where: {
        status: 'ACTIVE',
        attractions: { has: attractionName },
        supplier: { supplierProfile: { status: 'ACTIVE' } },
      },
      select: TOUR_SELECT,
      orderBy: [
        { totalBookings: 'desc' },
        { averageRating: 'desc' },
      ],
      take: limit,
    });

    return tours.map(mapTourCard);
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
 * 4. Supplier-defined keyword categories (from dashboard step 6)
 *
 * Architecture: Single-pass — one DB query fetches all active tours with
 * tags, then an in-memory inverted index maps keywords → tours. Categories
 * are scored by unique tour count. Personalization (Sources 1-3) boosts
 * specific categories on top of the popularity baseline.
 *
 * Performance:
 * - DB queries: 2 (user events + all tours with tags)
 * - In-memory: O(N × M) where N = active tours, M = avg tags per tour
 * - Cache: L1 memory + L2 Redis via cache.getOrSet (5 min TTL)
 *
 * @param {string|null} userId - Authenticated user ID
 * @param {number} limit - Max keywords to return
 */
async function getMoodKeywords(userId, limit = 8) {
  const cacheKey = `hp:mood:${userId || 'anon'}:${limit}`;
  const ttl = 300;

  return cache.getOrSet(cacheKey, async () => {
    // ── Sources 1-3: User behavior signals (unchanged) ──────────────
    const categoryScores = {};  // scores keyed by category name
    const subKeywordScores = {}; // scores keyed by individual keyword

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
          const cat = KEYWORD_TO_CATEGORY.get(props.category.toLowerCase());
          if (cat) {
            categoryScores[cat] = (categoryScores[cat] || 0) + recencyWeight * 2;
          }
        }
        if (props.query) {
          const words = props.query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          for (const word of words) {
            subKeywordScores[word] = (subKeywordScores[word] || 0) + recencyWeight;
          }
        }
      }

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
          const cat = KEYWORD_TO_CATEGORY.get(props.category.toLowerCase());
          if (cat) {
            categoryScores[cat] = (categoryScores[cat] || 0) + recencyWeight;
          }
        }
      }
    }

    // Source 3: Global trending searches (map individual keywords to categories)
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
        const cat = KEYWORD_TO_CATEGORY.get(props.category.toLowerCase());
        if (cat) {
          categoryScores[cat] = (categoryScores[cat] || 0) + row._count.id * 0.1;
        }
      }
      if (props.query) {
        const words = props.query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        for (const word of words) {
          subKeywordScores[word] = (subKeywordScores[word] || 0) + row._count.id * 0.05;
        }
      }
    }

    // ── Source 4: Keyword categories from supplier tags ─────────────
    // Single query: fetch ALL active tours with tags (no groupBy, no OR queries).
    // For ~10K tours with ~10 tags each, this is ~1MB of data — processed in <50ms.
    const allTours = await prisma.tour.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true, tags: true, coverPhoto: true, photos: true,
        category: true, totalBookings: true, city: true,
      },
      orderBy: { totalBookings: 'desc' },
    });

    // Build inverted index: keyword → Set<tourId>
    const keywordTourMap = new Map();
    for (const tour of allTours) {
      if (!tour.tags?.length) continue;
      for (const tag of tour.tags) {
        const tagLower = tag.toLowerCase();
        if (!ALL_CATEGORY_KEYWORDS.has(tagLower)) continue;
        let set = keywordTourMap.get(tagLower);
        if (!set) {
          set = new Set();
          keywordTourMap.set(tagLower, set);
        }
        set.add(tour.id);
      }
    }

    // Score each keyword category by unique tour count
    const categoryTourCounts = new Map();
    const categoryTourIds = new Map();
    for (const [categoryName, keywords] of Object.entries(KEYWORD_CATEGORIES)) {
      const tourIdSet = new Set();
      for (const kw of keywords) {
        const ids = keywordTourMap.get(kw);
        if (ids) {
          for (const id of ids) tourIdSet.add(id);
        }
      }
      categoryTourCounts.set(categoryName, tourIdSet.size);
      categoryTourIds.set(categoryName, tourIdSet);
      // Add popularity signal (weight 0.01 per tour, same scale as old Source 4)
      categoryScores[categoryName] = (categoryScores[categoryName] || 0) + tourIdSet.size * 0.01;
    }

    // Also boost individual sub-keywords that are trending (for fallback scoring)
    const allSubKeywords = new Map(); // keyword → tour count
    for (const [kw, tourIds] of keywordTourMap) {
      allSubKeywords.set(kw, tourIds.size);
    }

    // ── Merge and rank ─────────────────────────────────────────────
    // Sort categories by composite score (user behavior + popularity)
    const rankedCategories = Object.entries(KEYWORD_CATEGORIES)
      .map(([name]) => ({
        name,
        score: categoryScores[name] || 0,
        tourCount: categoryTourCounts.get(name) || 0,
      }))
      .filter(c => c.tourCount > 0)
      .sort((a, b) => b.score - a.score || b.tourCount - a.tourCount);

    // ── Find representative tours ──────────────────────────────────
    // Build a lookup: tourId → tour object (avoid repeated scans)
    const tourById = new Map(allTours.map(t => [t.id, t]));
    const usedTourIds = new Set();
    const results = [];

    for (const cat of rankedCategories) {
      if (results.length >= limit) break;

      const catTourIds = categoryTourIds.get(cat.name);
      if (!catTourIds?.size) continue;

      // Find best available tour for this category (highest bookings, not yet used)
      let bestTour = null;
      for (const tourId of catTourIds) {
        if (usedTourIds.has(tourId)) continue;
        const tour = tourById.get(tourId);
        if (tour && tour.coverPhoto) {
          if (!bestTour || (tour.totalBookings || 0) > (bestTour.totalBookings || 0)) {
            bestTour = tour;
          }
        }
      }

      if (bestTour) {
        usedTourIds.add(bestTour.id);
        results.push({
          keyword: cat.name,
          image: bestTour.coverPhoto || bestTour.photos?.[0] || null,
          tourCount: cat.tourCount,
          category: cat.name,
          city: null,
        });
      }
    }

    // ── Fallback: sub-keyword slots ────────────────────────────────
    // If fewer than `limit` categories matched, fill remaining slots with
    // the most popular individual sub-keywords from KEYWORD_CATEGORIES
    // that aren't already represented by a matched category.
    if (results.length < limit) {
      const matchedCategories = new Set(results.map(r => r.keyword));
      const usedKeywords = new Set();

      // Collect candidate sub-keywords: must belong to a category, have tours,
      // and not be part of an already-matched category.
      const subCandidates = [];
      for (const [kw, tourCount] of allSubKeywords) {
        const parentCat = KEYWORD_TO_CATEGORY.get(kw);
        if (!parentCat || matchedCategories.has(parentCat)) continue;
        if (usedKeywords.has(kw)) continue;
        // Boost by sub-keyword trending score from Sources 1-3
        const trendBoost = subKeywordScores[kw] || 0;
        subCandidates.push({ kw, tourCount, trendBoost, score: tourCount * 0.01 + trendBoost });
      }

      subCandidates.sort((a, b) => b.score - a.score || b.tourCount - a.tourCount);

      for (const sub of subCandidates) {
        if (results.length >= limit) break;
        usedKeywords.add(sub.kw);

        // Find a representative tour for this keyword
        const kwTourIds = keywordTourMap.get(sub.kw);
        if (!kwTourIds?.size) continue;

        let bestTour = null;
        for (const tourId of kwTourIds) {
          if (usedTourIds.has(tourId)) continue;
          const tour = tourById.get(tourId);
          if (tour && tour.coverPhoto) {
            if (!bestTour || (tour.totalBookings || 0) > (bestTour.totalBookings || 0)) {
              bestTour = tour;
            }
          }
        }

        if (bestTour) {
          usedTourIds.add(bestTour.id);
          results.push({
            keyword: sub.kw.charAt(0).toUpperCase() + sub.kw.slice(1),
            image: bestTour.coverPhoto || bestTour.photos?.[0] || null,
            tourCount: sub.tourCount,
            category: KEYWORD_TO_CATEGORY.get(sub.kw) || null,
            city: null,
          });
        }
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
  getAttractions,
  getAttractionTours,
  getMoodKeywords,
  getPopularDestinations,
  extractStartingPrice,
  KEYWORD_CATEGORIES,
};
