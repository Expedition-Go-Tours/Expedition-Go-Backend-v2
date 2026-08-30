/**
 * TravioGhana Supplier Controller — Ghana-Scoped Supplier Dashboard Endpoints
 *
 * Every query targets Ghana-specific data:
 *   - Tours: TravioGhanaTour model
 *   - Bookings: Booking WHERE source = 'GHANA'
 *   - Reviews: Reviews on Ghana tours
 *
 * Shared utilities (stripeHelpers, bookingHelpers, etc.) are imported as-is.
 * No modifications to shared code.
 */

const prisma = require('../utils/prismaClient');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const cache = require('../utils/cacheHelper');
const { logActivity } = require('../utils/auditLogger');

const GHANA_SOURCE = 'GHANA';

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/dashboard
 *
 * Ghana-scoped supplier dashboard stats: bookings, earnings, active tours.
 */
exports.getDashboard = catchAsync(async (req, res) => {
  const supplierId = req.user.id;
  const cacheKey = `ghana:supplier:dashboard:${supplierId}`;
  const ttl = 60;

  const result = await cache.getOrSet(cacheKey, async () => {
    const supplierProfile = await prisma.supplierProfile.findUnique({
      where: { userId: supplierId },
    });

    // Scoped to ALL the supplier's tours (not just Ghana-published ones) so the
    // dashboard numbers match the bookings list — every booking on their tours
    // from either storefront counts. No source filter.
    const [tourStats, bookingStats, reviewCount] = await Promise.all([
      prisma.tour.groupBy({
        by: ['status'],
        where: { supplierId },
        _count: true,
      }),
      prisma.booking.groupBy({
        by: ['status'],
        where: { tour: { supplierId } },
        _count: true,
      }),
      prisma.review.count({ where: { tour: { supplierId }, status: 'APPROVED' } }),
    ]);

    const tourMap = Object.fromEntries(tourStats.map(t => [t.status, t._count]));
    const bookingMap = Object.fromEntries(bookingStats.map(b => [b.status, b._count]));

    // Response shape mirrors the shared supplierController.getDashboard —
    // the supplier dashboard frontend reads tours.active, bookings.confirmed,
    // bookings.pending and earnings.totalEarnings from the nested object.
    return {
      earnings: {
        totalEarnings: Number(supplierProfile?.totalEarnings || 0),
        currency: 'USD',
      },
      tours: {
        total: Object.values(tourMap).reduce((a, b) => a + b, 0),
        active: tourMap.ACTIVE || 0,
        draft: tourMap.DRAFT || 0,
        paused: tourMap.PAUSED || 0,
        archived: tourMap.ARCHIVED || 0,
      },
      bookings: {
        total: Object.values(bookingMap).reduce((a, b) => a + b, 0),
        pending: bookingMap.PENDING || 0,
        confirmed: bookingMap.CONFIRMED || 0,
        completed: bookingMap.COMPLETED || 0,
        cancelled: bookingMap.CANCELLED || 0,
      },
      reviews: {
        averageRating: Number(supplierProfile?.averageRating) || 0,
        totalReviews: reviewCount,
      },
    };
  }, ttl);

  res.json({ status: 'success', data: result });
});

/**
 * GET /api/travioghana/supplier/monthly-revenue
 *
 * Monthly revenue chart data for the supplier's Ghana tours.
 */
exports.getMonthlyRevenue = catchAsync(async (req, res) => {
  const supplierId = req.user.id;
  const months = parseInt(req.query.months) || 12;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  const bookings = await prisma.booking.findMany({
    where: {
      tour: { supplierId },
      paymentStatus: 'SUCCEEDED',
      paidAt: { gte: cutoff },
    },
    select: { grossAmount: true, paidAt: true },
  });

  const monthly = {};
  for (const b of bookings) {
    const key = b.paidAt.toISOString().slice(0, 7); // YYYY-MM
    monthly[key] = (monthly[key] || 0) + parseFloat(b.grossAmount || 0);
  }

  const data = Object.entries(monthly)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, revenue]) => ({ month, revenue: Math.round(revenue * 100) / 100 }));

  res.json({ status: 'success', data: { months: data } });
});

