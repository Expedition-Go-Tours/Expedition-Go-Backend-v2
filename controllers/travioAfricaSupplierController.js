/**
 * Travio Africa supplier dashboard controller.
 *
 * Reuses the shared brand-parameterized supplier factory (see
 * controllers/travioGhanaSupplierController.js — makeSupplierController). The
 * `africa` brand config points it at the TravioAfricaTour listing model,
 * BookingSource.TRAVIO_AFRICA, the `travioafrica` role, and Africa's domains.
 *
 * Travio Africa has NO sub-store (Ghana owns the Expedition sub-store), so the
 * two storefront-marker functions (getSupplierTours / getSupplierReviews) are
 * simplified here to query only the Africa listing model.
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const { makeSupplierController } = require('../src/core/supplier');

const base = makeSupplierController('africa');

const LISTING_SELECT = {
  id: true, tourId: true, isActive: true, bookingFlow: true, externalUrl: true,
  displayOrder: true, isFeatured: true, createdAt: true, updatedAt: true,
};

const TOUR_SELECT = {
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

// GET /api/travioafrica/supplier/tours
const getSupplierTours = catchAsync(async (req, res) => {
  const supplierId = req.user.id;
  const { page = 1, limit = 20, status } = req.query;
  const take = Math.min(parseInt(limit), 200);
  const skip = (parseInt(page) - 1) * take;

  const where = { tour: { supplierId } };
  if (status) where.isActive = status === 'ACTIVE';

  const [africaRows, supplierTours] = await Promise.all([
    prisma.travioAfricaTour.findMany({ where, select: { ...LISTING_SELECT, tour: TOUR_SELECT } }),
    prisma.tour.findMany({
      where: { supplierId, status: { not: 'ARCHIVED' } },
      select: { ...TOUR_SELECT.select },
    }),
  ]);

  const merged = new Map();
  for (const r of africaRows) {
    merged.set(r.tourId, { ...r, ...r.tour, storefront: 'AFRICA', bookings: r.tour._count?.bookings ?? 0, _count: undefined });
  }
  for (const t of supplierTours) {
    if (merged.has(t.id)) continue;
    merged.set(t.id, { ...t, storefront: null, bookings: t._count?.bookings ?? 0, _count: undefined });
  }

  const all = [...merged.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = all.length;

  res.json({
    status: 'success',
    data: { tours: all.slice(skip, skip + take) },
    pagination: { currentPage: parseInt(page), totalPages: Math.ceil(total / take), totalCount: total, limit: take },
  });
});

// GET /api/travioafrica/supplier/reviews
const getSupplierReviews = catchAsync(async (req, res) => {
  const supplierId = req.user.id;
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
  const take = Math.min(parseInt(limit), 50);

  const africaTours = await prisma.travioAfricaTour.findMany({ where: { tour: { supplierId } }, select: { tourId: true } });
  const tourIds = africaTours.map((t) => t.tourId);

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

  res.json({
    status: 'success',
    data: { reviews },
    pagination: { currentPage: parseInt(page), totalPages: Math.ceil(total / take), totalCount: total, limit: take },
  });
});

module.exports = { ...base, getSupplierTours, getSupplierReviews };
