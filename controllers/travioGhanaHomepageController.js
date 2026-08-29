/**
 * TravioGhana Homepage Controller — Ghana-Scoped Homepage Data
 *
 * Mirrors the shared homepageController.js section-by-section, but every
 * ranking call is scoped to tours published on TravioGhana
 * (ranking.* with ghanaOnly: true → travioGhanaTour.isActive filter).
 *
 * Sections (all 9, matching the storefront's expectations):
 *   sell-out, top-rated, trending, recommended, new, attractions,
 *   attractions/tours, mood, destinations, offers
 *
 * Per-section endpoints + a unified GET /homepage that returns all 9 keys
 * in one response (same key names as the shared endpoint).
 */

const catchAsync = require('../utils/catchAsync');
const prisma = require('../utils/prismaClient');
const cache = require('../utils/cacheHelper');
const ranking = require('../utils/homepageRanking');

const GHANA = true; // every ranking call in this controller is Ghana-scoped

// ── Helpers ────────────────────────────────────────────────────────────

const sectionCache = (name, ttl = 300) => ({
  getOrSet(key, fn) {
    return cache.getOrSet(`ghana:homepage:${name}:${key}`, fn, ttl);
  },
});

/**
 * Tours with active special offers targeting Ghana-published tours.
 * Mirrors the shared controller's computeOffersData() with a Ghana filter.
 */
async function computeGhanaOffersData() {
  const now = new Date();

  const targets = await prisma.specialOfferTarget.findMany({
    where: {
      tour: { travioGhanaTour: { isActive: true } },
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

  const { extractStartingPrice } = ranking;
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

  // Sort by popularity with a recency boost for brand-new offer tours.
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

// ── Section Handlers ───────────────────────────────────────────────────

exports.getSellOut = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await sectionCache('sell-out').getOrSet(limit, () => ranking.getLikelySellOut(limit, null, GHANA));
  res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
});

exports.getTopRated = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await sectionCache('top-rated').getOrSet(limit, () => ranking.getTopRated(limit, null, GHANA));
  res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
});

exports.getTrending = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await sectionCache('trending').getOrSet(limit, () => ranking.getTrending(limit, GHANA));
  res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
});

exports.getRecommended = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const userId = req.user?.id || null;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  const tours = await sectionCache(`recommended:${userId || 'anon'}:${lat || 0}:${lng || 0}`)
    .getOrSet(limit, () => ranking.getRecommended(userId, lat, lng, limit, GHANA));
  res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
});

exports.getNew = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await sectionCache('new').getOrSet(limit, () => ranking.getNewExperiences(limit, GHANA));
  res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
});

exports.getAttractions = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  const attractions = await sectionCache(`attractions:${lat || 0}:${lng || 0}`)
    .getOrSet(limit, () => ranking.getAttractions(limit, lat, lng, GHANA));
  res.json({ status: 'success', data: { attractions: attractions.slice(0, limit) } });
});

exports.getAttractionTours = catchAsync(async (req, res) => {
  const attractionName = req.query.name;
  if (!attractionName) {
    return res.status(400).json({ status: 'error', message: 'name query parameter is required' });
  }
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await sectionCache(`attraction-tours:${attractionName}`)
    .getOrSet(limit, () => ranking.getAttractionTours(attractionName, limit, GHANA));
  res.json({ status: 'success', data: { tours: tours.slice(0, limit) } });
});

exports.getMood = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 8, 12);
  const userId = req.user?.id || null;
  const keywords = await sectionCache(`mood:${userId || 'anon'}`).getOrSet(limit, () => ranking.getMoodKeywords(userId, limit, GHANA));
  res.json({ status: 'success', data: { keywords: keywords.slice(0, limit) } });
});

exports.getDestinations = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 15);
  const userId = req.user?.id || null;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  const destinations = await sectionCache(`destinations:${userId || 'anon'}:${lat || 0}:${lng || 0}`, 3600)
    .getOrSet(limit, () => ranking.getPopularDestinations(limit, userId, lat, lng, GHANA));
  res.json({ status: 'success', data: { destinations: destinations.slice(0, limit) } });
});

exports.getOffers = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const offers = await sectionCache('offers', 300).getOrSet('all', () => computeGhanaOffersData());
  res.json({ status: 'success', data: { tours: offers.slice(0, limit) } });
});

// ── Unified Endpoint ───────────────────────────────────────────────────

/**
 * GET /api/travioghana/homepage
 * All Ghana-scoped sections in one response — same 9 keys as the shared
 * /api/homepage endpoint so the storefront renders identically.
 */
exports.getGhanaHomepage = catchAsync(async (req, res) => {
  const userId = req.user?.id || null;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  const [sellOut, topRated, trending, recommended, newExp, attractions, mood, destinations, offers] =
    await Promise.all([
      ranking.getLikelySellOut(12, null, GHANA),
      ranking.getTopRated(12, null, GHANA),
      ranking.getTrending(12, GHANA),
      ranking.getRecommended(userId, lat, lng, 12, GHANA),
      ranking.getNewExperiences(10, GHANA),
      ranking.getAttractions(10, lat, lng, GHANA),
      ranking.getMoodKeywords(userId, 8, GHANA),
      ranking.getPopularDestinations(10, userId, lat, lng, GHANA),
      computeGhanaOffersData(),
    ]);

  res.json({
    status: 'success',
    data: {
      sellOut,
      topRated,
      trending,
      recommended,
      newExperiences: newExp,
      attractions,
      mood,
      destinations,
      offers,
    },
  });
});
