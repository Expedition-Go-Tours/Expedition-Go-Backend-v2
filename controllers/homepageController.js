/**
 * Homepage Controller
 *
 * Serves pre-computed, algorithmically ranked data for each homepage section.
 * Reads from Redis pre-computed keys first (0 DB queries), falls back to
 * live computation when keys are missing or Redis is unavailable.
 *
 * @version 2.0.0
 */

const catchAsync = require('../utils/catchAsync');
const prisma = require('../utils/prismaClient');
const ranking = require('../utils/homepageRanking');
const redis = require('../utils/redisClient');
const { SECTION_KEYS } = require('../utils/homepagePrecompute');
const { enqueueHomepagePrecompute } = require('../utils/queue');

/**
 * Try to read a pre-computed section from Redis.
 * Returns the data if found, null otherwise.
 */
async function readPrecomputed(key) {
  try {
    const data = await redis.get(key);
    return data || null;
  } catch {
    return null;
  }
}

/**
 * Fallback: compute live and enqueue background precompute.
 */
async function computeWithWarmup(limit, computeFn, _precomputeKey) {
  const data = await computeFn(limit);
  // Warm cache in background (fire-and-forget)
  enqueueHomepagePrecompute().catch(() => {});
  return data;
}

/**
 * GET /api/homepage/sell-out
 * Tours with booking momentum in the last 14 days.
 */
exports.getSellOut = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  let tours = await readPrecomputed(SECTION_KEYS.sellOut);
  if (tours) {
    return res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
  }
  tours = await computeWithWarmup(limit, ranking.getLikelySellOut, SECTION_KEYS.sellOut);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/top-rated
 * Tours with highest Bayesian-smoothed quality scores.
 */
exports.getTopRated = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  let tours = await readPrecomputed(SECTION_KEYS.topRated);
  if (tours) {
    return res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
  }
  tours = await computeWithWarmup(limit, ranking.getTopRated, SECTION_KEYS.topRated);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/trending
 * Tours with accelerating view/booking/wishlist velocity.
 */
exports.getTrending = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  let tours = await readPrecomputed(SECTION_KEYS.trending);
  if (tours) {
    return res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
  }
  tours = await computeWithWarmup(limit, ranking.getTrending, SECTION_KEYS.trending);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/recommended
 * Personalized recommendations based on user behavior + tour quality.
 * Accepts optional lat/lng for proximity boost.
 *
 * When userId or location is provided, always computes live (pre-computed
 * data is anonymous only). When anonymous, reads from pre-computed cache.
 */
exports.getRecommended = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const userId = req.user?.id || null;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  // Personalized: always compute live
  if (userId || lat) {
    const tours = await ranking.getRecommended(userId, lat, lng, limit);
    return res.json({ status: 'success', data: { tours } });
  }

  // Anonymous: try pre-computed cache
  let tours = await readPrecomputed(SECTION_KEYS.recommended);
  if (tours) {
    return res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
  }
  tours = await computeWithWarmup(limit, (l) => ranking.getRecommended(null, null, null, l), SECTION_KEYS.recommended);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/new
 * Tours created in the last 30 days.
 */
exports.getNew = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  let tours = await readPrecomputed(SECTION_KEYS.new);
  if (tours) {
    return res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
  }
  tours = await computeWithWarmup(limit, ranking.getNewExperiences, SECTION_KEYS.new);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/attractions
 * Attractions derived from tour data — grouped by attraction name.
 * Each unique name from productContent.locations[].name becomes an entry.
 */
exports.getAttractions = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  // When location provided, compute live (cache is location-specific)
  if (lat && lng) {
    const attractions = await ranking.getAttractions(limit, lat, lng);
    return res.json({ status: 'success', data: { attractions } });
  }

  // Try pre-computed cache first (anonymous/global)
  let attractions = await readPrecomputed(SECTION_KEYS.attractions);
  if (attractions) {
    return res.json({ status: 'success', data: { attractions: attractions.slice(0, limit) } });
  }
  attractions = await computeWithWarmup(limit, ranking.getAttractions, SECTION_KEYS.attractions);
  res.json({ status: 'success', data: { attractions } });
});

/**
 * GET /api/homepage/attractions/tours
 * Tours that visit a specific attraction.
 * Filters by the attractions array (PostgreSQL @>).
 */
