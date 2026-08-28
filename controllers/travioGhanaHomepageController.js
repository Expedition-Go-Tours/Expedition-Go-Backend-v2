/**
 * TravioGhana Homepage Controller — Ghana-Scoped Homepage Data
 *
 * Returns homepage sections filtered to Ghana tours only.
 * Queries TravioGhanaTour model instead of ExpeditionTour.
 *
 * Sections: mood, recommended, top-rated, sell-out, new, destinations, offers
 */

const catchAsync = require('../utils/catchAsync');
const prisma = require('../utils/prismaClient');
const cache = require('../utils/cacheHelper');
const { cheapestRetailPrice } = require('../utils/tourHelpers');

const GHANA_SOURCE = 'GHANA';

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
    startingPrice: cheapestRetailPrice(schedulesAndPricing),
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

// ── GET /api/travioghana/homepage ──────────────────────────────────────

/**
 * Unified homepage endpoint — returns all Ghana-scoped sections in one call.
 */
exports.getGhanaHomepage = catchAsync(async (req, res) => {
  const userId = req.user?.id || null;
  const lat = parseFloat(req.query.lat) || null;
  const lng = parseFloat(req.query.lng) || null;

  const cacheKey = `ghana:homepage:${userId || 'anon'}:${lat || 0}:${lng || 0}`;
  const ttl = 300;

  const result = await cache.getOrSet(cacheKey, async () => {
    const [sellOut, topRated, recommended, newTours, destinations, mood, offers] = await Promise.all([
      getGhanaSellOut(12),
      getGhanaTopRated(12),
      getGhanaRecommended(userId, 12),
      getGhanaNewExperiences(10),
      getGhanaDestinations(10),
      getGhanaMoodKeywords(userId, 8),
      getGhanaOffers(12),
    ]);

    return { sellOut, topRated, recommended, new: newTours, destinations, mood, offers };
  }, ttl);

  res.json({ status: 'success', data: result });
});

// ── Section Functions ──────────────────────────────────────────────────

async function getGhanaSellOut(limit) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);

  const velocity = await prisma.booking.groupBy({
    by: ['tourId'],
    where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, source: GHANA_SOURCE, createdAt: { gte: cutoff } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: limit * 2,
  });

  const tourIds = velocity.map(v => v.tourId);
  if (tourIds.length === 0) return [];

  const tours = await prisma.travioGhanaTour.findMany({
    where: { tourId: { in: tourIds }, isActive: true, tour: { status: 'ACTIVE' } },
    include: { tour: { select: TOUR_SELECT } },
  });

  return tours.map(r => ({ ...mapTourCard(r.tour), _velocity14d: velocity.find(v => v.tourId === r.tourId)?._count?.id || 0 }));
}

async function getGhanaTopRated(limit) {
  const tours = await prisma.travioGhanaTour.findMany({
    where: { isActive: true, tour: { status: 'ACTIVE', averageRating: { not: null }, reviewCount: { gte: 1 } } },
    include: { tour: { select: TOUR_SELECT } },
    take: limit * 2,
  });

  return tours
    .map(r => mapTourCard(r.tour))
    .sort((a, b) => (b.averageRating || 0) - (a.averageRating || 0))
    .slice(0, limit);
}

async function getGhanaRecommended(userId, limit) {
  const tours = await prisma.travioGhanaTour.findMany({
    where: { isActive: true, tour: { status: 'ACTIVE' } },
    include: { tour: { select: TOUR_SELECT } },
    orderBy: { tour: { totalBookings: 'desc' } },
    take: limit,
  });

  return tours.map(r => mapTourCard(r.tour));
}

async function getGhanaNewExperiences(limit) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const tours = await prisma.travioGhanaTour.findMany({
    where: { isActive: true, tour: { status: 'ACTIVE', createdAt: { gte: cutoff } } },
    include: { tour: { select: TOUR_SELECT } },
    orderBy: { tour: { createdAt: 'desc' } },
    take: limit,
  });

  return tours.map(r => mapTourCard(r.tour));
}

async function getGhanaDestinations(limit) {
  const cities = await prisma.$queryRaw`
    SELECT
      t.city,
      t.country,
      COUNT(*)::int AS "tourCount",
      COALESCE(SUM(t."totalBookings"), 0)::int AS "totalBookings",
      ROUND(AVG(CASE WHEN t."averageRating" IS NOT NULL THEN t."averageRating"::numeric END), 2) AS "avgRating",
      (SELECT t2."coverPhoto" FROM "Tour" t2
       JOIN "TravioGhanaTour" tgt2 ON tgt2."tourId" = t2.id AND tgt2."isActive" = true
       WHERE t2.city = t.city AND t2.status = 'ACTIVE' AND t2."coverPhoto" IS NOT NULL
       ORDER BY t2."averageRating" DESC NULLS LAST LIMIT 1) AS "heroImage"
    FROM "Tour" t
    JOIN "TravioGhanaTour" tgt ON tgt."tourId" = t.id AND tgt."isActive" = true
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

async function getGhanaMoodKeywords(userId, limit) {
  // Simplified mood keywords — returns categories with tour counts
  const tours = await prisma.travioGhanaTour.findMany({
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

async function getGhanaOffers(limit) {
  const now = new Date();
  const offers = await prisma.specialOffer.findMany({
    where: {
      isActive: true,
      OR: [{ startDate: null }, { startDate: { lte: now } }],
      AND: [{ endDate: null }, { endDate: { gte: now } }],
      targets: { some: { tour: { travioGhanaTour: { isActive: true } } } },
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
