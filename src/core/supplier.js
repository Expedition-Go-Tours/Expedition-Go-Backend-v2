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

const prisma = require('./services/prismaClient');
const AppError = require('./services/appError');
const catchAsync = require('./services/catchAsync');
const cache = require('./services/cacheHelper');
const { invalidateKeys } = require('./services/cacheHelper');
const { computeOfferStatus } = require('./services/offerStatus');
const { getBrand } = require('../../config/brands');
const getConfig = require('./services/getConfig');
const {
  parseBlob,
  isPerGroupTour,
  getEffectiveCapacity,
} = require('./services/availabilityCore');


// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/dashboard
 *
 * Ghana-scoped supplier dashboard stats: bookings, earnings, active tours.
 */

function makeSupplierController(brandKey) {
  const BRAND = getBrand(brandKey);
  const controller = {};

controller.getDashboard = catchAsync(async (req, res) => {
  const supplierId = req.supplierId || req.user.id;
  const cacheKey = `${BRAND.cachePrefix}supplier:dashboard:${supplierId}`;
  const ttl = 60;

  const result = await cache.getOrSet(cacheKey, async () => {
    const supplierProfile = await prisma.supplierProfile.findUnique({
      where: { userId: supplierId },
    });

    // Scoped to ALL the supplier's tours (not just Ghana-published ones) so the
    // dashboard numbers match the bookings list — every booking on their tours
    // from either storefront counts. No source filter.
    const [tourStats, bookingStats, reviewCount, earningsAgg] = await Promise.all([
      prisma.tour.groupBy({
        by: ['status'],
        where: { supplierId },
        _count: true,
      }),
      prisma.booking.groupBy({
        by: ['status'],
        where: { tour: { supplierId }, isSimulated: false },
        _count: true,
      }),
      prisma.review.count({ where: { tour: { supplierId }, status: 'APPROVED' } }),
      // PER CURRENCY. Summing GH¢200 and $200 into one number printed as "$"
      // is the same lie the Finance summary used to tell; the card renders one
      // figure per currency and a scalar only when there is exactly one.
      prisma.booking.groupBy({
        by: ['currency'],
        where: { tour: { supplierId }, isSimulated: false, paymentStatus: 'SUCCEEDED' },
        _sum: { supplierPayout: true, grossAmount: true },
        _count: { _all: true },
      }),
    ]);

    const tourMap = Object.fromEntries(tourStats.map(t => [t.status, t._count]));
    const bookingMap = Object.fromEntries(bookingStats.map(b => [b.status, b._count]));

    // Earnings, per currency. `totalEarnings` is the scalar ONLY for a
    // single-currency account — it is null the moment a second currency
    // appears, so no consumer can print a total the account does not hold.
    // An account with NO paid bookings gets a real 0: that is a measurement
    // ("you have earned nothing yet"), not an unknown.
    const earningsByCurrency = (earningsAgg || [])
      .map((r) => ({
        currency: r.currency || 'USD',
        supplierCut: Number(r._sum?.supplierPayout || 0),
        gross: Number(r._sum?.grossAmount || 0),
        bookings: r._count?._all || 0,
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
    const singleEarnings = earningsByCurrency.length === 1 ? earningsByCurrency[0] : null;
    const emptyEarnings = earningsByCurrency.length === 0;

    // Top products — the supplier's tours ranked by booking volume, with the
    // revenue each has generated. Drives the "Top Products" card on the
    // dashboard (previously a hardcoded "coming soon" placeholder).
    const topProductRows = await prisma.booking.groupBy({
      by: ['tourId'],
      where: { tour: { supplierId }, isSimulated: false, status: { not: 'CANCELLED' } },
      _count: { _all: true },
      _sum: { grossAmount: true },
      orderBy: { _count: { tourId: 'desc' } },
      take: 5,
    });

    const topTourIds = topProductRows.map((r) => r.tourId);
    const topTours = topTourIds.length
      ? await prisma.tour.findMany({
          where: { id: { in: topTourIds } },
          select: { id: true, title: true, coverPhoto: true, status: true, averageRating: true, reviewCount: true },
        })
      : [];
    const topTourMap = Object.fromEntries(topTours.map((t) => [t.id, t]));

    const topProducts = topProductRows
      .filter((r) => topTourMap[r.tourId])
      .map((r) => ({
        id: r.tourId,
        title: topTourMap[r.tourId].title,
        coverPhoto: topTourMap[r.tourId].coverPhoto || null,
        status: topTourMap[r.tourId].status,
        averageRating: Number(topTourMap[r.tourId].averageRating) || 0,
        reviewCount: topTourMap[r.tourId].reviewCount || 0,
        bookings: r._count?._all || 0,
        revenue: Number(r._sum?.grossAmount || 0),
      }));

    // Response shape mirrors the shared supplierController.getDashboard —
    // the supplier dashboard frontend reads tours.active, bookings.confirmed,
    // bookings.pending and earnings.totalEarnings from the nested object.
    // totalEarnings is computed live from SUCCEEDED bookings (supplier's cut)
    // so it reflects actual earnings even if the profile column is stale.
    return {
      earnings: {
        // null when the account holds more than one currency: the UI must walk
        // `byCurrency` rather than print a summed figure. Zero when nothing has
        // been earned — a measured zero, not an unknown.
        totalEarnings: singleEarnings
          ? singleEarnings.supplierCut
          : (emptyEarnings ? 0 : null),
        totalRevenue: singleEarnings
          ? singleEarnings.gross
          : (emptyEarnings ? 0 : null),
        currency: singleEarnings ? singleEarnings.currency : (emptyEarnings ? 'USD' : null),
        byCurrency: earningsByCurrency,
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
      topProducts,
    };
  }, ttl);

  res.json({ status: 'success', data: result });
});

/**
 * GET /api/travioghana/supplier/monthly-revenue
 *
 * Monthly revenue chart data for the supplier's tours: a continuous window of
 * whole calendar months ending with the current one, so a quiet month shows as
 * an empty slot instead of being silently skipped (which made the trend look
 * continuous across gaps). Demo/seed bookings are excluded so the chart agrees
 * with the revenue totals the dashboard endpoint reports for the same page.
 */
controller.getMonthlyRevenue = catchAsync(async (req, res) => {
  const supplierId = req.supplierId || req.user.id;
  const months = Math.max(1, Math.min(36, parseInt(req.query.months, 10) || 12));

  // Bucket in UTC (the platform's storefront timezone is Accra = UTC+0) so the
  // window never shifts with the server's local timezone.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const bookings = await prisma.booking.findMany({
    where: {
      tour: { supplierId },
      isSimulated: false,
      paymentStatus: 'SUCCEEDED',
      paidAt: { gte: start },
    },
    select: { grossAmount: true, paidAt: true },
  });

  const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  // Seed every month in the window with 0, ascending.
  const monthly = new Map();
  for (let i = 0; i < months; i += 1) {
    monthly.set(monthKey(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))), 0);
  }

  for (const b of bookings) {
    if (!b.paidAt) continue;
    const key = monthKey(new Date(b.paidAt));
    if (monthly.has(key)) monthly.set(key, monthly.get(key) + parseFloat(b.grossAmount || 0));
  }

  const data = [...monthly.entries()].map(([month, revenue]) => ({
    month,
    revenue: Math.round(revenue * 100) / 100,
  }));

  res.json({ status: 'success', data: { months: data } });
});

// ══════════════════════════════════════════════════════════════════════════
// TOURS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/availability/:tourId
 */
controller.getAvailability = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const { startDate, endDate } = req.query;

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.supplierId || req.user.id },
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
 *
 * Writes a single-day override. The request vocabulary is `available` /
 * `maxBookings` / `note` (what the supplier form sends), but the table's
 * columns are `status` / `capacity` / `notes` — there has never been an
 * `available` column, so passing the payload straight through raised
 * PrismaClientValidationError and every write 500'd. Map explicitly.
 *
 * `status` is only touched when `available` is actually present, so a request
 * that only narrows the day limit cannot silently unblock a blocked date.
 *
 * The calendar is cached per tour/range (availabilityController), so the
 * invalidation has to happen here too or a block would not take effect until
 * the TTL elapsed.
 */
