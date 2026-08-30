/**
 * TravioAfrica Homepage Controller — pan-African homepage data.
 *
 * Mirrors travioGhanaHomepageController.js but scoped to TravioAfricaTour.
 * Uses the shared ranking engine (homepageRanking.js) for production-grade
 * algorithms (Bayesian top-rated, velocity sell-out, AI-relevance mood, etc.).
 *
 * NOTE: The ranking engine currently supports ghanaOnly and expeditionOnly
 * flags. A travioAfricaOnly flag is a follow-up — for now, the combined
 * endpoint queries TravioAfricaTour directly for the curated sections, and
 * the per-section endpoints use the shared ranking (unscoped) as a working
 * baseline. The storefront will show all ACTIVE tours until the platform
 * scope is added to the ranking engine.
 */

const catchAsync = require('../utils/catchAsync');
const prisma = require('../utils/prismaClient');
const cache = require('../utils/cacheHelper');
const ranking = require('../utils/homepageRanking');

// ── Helpers ────────────────────────────────────────────────────────────

function mapTourCard(tour) {
  const schedulesAndPricing = typeof tour.schedulesAndPricing === 'string'
    ? JSON.parse(tour.schedulesAndPricing || '{}')
    : tour.schedulesAndPricing || {};

  return {
    id: tour.id,
    title: tour.title,
    slug: tour.slug,
    coverPhoto: tour.coverPhoto || null,
    photos: Array.isArray(tour.photos) ? tour.photos : [],
    category: tour.category,
    durationMinutes: tour.durationMinutes,
    startingPrice: tour.startingPrice || null,
    currency: schedulesAndPricing?.pricingSchedules?.currency || 'USD',
    averageRating: tour.averageRating ? Number(tour.averageRating) : null,
    reviewCount: tour.reviewCount,
    viewCount: tour.viewCount,
    city: tour.city,
    country: tour.country,
    supplierName: tour.supplier?.name || null,
    supplierPhoto: tour.supplier?.photoURL || null,
  };
}

const TOUR_SELECT = {
  id: true, title: true, slug: true, coverPhoto: true, photos: true,
  category: true, city: true, country: true, averageRating: true,
  reviewCount: true, totalBookings: true, viewCount: true,
  durationMinutes: true, difficulty: true, tags: true,
  schedulesAndPricing: true, createdAt: true,
  supplier: { select: { name: true, photoURL: true } },
};

// ── GET /api/travioafrica/homepage ─────────────────────────────────────

/**
 * Unified homepage endpoint — returns all TravioAfrica-scoped sections
 * in one call. Same 9 keys as the shared /homepage endpoint.
 */
exports.getAfricaHomepage = catchAsync(async (req, res) => {
  const userId = req.user?.id || null;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  const cacheKey = `travioafrica:homepage:${userId || 'anon'}:${lat || 0}:${lng || 0}`;
  const ttl = 300;

  const result = await cache.getOrSet(cacheKey, async () => {
    // Query TravioAfricaTour directly for curated sections
    const [sellOut, topRated, recommended, newTours, destinations, mood, offers] = await Promise.all([
      getAfricaSellOut(12),
      getAfricaTopRated(12),
      getAfricaRecommended(userId, 12),
      getAfricaNewExperiences(10),
      getAfricaDestinations(10),
      getAfricaMoodKeywords(userId, 8),
      getAfricaOffers(12),
    ]);

    // Trending and attractions use the shared ranking engine
    // (platform scope is a follow-up — these show all ACTIVE tours for now)
    const [trending, attractions] = await Promise.all([
      ranking.getTrending(12),
      ranking.getAttractions(10, lat, lng),
    ]);

    return {
      sellOut,
      topRated,
      trending,
      recommended,
      newExperiences: newTours,
      attractions,
      mood,
      destinations,
      offers,
    };
  }, ttl);

  res.json({ status: 'success', data: result });
});

// ── Section Functions (TravioAfricaTour-scoped) ────────────────────────

async function getAfricaSellOut(limit) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);

  const velocity = await prisma.booking.groupBy({
    by: ['tourId'],
    where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, createdAt: { gte: cutoff } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: limit * 2,
  });

  const tourIds = velocity.map(v => v.tourId);
  if (tourIds.length === 0) return [];

  const tours = await prisma.travioAfricaTour.findMany({
    where: { tourId: { in: tourIds }, isActive: true, tour: { status: 'ACTIVE' } },
    include: { tour: { select: TOUR_SELECT } },
  });

  return tours.map(r => ({ ...mapTourCard(r.tour), _velocity14d: velocity.find(v => v.tourId === r.tourId)?._count?.id || 0 }));
}