exports.getAttractionTours = catchAsync(async (req, res) => {
  const attractionName = req.query.name;
  if (!attractionName) {
    return res.status(400).json({ status: 'error', message: 'name query parameter is required' });
  }
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await ranking.getAttractionTours(attractionName, limit);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/mood
 * Dynamic keywords for "What do you want to do?" section.
 * Returns keywords with representative tour images.
 *
 * When userId is provided, always computes live (pre-computed is anonymous).
 */
exports.getMood = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 8, 12);
  const userId = req.user?.id || null;

  // Personalized: always compute live
  if (userId) {
    const keywords = await ranking.getMoodKeywords(userId, limit);
    return res.json({ status: 'success', data: { keywords } });
  }

  // Anonymous: try pre-computed cache
  let keywords = await readPrecomputed(SECTION_KEYS.mood);
  if (keywords) {
    return res.json({ status: 'success', data: { keywords: keywords.slice(0, limit) } });
  }
  keywords = await computeWithWarmup(limit, (l) => ranking.getMoodKeywords(null, l), SECTION_KEYS.mood);
  res.json({ status: 'success', data: { keywords } });
});

/**
 * GET /api/homepage/destinations
 * Popular cities with aggregated tour/booking stats.
 */
exports.getDestinations = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 15);
  const userId = req.user?.id || null;
  const lat = parseFloat(req.query.lat) || null;
  const lng = parseFloat(req.query.lng) || null;

  // Personalized: compute live if user context available
  if (userId || (lat && lng)) {
    const destinations = await ranking.getPopularDestinations(limit, userId, lat, lng);
    return res.json({ status: 'success', data: { destinations } });
  }

  let destinations = await readPrecomputed(SECTION_KEYS.destinations);
  if (destinations) {
    return res.json({ status: 'success', data: { destinations: destinations.slice(0, limit) } });
  }
  destinations = await computeWithWarmup(limit, (l) => ranking.getPopularDestinations(l), SECTION_KEYS.destinations);
  res.json({ status: 'success', data: { destinations } });
});

/**
 * GET /api/homepage/offers
 * Tours with active special offers for the "Special Offers" homepage section.
 *
 * Single efficient query: SpecialOffer → SpecialOfferTarget → Tour.
 * No N+1 — all data fetched in one Prisma call.
 * Sorted by totalBookings (most popular first).
 */
exports.getOffers = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);

  // Try pre-computed cache first (same pattern as other sections)
  const cacheKey = 'hp:sections:offers';
  let offerCards = await readPrecomputed(cacheKey);
  if (!offerCards) {
    offerCards = await computeOffersData();
    // Cache for 5 minutes
    try {
      const redisAvailable = await redis.isRedisAvailable().catch(() => false);
      if (redisAvailable) {
        await redis.set(cacheKey, offerCards, 300);
        const cache = require('./cacheHelper');
        cache.memSet(cacheKey, offerCards);
      }
    } catch { /* cache write best-effort */ }
    enqueueHomepagePrecompute().catch(() => {});
  }

  res.json({
    status: 'success',
    data: { tours: offerCards.slice(0, limit) },
  });
});

/**
 * Compute offers data (shared by getOffers cache miss and getSectionTourIds fallback).
 */