controller.setAvailability = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const { date, available, maxBookings, note, minParticipants } = req.body;

  // Dates are stored `@db.Date`. Anchoring to UTC midnight keeps the day
  // stable regardless of the server's timezone (the same normalization
  // availabilityController applies).
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ''));
  if (!parts) return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
  const parsedDate = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.supplierId || req.user.id },
    select: { id: true, schedulesAndPricing: true },
  });
  if (!tour) return next(new AppError('Tour not found', 404));

  const data = {};
  if (available !== undefined) {
    data.status = available === false || available === 'false' ? 'BLOCKED' : 'AVAILABLE';
  }
  if (maxBookings !== undefined) {
    const capacity = maxBookings === null || maxBookings === '' ? null : Number(maxBookings);
    if (capacity !== null && Number.isNaN(capacity)) {
      return next(new AppError('maxBookings must be a number', 400));
    }
    data.capacity = capacity;
  }
  if (note !== undefined) data.notes = note === null ? null : String(note);

  // Per-date party minimum. Accepting it here keeps the legacy supplier write
  // path from silently dropping the field and becoming a second source of
  // truth. null clears it (inherit the tour default).
  if (minParticipants !== undefined) {
    if (minParticipants === null || minParticipants === '') {
      data.minParticipants = null;
    } else {
      const n = Number(minParticipants);
      if (!Number.isInteger(n) || n < 1 || n > 100000) {
        return next(new AppError('minParticipants must be a positive integer or null', 400));
      }
      const parsed = parseBlob(tour.schedulesAndPricing) || {};
      if (isPerGroupTour(parsed)) {
        return next(new AppError(
          'Per-group tours set their party size with group size bands, not a per-date minimum.',
          400
        ));
      }
      const fallback = parseInt(await getConfig('booking.max_travelers', '50'), 10) || 50;
      // Use the day limit this request sets; when it doesn't touch capacity,
      // the date's existing limit is the real ceiling (mirrors the newer
      // availability controller).
      let ceilingCapacity;
      if (maxBookings !== undefined) {
        ceilingCapacity = data.capacity;
      } else {
        const existing = await prisma.tourDateOverride.findUnique({
          where: { tourId_date: { tourId, date: parsedDate } },
          select: { capacity: true },
        });
        ceilingCapacity = existing?.capacity ?? null;
      }
      const ceiling = ceilingCapacity != null ? Number(ceilingCapacity) : getEffectiveCapacity(parsed, fallback);
      if (n > ceiling) {
        return next(new AppError(
          `Cannot require ${n} travelers — this date can hold at most ${ceiling}. Raise the day limit first, or set a lower minimum.`,
          400
        ));
      }
      data.minParticipants = n;
    }
  }

  const override = await prisma.tourDateOverride.upsert({
    where: { tourId_date: { tourId, date: parsedDate } },
    update: data,
    create: { tourId, date: parsedDate, ...data },
  });

  await invalidateKeys([`availability:cal:${tourId}:*`]);

  res.json({ status: 'success', data: { override } });
});

