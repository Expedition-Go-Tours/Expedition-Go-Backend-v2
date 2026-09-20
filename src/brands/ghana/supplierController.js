const prisma = require('../../core/services/prismaClient');
const catchAsync = require('../../core/services/catchAsync');
const makeSupplierController = require('../../core/supplier');


const getSupplierTours = catchAsync(async (req, res) => {
  const supplierId = req.user.id;
  const { page = 1, limit = 20, status } = req.query;
  const MAX_LIMIT = 200;
  const take = Math.min(parseInt(limit), MAX_LIMIT);
  const skip = (parseInt(page) - 1) * take;

  const where = { tour: { supplierId } };
  if (status) where.isActive = status === 'ACTIVE';

  const listingSelect = {
    id: true, tourId: true, isActive: true, bookingFlow: true, externalUrl: true,
    displayOrder: true, isFeatured: true, createdAt: true, updatedAt: true,
  };
  const tourSelect = {
    select: {
      id: true, title: true, slug: true, coverPhoto: true, photos: true,
      category: true, status: true, draftStatus: true, averageRating: true,
      reviewCount: true, totalBookings: true, durationMinutes: true,
      city: true, country: true, description: true, tags: true,
      schedulesAndPricing: true, productContent: true, categorization: true,
      bookingAndTickets: true, createdAt: true, updatedAt: true,
      _count: { select: { bookings: true } },
      supplier: { select: { id: true, name: true, photoURL: true } },
    },
  };

  const [ghanaRows, expeditionRows, supplierTours] = await Promise.all([
    prisma.travioGhanaTour.findMany({ where, select: { ...listingSelect, tour: tourSelect } }),
    prisma.expeditionTour.findMany({ where, select: { ...listingSelect, tour: tourSelect } }),
    // Every non-archived tour owned by the supplier, including drafts and
    // submissions that have no storefront listing row yet. Without this the
    // dashboard could never show a draft — listing rows only exist once a
    // tour has been published to a storefront.
    prisma.tour.findMany({
      where: { supplierId, status: { not: 'ARCHIVED' } },
      select: { ...tourSelect.select },
    }),
  ]);

  const mapRow = (r, storefront) => ({
    ...r,
    ...r.tour,
    storefront,
    bookings: r.tour._count?.bookings ?? 0,
    _count: undefined,
  });

  // A Tour can be listed on both storefronts — dedupe by tourId so each tour
  // appears once, tagged with its storefront presence ('GHANA' | 'EXPEDITION' |
  // 'BOTH'). Ghana rows are primary (manageable); expedition presence is
  // surfaced via `expeditionListing` so the frontend can badge/read-only-gate.
  const merged = new Map();
  for (const r of ghanaRows) merged.set(r.tourId, mapRow(r, 'GHANA'));
  for (const r of expeditionRows) {
    const row = mapRow(r, 'EXPEDITION');
    if (merged.has(r.tourId)) {
      merged.set(r.tourId, {
        ...merged.get(r.tourId),
        storefront: 'BOTH',
        expeditionListing: {
          isActive: r.isActive, bookingFlow: r.bookingFlow, externalUrl: r.externalUrl,
          displayOrder: r.displayOrder, isFeatured: r.isFeatured,
        },
      });
    } else {
      merged.set(r.tourId, row);
    }
  }

  // Tours with no storefront listing (drafts, brand-new products, rejected
  // submissions) still belong on the supplier's dashboard so they can be
  // edited and submitted. Tag them with a null storefront.
  for (const t of supplierTours) {
    if (merged.has(t.id)) continue;
    merged.set(t.id, {
      ...t,
      storefront: null,
      bookings: t._count?.bookings ?? 0,
      _count: undefined,
    });
  }

  const all = [...merged.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = all.length;
  const tours = all.slice(skip, skip + take);

  res.json({
    status: 'success',
    data: { tours },
    pagination: { currentPage: parseInt(page), totalPages: Math.ceil(total / take), totalCount: total, limit: take },
  });
});

// ══════════════════════════════════════════════════════════════════════════
// REVIEWS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/reviews
 *
 * Reviews on the supplier's Ghana tours.
 */
const getSupplierReviews = catchAsync(async (req, res) => {
  const supplierId = req.user.id;
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
  const take = Math.min(parseInt(limit), 50);

  const [ghanaTours, expeditionTours] = await Promise.all([
    prisma.travioGhanaTour.findMany({ where: { tour: { supplierId } }, select: { tourId: true } }),
    prisma.expeditionTour.findMany({ where: { tour: { supplierId } }, select: { tourId: true } }),
  ]);
  const ghanaIds = new Set(ghanaTours.map(t => t.tourId));
  const expeditionIds = new Set(expeditionTours.map(t => t.tourId));
  const tourIds = [...ghanaIds, ...expeditionIds];

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where: { tourId: { in: tourIds } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, photoURL: true, email: true, phone: true } },
        tour: { select: { id: true, title: true, slug: true, coverPhoto: true } },
      },
    }),
    prisma.review.count({ where: { tourId: { in: tourIds } } }),
  ]);

  const augmented = reviews.map(review => ({
    ...review,
    storefront: expeditionIds.has(review.tourId) && !ghanaIds.has(review.tourId) ? 'EXPEDITION' : 'GHANA',
  }));

  res.json({
    status: 'success',
    data: { reviews: augmented },
    pagination: { currentPage: parseInt(page), totalPages: Math.ceil(total / take), totalCount: total, limit: take },
  });
});

const ghana = makeSupplierController('ghana');

module.exports = {
  ...ghana,
  getSupplierTours,
  getSupplierReviews,
};
module.exports.makeSupplierController = makeSupplierController;