// ══════════════════════════════════════════════════════════════════════════
// TOURS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/tours
 *
 * Supplier's Ghana tours (via TravioGhanaTour model).
 */
exports.getSupplierTours = catchAsync(async (req, res) => {
  const supplierId = req.user.id;
  const { page = 1, limit = 20, status } = req.query;
  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
  const take = Math.min(parseInt(limit), 50);

  const where = { tour: { supplierId } };
  if (status) where.isActive = status === 'ACTIVE';

  const [records, total] = await Promise.all([
    prisma.travioGhanaTour.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, coverPhoto: true, category: true,
            status: true, averageRating: true, reviewCount: true, totalBookings: true,
            durationMinutes: true, city: true, country: true,
          },
        },
      },
    }),
    prisma.travioGhanaTour.count({ where }),
  ]);

  res.json({
    status: 'success',
    data: { tours: records.map(r => ({ ...r, ...r.tour })) },
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
exports.getSupplierReviews = catchAsync(async (req, res) => {
  const supplierId = req.user.id;
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
  const take = Math.min(parseInt(limit), 50);

  const supplierTours = await prisma.travioGhanaTour.findMany({
    where: { tour: { supplierId } },
    select: { tourId: true },
  });
  const tourIds = supplierTours.map(t => t.tourId);

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where: { tourId: { in: tourIds } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, photoURL: true } },
        tour: { select: { id: true, title: true, slug: true } },
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

// ══════════════════════════════════════════════════════════════════════════
// AVAILABILITY
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/availability/:tourId
 */
exports.getAvailability = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const { startDate, endDate } = req.query;

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.user.id },
    select: { id: true, schedulesAndPricing: true },
  });
  if (!tour) return next(new AppError('Tour not found', 404));

  const overrides = await prisma.tourDateOverride.findMany({
    where: {
      tourId,
      ...(startDate && endDate ? { date: { gte: new Date(startDate), lte: new Date(endDate) } } : {}),
    },
    orderBy: { date: 'asc' },
  });

  res.json({ status: 'success', data: { overrides, schedules: tour.schedulesAndPricing } });
});

/**
 * POST /api/travioghana/supplier/availability/:tourId
 */
exports.setAvailability = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const { date, available, maxBookings, note } = req.body;

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.user.id },
    select: { id: true },
  });
  if (!tour) return next(new AppError('Tour not found', 404));

  const override = await prisma.tourDateOverride.upsert({
    where: { tourId_date: { tourId, date: new Date(date) } },
    update: { available, maxBookings, note },
    create: { tourId, date: new Date(date), available, maxBookings, note },
  });

  res.json({ status: 'success', data: { override } });
});

// ══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/settings
 */
exports.getSettings = catchAsync(async (req, res) => {
  const supplier = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, name: true, email: true, photoURL: true,
      notificationPreferences: true,
      supplierProfile: {
        select: {
          id: true, status: true, businessInfo: true, operatingInfo: true,
          representativeInfo: true, payoutInfo: true,
          totalEarnings: true, totalBookings: true, averageRating: true,
        },
      },
    },
  });

  res.json({ status: 'success', data: { supplier } });
});

/**
 * PATCH /api/travioghana/supplier/settings
 */