// ══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/settings
 */
controller.getSettings = catchAsync(async (req, res) => {
  const supplier = await prisma.user.findUnique({
    where: { id: req.supplierId || req.user.id },
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
controller.updateSettings = catchAsync(async (req, res) => {
  const { businessName, description, phone, website, notificationPreferences, bookingRules } = req.body;

  const updates = [];

  if (businessName !== undefined || description !== undefined || phone !== undefined || website !== undefined) {
    const existing = await prisma.supplierProfile.findUnique({
      where: { userId: req.supplierId || req.user.id },
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
        where: { userId: req.supplierId || req.user.id },
        data: { businessInfo },
      }));
    }
  }

  if (notificationPreferences !== undefined || bookingRules !== undefined) {
    const existing = await prisma.user.findUnique({
      where: { id: req.supplierId || req.user.id },
      select: { notificationPreferences: true },
    });
    updates.push(prisma.user.update({
      where: { id: req.supplierId || req.user.id },
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
controller.getSpecialOffers = catchAsync(async (req, res) => {
  const supplierId = req.supplierId || req.user.id;

  const offers = await prisma.specialOffer.findMany({
    where: { supplierId },
    orderBy: { createdAt: 'desc' },
    include: {
      targets: {
        include: {
          tour: {
            select: {
              id: true, title: true, slug: true, coverPhoto: true, photos: true,
              category: true, schedulesAndPricing: true, status: true,
            },
          },
        },
      },
    },
  });

  // Match the shared controller: expose a computed status so the UI's
  // Active/Scheduled/Expired/Inactive filters and badges work. Delegates to the
  // shared service so the list badge and the detail/builder badge can never
  // drift apart.
  const now = new Date();
  const withStatus = offers.map((o) => ({ ...o, status: computeOfferStatus(o, now) }));

  res.json({ status: 'success', data: { offers: withStatus } });
});

// ══════════════════════════════════════════════════════════════════════════
// FINANCE
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/finance/summary
 */
controller.getFinanceSummary = catchAsync(async (req, res) => {
  const supplierId = req.supplierId || req.user.id;

  const [totalEarnings, pendingPayouts, completedPayouts] = await Promise.all([
    prisma.booking.aggregate({
      where: { tour: { supplierId }, isSimulated: false, paymentStatus: 'SUCCEEDED' },
      _sum: { grossAmount: true, platformCommission: true, supplierPayout: true },
    }),
    prisma.payout.aggregate({
      where: { booking: { tour: { supplierId }, isSimulated: false }, status: 'PENDING' },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payout.aggregate({
      where: { booking: { tour: { supplierId }, isSimulated: false }, status: 'PAID' },
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
controller.getPayouts = catchAsync(async (req, res) => {
  const supplierId = req.supplierId || req.user.id;
  const { page = 1, limit = 20, status } = req.query;
  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
  const take = Math.min(parseInt(limit), 50);

  const where = { supplierId };
  if (status) where.status = status;

  const [payouts, total, payoutAgg] = await Promise.all([
    prisma.payout.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        booking: {
          select: { id: true, bookingNumber: true, grossAmount: true, tour: { select: { id: true, title: true, coverPhoto: true } } },
        },
        payoutMethod: {
          select: { id: true, type: true, accountNumber: true, paypalEmail: true, mobileProvider: true, mobileNumber: true },
        },
      },
    }),
    prisma.payout.count({ where }),
    prisma.payout.aggregate({
      where: { supplierId },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  res.json({
    status: 'success',
    data: {
      payouts,
      summary: {
        totalEarned: parseFloat(payoutAgg._sum.amount || 0),
        totalPayouts: payoutAgg._count,
        currency: 'USD',
      },
      pagination: { currentPage: parseInt(page), totalPages: Math.ceil(total / take), totalCount: total, limit: take },
    },
  });
});

// ══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/supplier/notifications
 */
controller.getNotifications = catchAsync(async (req, res) => {
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


  return controller;
}

module.exports = makeSupplierController;