async function computeOffersData() {
  const now = new Date();

  const targets = await prisma.specialOfferTarget.findMany({
    where: {
      specialOffer: {
        isActive: true,
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: now } }] },
          { OR: [{ endDate: null }, { endDate: { gte: now } }] },
        ],
      },
    },
    include: {
      specialOffer: true,
      tour: {
        select: {
          id: true, title: true, slug: true, coverPhoto: true, photos: true,
          category: true, city: true, country: true, averageRating: true,
          reviewCount: true, totalBookings: true, schedulesAndPricing: true,
          durationMinutes: true, difficulty: true, tags: true, status: true,
          createdAt: true,
          supplier: {
            select: {
              id: true, name: true, photoURL: true,
              supplierProfile: { select: { averageRating: true } },
            },
          },
        },
      },
    },
  });

  const tourOffersMap = new Map();
  for (const t of targets) {
    if (!t.tour || t.tour.status !== 'ACTIVE') continue;
    if (!tourOffersMap.has(t.tour.id)) tourOffersMap.set(t.tour.id, []);
    tourOffersMap.get(t.tour.id).push(t.specialOffer);
  }

  const { extractStartingPrice } = require('../utils/homepageRanking');
  const seenOfferIds = new Set();
  const offerCards = [];

  for (const t of targets) {
    if (!t.tour || t.tour.status !== 'ACTIVE') continue;
    if (seenOfferIds.has(t.specialOffer.id)) continue;
    seenOfferIds.add(t.specialOffer.id);

    const o = t.specialOffer;
    const tour = t.tour;
    const price = extractStartingPrice(tour.schedulesAndPricing);
    const durationStr = tour.durationMinutes
      ? tour.durationMinutes >= 1440
        ? `${Math.round(tour.durationMinutes / 1440)} days`
        : `${Math.round(tour.durationMinutes / 60)} hours`
      : '';

    const allTourOffers = tourOffersMap.get(tour.id) || [];

    offerCards.push({
      offerId: o.id,
      offerName: o.name || '',
      offerType: o.offerType,
      discountType: o.discountType,
      discountPercentage: o.discountPercentage,
      fixedDiscountValue: o.fixedDiscountValue,
      startDate: o.startDate,
      endDate: o.endDate,
      id: tour.id,
      title: tour.title,
      slug: tour.slug,
      coverPhoto: tour.coverPhoto,
      photos: tour.photos,
      category: tour.category,
      city: tour.city,
      country: tour.country,
      averageRating: tour.averageRating ? parseFloat(tour.averageRating) : null,
      reviewCount: tour.reviewCount || 0,
      totalBookings: tour.totalBookings || 0,
      createdAt: tour.createdAt,
      startingPrice: price,
      currency: 'USD',
      duration: durationStr,
      durationMinutes: tour.durationMinutes,
      difficulty: tour.difficulty,
      tags: tour.tags || [],
      supplier: tour.supplier ? {
        id: tour.supplier.id,
        name: tour.supplier.name,
        photo: tour.supplier.photoURL,
        rating: tour.supplier.supplierProfile?.averageRating
          ? parseFloat(tour.supplier.supplierProfile.averageRating)
          : null,
      } : null,
      specialOffers: allTourOffers.map(offer => ({
        id: offer.id,
        name: offer.name || '',
        offerType: offer.offerType,
        discountType: offer.discountType,
        discountPercentage: offer.discountPercentage,
        fixedDiscountValue: offer.fixedDiscountValue,
        startDate: offer.startDate,
        endDate: offer.endDate,
        promoCode: offer.promoCode || null,
        timeSlotMode: offer.timeSlotMode,
        specificWeekdays: offer.specificWeekdays || [],
        capacityType: offer.capacityType,
        maxSpots: offer.maxSpots,
        spotsSold: offer.spotsSold,
        minQuantity: offer.minQuantity,
        minSpendAmount: offer.minSpendAmount,
        maxRedemptionsPerCustomer: offer.maxRedemptionsPerCustomer,
        stackable: offer.stackable,
        earlyBirdAdvanceDays: offer.earlyBirdAdvanceDays,
        lastMinuteWindowHours: offer.lastMinuteWindowHours,
        targets: [{ tourId: tour.id, tourOptionKey: null, tourOptionLabel: null }],
      })),
    });
  }

  // Sort by popularity, but give recently created tours a booking-equivalent
  // boost so brand-new offer tours (0 bookings) still make the visible
  // section instead of always sinking below older, more booked tours.
  const NEW_TOUR_WINDOW_DAYS = 30;
  const NEW_TOUR_BOOST = 5;
  const newCutoff = new Date();
  newCutoff.setDate(newCutoff.getDate() - NEW_TOUR_WINDOW_DAYS);
  const isRecentTour = (card) => card.createdAt && new Date(card.createdAt) >= newCutoff;
  offerCards.sort((a, b) => {
    const aScore = (a.totalBookings || 0) + (isRecentTour(a) ? NEW_TOUR_BOOST : 0);
    const bScore = (b.totalBookings || 0) + (isRecentTour(b) ? NEW_TOUR_BOOST : 0);
    return bScore - aScore;
  });
  return offerCards;
}