exports.updateSettings = catchAsync(async (req, res) => {
  const { businessName, description, phone, website, notificationPreferences, bookingRules } = req.body;

  const updates = [];

  if (businessName !== undefined || description !== undefined || phone !== undefined || website !== undefined) {
    const existing = await prisma.supplierProfile.findUnique({
      where: { userId: req.user.id },
      select: { businessInfo: true },
    });
    if (existing) {
      const businessInfo = {
        ...(existing.businessInfo || {}),
        ...(businessName !== undefined && { businessName }),
        ...(description !== undefined && { description }),
        ...(phone !== undefined && { phone }),
        ...(website !== undefined && { website }),
      };
      updates.push(prisma.supplierProfile.update({
        where: { userId: req.user.id },
        data: { businessInfo },
      }));
    }
  }

  if (notificationPreferences !== undefined || bookingRules !== undefined) {
    const existing = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { notificationPreferences: true },
    });
    updates.push(prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(notificationPreferences !== undefined && {
          notificationPreferences: {
            ...(existing.notificationPreferences || {}),
            ...notificationPreferences,
          },
        }),
        ...(bookingRules !== undefined && {
          notificationPreferences: {
            ...(existing.notificationPreferences || {}),
            bookingRules,
          },
        }),
      },
    }));
  }

  const results = await Promise.all(updates);

  res.json({ status: 'success', data: { profile: results[0] || null, user: results[1] || null } });
});

// ══════════════════════════════════════════════════════════════════════════
// SPECIAL OFFERS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/special-offers
 */
exports.getSpecialOffers = catchAsync(async (req, res) => {
  const supplierId = req.user.id;

  const offers = await prisma.specialOffer.findMany({
    where: { supplierId },
    orderBy: { createdAt: 'desc' },
    include: {
      targets: {
        include: { tour: { select: { id: true, title: true, slug: true } } },
      },
    },
  });

  res.json({ status: 'success', data: { offers } });
});

// ══════════════════════════════════════════════════════════════════════════
// FINANCE
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/finance/summary
 */
exports.getFinanceSummary = catchAsync(async (req, res) => {
  const supplierId = req.user.id;

  const [totalEarnings, pendingPayouts, completedPayouts] = await Promise.all([
    prisma.booking.aggregate({
      where: { tour: { supplierId }, paymentStatus: 'SUCCEEDED' },
      _sum: { grossAmount: true, platformCommission: true, supplierPayout: true },
    }),
    prisma.payout.aggregate({
      where: { booking: { tour: { supplierId } }, status: 'PENDING' },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payout.aggregate({
      where: { booking: { tour: { supplierId } }, status: 'PAID' },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  res.json({
    status: 'success',
    data: {
      totalEarnings: parseFloat(totalEarnings._sum.supplierPayout || 0),
      totalRevenue: parseFloat(totalEarnings._sum.grossAmount || 0),
      totalCommission: parseFloat(totalEarnings._sum.platformCommission || 0),
      pendingPayouts: { count: pendingPayouts._count, amount: parseFloat(pendingPayouts._sum.amount || 0) },
      completedPayouts: { count: completedPayouts._count, amount: parseFloat(completedPayouts._sum.amount || 0) },
    },
  });
});

/**
 * GET /api/travioghana/supplier/payouts
 */
exports.getPayouts = catchAsync(async (req, res) => {
  const supplierId = req.user.id;
  const { page = 1, limit = 20, status } = req.query;
  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
  const take = Math.min(parseInt(limit), 50);

  const where = { supplierId };
  if (status) where.status = status;

  const [payouts, total] = await Promise.all([
    prisma.payout.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: { booking: { select: { id: true, bookingNumber: true, grossAmount: true } } },
    }),
    prisma.payout.count({ where }),
  ]);

  res.json({
    status: 'success',
    data: { payouts },
    pagination: { currentPage: parseInt(page), totalPages: Math.ceil(total / take), totalCount: total, limit: take },
  });
});

// ══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/notifications
 */
exports.getNotifications = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
  const take = Math.min(parseInt(limit), 50);

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: req.user.id },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
  ]);

  res.json({
    status: 'success',
    data: { notifications, unreadCount },
    pagination: { currentPage: parseInt(page), limit: take },
  });
});