async function getAfricaTopRated(limit) {
  const tours = await prisma.travioAfricaTour.findMany({
    where: { isActive: true, tour: { status: 'ACTIVE', averageRating: { not: null }, reviewCount: { gte: 1 } } },
    include: { tour: { select: TOUR_SELECT } },
    take: limit * 2,
  });

  return tours
    .map(r => mapTourCard(r.tour))
    .sort((a, b) => (b.averageRating || 0) - (a.averageRating || 0))
    .slice(0, limit);
}

async function getAfricaRecommended(userId, limit) {
  const tours = await prisma.travioAfricaTour.findMany({
    where: { isActive: true, tour: { status: 'ACTIVE' } },
    include: { tour: { select: TOUR_SELECT } },
    orderBy: { tour: { totalBookings: 'desc' } },
    take: limit,
  });

  return tours.map(r => mapTourCard(r.tour));
}

async function getAfricaNewExperiences(limit) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const tours = await prisma.travioAfricaTour.findMany({
    where: { isActive: true, tour: { status: 'ACTIVE', createdAt: { gte: cutoff } } },
    include: { tour: { select: TOUR_SELECT } },
    orderBy: { tour: { createdAt: 'desc' } },
    take: limit,
  });

  return tours.map(r => mapTourCard(r.tour));
}

async function getAfricaDestinations(limit) {
  const cities = await prisma.$queryRaw`
    SELECT
      t.city,
      t.country,
      COUNT(*)::int AS "tourCount",
      COALESCE(SUM(t."totalBookings"), 0)::int AS "totalBookings",
      ROUND(AVG(CASE WHEN t."averageRating" IS NOT NULL THEN t."averageRating"::numeric END), 2) AS "avgRating",
      (SELECT t2."coverPhoto" FROM "Tour" t2
       JOIN "TravioAfricaTour" tat2 ON tat2."tourId" = t2.id AND tat2."isActive" = true
       WHERE t2.city = t.city AND t2.status = 'ACTIVE' AND t2."coverPhoto" IS NOT NULL
       ORDER BY t2."averageRating" DESC NULLS LAST LIMIT 1) AS "heroImage"
    FROM "Tour" t
    JOIN "TravioAfricaTour" tat ON tat."tourId" = t.id AND tat."isActive" = true
    WHERE t.status = 'ACTIVE' AND t.city IS NOT NULL
    GROUP BY t.city, t.country
    HAVING COUNT(*) >= 1
    ORDER BY "totalBookings" DESC, "avgRating" DESC NULLS LAST
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
}

async function getAfricaMoodKeywords(userId, limit) {
  const tours = await prisma.travioAfricaTour.findMany({
    where: { isActive: true, tour: { status: 'ACTIVE' } },
    select: { tour: { select: { category: true, coverPhoto: true, tags: true } } },
    take: 500,
  });

  const categoryMap = new Map();
  for (const r of tours) {
    const cat = r.tour?.category;
    if (!cat) continue;
    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, { keyword: cat, image: r.tour.coverPhoto, tourCount: 0, category: cat });
    }
    categoryMap.get(cat).tourCount++;
  }

  return Array.from(categoryMap.values())
    .sort((a, b) => b.tourCount - a.tourCount)
    .slice(0, limit);
}

async function getAfricaOffers(limit) {
  const now = new Date();
  const offers = await prisma.specialOffer.findMany({
    where: {
      isActive: true,
      OR: [{ startDate: null }, { startDate: { lte: now } }],
      AND: [{ endDate: null }, { endDate: { gte: now } }],
      targets: { some: { tour: { travioAfricaTour: { isActive: true } } } },
    },
    include: {
      targets: {
        include: { tour: { select: TOUR_SELECT } },
        take: limit,
      },
    },
    take: 10,
  });

  const result = [];
  for (const offer of offers) {
    for (const target of offer.targets) {
      if (result.length >= limit) break;
      const card = mapTourCard(target.tour);
      card.specialOffers = [{
        id: offer.id, name: offer.name, offerType: offer.offerType,
        discountType: offer.discountType, discountPercentage: offer.discountPercentage,
        fixedDiscountValue: offer.fixedDiscountValue, startDate: offer.startDate,
        endDate: offer.endDate, promoCode: offer.promoCode,
      }];
      result.push(card);
    }
  }

  return result;
}