/**
 * GET /api/homepage/section-tour-ids
 * Returns just the tour IDs for a given homepage section.
 * Reads from pre-computed Redis cache (0 DB queries in the hot path).
 * Used by AllToursPage to filter the tour list by section algorithm.
 */
exports.getSectionTourIds = catchAsync(async (req, res) => {
  const { section } = req.query;
  if (!section) {
    return res.json({ status: 'success', data: { tourIds: [] } });
  }

  const sectionMap = {
    'Recommended': { key: SECTION_KEYS.recommended, fallback: () => ranking.getRecommended(null, null, null, 50) },
    'Top Rated': { key: SECTION_KEYS.topRated, fallback: () => ranking.getTopRated(50) },
    'Sell Out': { key: SECTION_KEYS.sellOut, fallback: () => ranking.getLikelySellOut(50) },
    'Last Minute Deals': { key: 'hp:sections:offers', fallback: () => computeOffersData() },
    'New Experiences': { key: SECTION_KEYS.new, fallback: () => ranking.getNewExperiences(50) },
    'Top Attractions Nearby': { key: SECTION_KEYS.attractions, fallback: () => ranking.getAttractions(50) },
  };

  const entry = sectionMap[section];
  if (!entry) {
    return res.json({ status: 'success', data: { tourIds: [] } });
  }

  let tours = await readPrecomputed(entry.key);
  if (!tours) {
    tours = await entry.fallback();
    enqueueHomepagePrecompute().catch(() => {});
  }

  const tourIds = (tours || []).map(t => t.id).filter(Boolean);
  res.json({ status: 'success', data: { tourIds } });
});

/**
 * GET /api/homepage
 * Unified endpoint — returns all sections in a single response.
 * Reduces homepage HTTP requests from 8 to 1.
 *
 * Reads from pre-computed cache when available, falls back to live
 * computation for any missing keys.
 */
exports.getHomepage = catchAsync(async (req, res) => {
  const userId = req.user?.id || null;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  // Read all sections from pre-computed cache in parallel (including offers)
  const [sellOut, topRated, trending, recommended, newExp, attractions, mood, destinations, offers] =
    await Promise.all([
      readPrecomputed(SECTION_KEYS.sellOut),
      readPrecomputed(SECTION_KEYS.topRated),
      readPrecomputed(SECTION_KEYS.trending),
      readPrecomputed(SECTION_KEYS.recommended),
      readPrecomputed(SECTION_KEYS.new),
      readPrecomputed(SECTION_KEYS.attractions),
      readPrecomputed(SECTION_KEYS.mood),
      readPrecomputed(SECTION_KEYS.destinations),
      readPrecomputed('hp:sections:offers'),
    ]);

  // For personalized sections, compute live if userId/location provided
  const resolvedRecommended = (userId || lat)
    ? await ranking.getRecommended(userId, lat, lng, 12)
    : (recommended || await ranking.getRecommended(null, null, null, 12));

  const resolvedAttractions = (lat && lng)
    ? await ranking.getAttractions(10, lat, lng)
    : (attractions || await ranking.getAttractions(10));

  const resolvedMood = userId
    ? await ranking.getMoodKeywords(userId, 8)
    : (mood || await ranking.getMoodKeywords(null, 8));

  // For non-personalized sections, fall back to live computation if missing
  const resolvedSellOut = sellOut || await ranking.getLikelySellOut(12);
  const resolvedTopRated = topRated || await ranking.getTopRated(12);
  const resolvedTrending = trending || await ranking.getTrending(12);
  const resolvedNew = newExp || await ranking.getNewExperiences(10);
  const resolvedDestinations = destinations || await ranking.getPopularDestinations(10, userId, lat, lng);
  const resolvedOffers = offers || await computeOffersData();

  // Warm cache if any section was computed live
  if (!sellOut || !topRated || !trending || !recommended || !newExp || !attractions || !mood || !destinations || !offers) {
    enqueueHomepagePrecompute().catch(() => {});
  }

  res.json({
    status: 'success',
    data: {
      sellOut: resolvedSellOut,
      topRated: resolvedTopRated,
      trending: resolvedTrending,
      recommended: resolvedRecommended,
      newExperiences: resolvedNew,
      attractions: resolvedAttractions,
      mood: resolvedMood,
      destinations: resolvedDestinations,
      offers: resolvedOffers,
    },
  });
});
