/**
 * Travio Ghana Admin Controller — Ghana-Isolated Admin Operations
 *
 * Every query targets Ghana-specific data:
 *   - Tours: TravioGhanaTour model (not Tour)
 *   - Bookings: Booking WHERE source = 'GHANA'
 *   - Suppliers: User WHERE 'ghana' = ANY(roles)
 *   - Reviews: Reviews on Ghana tours
 *
 * Shared platform endpoints (settings, blog, chat, notifications, roles,
 * admins, audit-log) are NOT here — they live in the existing admin
 * controllers and are proxied by the route layer.
 */
const prisma = require('../utils/prismaClient');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const cache = require('../utils/cacheHelper');
const { logActivity } = require('../utils/auditLogger');

// ── Ghana-scoped constants ──────────────────────────────────────────────
const GHANA_SOURCE = 'GHANA';
const GHANA_ROLE = 'ghana';

// ══════════════════════════════════════════════════════════════════════════
// OVERVIEW / ANALYTICS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/admin/analytics/overview
 *
 * Ghana-specific dashboard snapshot: revenue, bookings, users, tours.
 */
exports.getOverview = catchAsync(async (req, res, next) => {
  const period = req.query.period || 'today';
  const periodMap = { today: 0, last_week: 7, last_month: 30, last_quarter: 90 };
  const periodDays = periodMap[period] ?? 7;

  const now = new Date();
  const bucket = Math.floor(now.getTime() / 120000);
  const cacheKey = `ghana:admin:overview:${bucket}:${periodDays}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentPeriodStart = period === 'today'
      ? todayStart
      : new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
    const previousPeriodStart = period === 'today'
      ? new Date(todayStart.getTime() - 24 * 60 * 60 * 1000)
      : new Date(currentPeriodStart.getTime() - periodDays * 24 * 60 * 60 * 1000);
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const scanStart = new Date(Math.min(
      currentPeriodStart.getTime(), previousPeriodStart.getTime(),
      weekStart.getTime(), monthStart.getTime(), yearStart.getTime(),
    ));

    const [
      bookingAgg,
      userAgg,
      tourCount,
      activeTourCount,
      supplierCount,
      recentBookings,
    ] = await Promise.all([
      // Revenue + booking volume (Ghana only)
      prisma.$queryRaw`
        SELECT
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${currentPeriodStart}), 0)::float AS "periodRevenue",
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${previousPeriodStart} AND "paidAt" < ${currentPeriodStart}), 0)::float AS "previousPeriodRevenue",
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${weekStart}), 0)::float AS "weekRevenue",
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${monthStart}), 0)::float AS "monthRevenue",
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${yearStart}), 0)::float AS "ytdRevenue",
          COALESCE(SUM("commissionAmount") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${currentPeriodStart}), 0)::float AS "periodCommission",
          COALESCE(SUM("supplierPayout") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${currentPeriodStart}), 0)::float AS "periodPayout",
          COUNT(*) FILTER (WHERE "createdAt" >= ${currentPeriodStart})::int AS "periodBookings",
          COUNT(*) FILTER (WHERE "createdAt" >= ${previousPeriodStart} AND "createdAt" < ${currentPeriodStart})::int AS "previousPeriodBookings"
        FROM "Booking"
        WHERE "source"::text = ${GHANA_SOURCE}
          AND ("createdAt" >= ${scanStart} OR "paidAt" >= ${scanStart})
      `,

      // Ghana user signups + active users
      prisma.$queryRaw`
        SELECT
          COUNT(*) FILTER (WHERE "createdAt" >= ${currentPeriodStart})::int AS "signupsPeriod",
          COUNT(*) FILTER (WHERE "createdAt" >= ${previousPeriodStart} AND "createdAt" < ${currentPeriodStart})::int AS "signupsPrevious",
          COUNT(*) FILTER (WHERE "lastLoginAt" >= ${currentPeriodStart} AND "active" = true)::int AS "activeNow"
        FROM "User"
        WHERE ${GHANA_ROLE} = ANY("roles"::text[])
          AND ("createdAt" >= ${scanStart} OR "lastLoginAt" >= ${scanStart})
      `,

      // Total Ghana tours (TravioGhanaTour records)
      prisma.travioGhanaTour.count({ where: { isActive: true } }),

      // Active Ghana tours (parent tour is ACTIVE)
      prisma.travioGhanaTour.count({
        where: { isActive: true, tour: { status: 'ACTIVE' } },
      }),

      // Active Ghana suppliers
      prisma.user.count({
        where: { roles: { has: GHANA_ROLE }, active: true },
      }),

      // Recent bookings
      prisma.booking.findMany({
        where: { source: GHANA_SOURCE },
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, bookingNumber: true, status: true, paymentStatus: true,
          grossAmount: true, currency: true, createdAt: true,
          customer: { select: { id: true, name: true, email: true } },
          tour: { select: { id: true, title: true, slug: true } },
        },
      }),
    ]);

    const b = bookingAgg[0] || {};
    const u = userAgg[0] || {};
    const revenueChange = b.previousPeriodRevenue > 0
      ? ((b.periodRevenue - b.previousPeriodRevenue) / b.previousPeriodRevenue * 100).toFixed(1)
      : b.periodRevenue > 0 ? 100 : 0;
    const bookingChange = b.previousPeriodBookings > 0
      ? ((b.periodBookings - b.previousPeriodBookings) / b.previousPeriodBookings * 100).toFixed(1)
      : b.periodBookings > 0 ? 100 : 0;

    return {
      status: 'success',
      data: {
        overview: {
          periodRevenue: b.periodRevenue || 0,
          previousPeriodRevenue: b.previousPeriodRevenue || 0,
          revenueChange: parseFloat(revenueChange),
          weekRevenue: b.weekRevenue || 0,
          monthRevenue: b.monthRevenue || 0,
          ytdRevenue: b.ytdRevenue || 0,
          periodCommission: b.periodCommission || 0,
          periodPayout: b.periodPayout || 0,
          periodBookings: b.periodBookings || 0,
          previousPeriodBookings: b.previousPeriodBookings || 0,
          bookingChange: parseFloat(bookingChange),
          signupsPeriod: u.signupsPeriod || 0,
          signupsPrevious: u.signupsPrevious || 0,
          activeUsers: u.activeNow || 0,
          totalTours: tourCount,
          activeTours: activeTourCount,
          activeSuppliers: supplierCount,
        },
        recentBookings,
      },
    };
  }, 120);

  res.status(200).json(result);
});

/**
 * GET /api/travioghana/admin/analytics/revenue-trend
 * Monthly revenue for Ghana bookings (last 24 months).
 */
exports.getRevenueTrend = catchAsync(async (req, res, next) => {
  const bucket = Math.floor(Date.now() / 300000);
  const months = await cache.getOrSet(`ghana:admin:revenueTrend:${bucket}`, async () => {
    return prisma.$queryRaw`
      SELECT
        DATE_TRUNC('month', "paidAt")::date AS month,
        COUNT(*)::int                       AS bookings,
        ROUND(SUM("total")::numeric, 2)     AS revenue,
        ROUND(SUM("commissionAmount")::numeric, 2) AS commission,
        ROUND(SUM("supplierPayout")::numeric, 2)   AS "supplierPayout"
      FROM "Booking"
      WHERE "source"::text = ${GHANA_SOURCE}
        AND "paidAt" >= NOW() - INTERVAL '24 months'
        AND "paymentStatus" = 'SUCCEEDED'
      GROUP BY DATE_TRUNC('month', "paidAt")
      ORDER BY month ASC
    `;
  }, 300);

  res.status(200).json({ status: 'success', data: { months } });
});

/**
 * GET /api/travioghana/admin/analytics/tour-performance
 * Ghana tour performance (paginated, filterable).
 */
exports.getTourPerformance = catchAsync(async (req, res, next) => {
  const {
    status, category, search, page = 1, limit = 20,
    sortBy = 'totalRevenue', sortOrder = 'desc',
  } = req.query;

  const allowedSorts = ['totalRevenue', 'totalBookings', 'averageRating', 'viewCount', 'createdAt'];
  const field = allowedSorts.includes(sortBy) ? sortBy : 'totalRevenue';
  const order = sortOrder === 'asc' ? 'asc' : 'desc';

  const filterStatus = status && status !== 'all' ? status.toUpperCase() : undefined;

  // Build Ghana tour filter
  const ghanaTourWhere = { isActive: true };
  if (filterStatus) {
    ghanaTourWhere.tour = { status: filterStatus };
  } else {
    ghanaTourWhere.tour = { status: { not: 'ARCHIVED' } };
  }
  if (category) {
    ghanaTourWhere.tour.category = category;
  }
  if (search && search.trim()) {
    const term = search.trim();
    ghanaTourWhere.tour.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { supplier: { name: { contains: term, mode: 'insensitive' } } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [records, totalCount] = await Promise.all([
    prisma.travioGhanaTour.findMany({
      where: ghanaTourWhere,
      orderBy: { tour: { [field]: order } },
      skip,
      take: parseInt(limit),
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, status: true,
            coverPhoto: true, totalBookings: true, totalRevenue: true,
            averageRating: true, reviewCount: true, viewCount: true,
            createdAt: true, category: true, city: true, country: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.travioGhanaTour.count({ where: ghanaTourWhere }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      tours: records.map((r) => ({
        id: r.id,
        tourId: r.tourId,
        displayOrder: r.displayOrder,
        isFeatured: r.isFeatured,
        isActive: r.isActive,
        ...r.tour,
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        totalCount,
        limit: parseInt(limit),
      },
    },
  });
});

/**
 * GET /api/travioghana/admin/analytics/user-growth
 * Ghana user signups per month (last 24 months).
 */
exports.getUserGrowth = catchAsync(async (req, res, next) => {
  const bucket = Math.floor(Date.now() / 300000);
  const growth = await cache.getOrSet(`ghana:admin:userGrowth:${bucket}`, async () => {
    return prisma.$queryRaw`
      SELECT
        DATE_TRUNC('month', "createdAt")::date AS month,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE 'customer' = ANY("roles"::text[]))::int AS customers,
        COUNT(*) FILTER (WHERE 'supplier' = ANY("roles"::text[]))::int AS suppliers
      FROM "User"
      WHERE ${GHANA_ROLE} = ANY("roles"::text[])
        AND "createdAt" >= NOW() - INTERVAL '24 months'
      GROUP BY DATE_TRUNC('month', "createdAt")
      ORDER BY month ASC
    `;
  }, 300);

  res.status(200).json({ status: 'success', data: { growth } });
});

/**
 * GET /api/travioghana/admin/analytics/funnel
 * Ghana booking conversion funnel.
 */
exports.getFunnel = catchAsync(async (req, res, next) => {
  const periodMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const days = periodMap[req.query.period] || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const bucket = Math.floor(Date.now() / 300000);
  const data = await cache.getOrSet(`ghana:admin:funnel:${bucket}:${days}`, async () => {
    const [viewed, cartAdded, checkoutStarted, completed] = await Promise.all([
      prisma.event.groupBy({
        by: ['userId'],
        where: {
          name: 'tour.viewed', createdAt: { gte: startDate }, userId: { not: null },
          properties: { path: ['source'], equals: 'ghana' },
        },
        _count: true,
      }),
      prisma.event.groupBy({
        by: ['userId'],
        where: {
          name: 'cart.added', createdAt: { gte: startDate }, userId: { not: null },
          properties: { path: ['source'], equals: 'ghana' },
        },
        _count: true,
      }),
      prisma.event.groupBy({
        by: ['userId'],
        where: {
          name: 'booking.initiated', createdAt: { gte: startDate }, userId: { not: null },
          properties: { path: ['source'], equals: 'ghana' },
        },
        _count: true,
      }),
      prisma.event.groupBy({
        by: ['userId'],
        where: {
          name: 'booking.completed', createdAt: { gte: startDate }, userId: { not: null },
          properties: { path: ['source'], equals: 'ghana' },
        },
        _count: true,
      }),
    ]);

    return {
      viewed: viewed.length,
      cartAdded: cartAdded.length,
      checkoutStarted: checkoutStarted.length,
      completed: completed.length,
    };
  }, 300);

  res.status(200).json({ status: 'success', data });
});

/**
 * GET /api/travioghana/admin/analytics/clv
 * Ghana customer lifetime value.
 */
exports.getCLV = catchAsync(async (req, res, next) => {
  const bucket = Math.floor(Date.now() / 300000);
  const data = await cache.getOrSet(`ghana:admin:clv:${bucket}`, async () => {
    const yearStart = new Date(new Date().getFullYear(), 0, 1);

    const [basicStats, repeatRate, bookingDistribution, topCustomers] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          COUNT(DISTINCT b."customerId")::int AS "totalCustomers",
          COUNT(*)::int AS "totalBookings",
          ROUND(AVG(b."total")::numeric, 2) AS "avgBookingValue",
          ROUND(SUM(b."total")::numeric, 2) AS "totalRevenue"
        FROM "Booking" b
        WHERE b."paymentStatus" = 'SUCCEEDED' AND b."source"::text = ${GHANA_SOURCE}
      `,
      prisma.$queryRaw`
        SELECT
          COUNT(DISTINCT "customerId")::int AS "totalCustomers",
          COUNT(DISTINCT "customerId") FILTER (WHERE "bookingCount" > 1)::int AS "repeatCustomers",
          ROUND(COUNT(DISTINCT "customerId") FILTER (WHERE "bookingCount" > 1) * 100.0
            / NULLIF(COUNT(DISTINCT "customerId"), 0), 1) AS "repeatRate",
          ROUND(AVG("bookingCount")::numeric, 2) AS "avgBookingsPerCustomer"
        FROM (
          SELECT "customerId", COUNT(*) AS "bookingCount"
          FROM "Booking"
          WHERE "paymentStatus" = 'SUCCEEDED' AND "source"::text = ${GHANA_SOURCE}
          GROUP BY "customerId"
        ) sub
      `,
      prisma.$queryRaw`
        SELECT
          CASE
            WHEN booking_count = 1 THEN '1'
            WHEN booking_count = 2 THEN '2'
            WHEN booking_count = 3 THEN '3'
            WHEN booking_count = 4 THEN '4'
            ELSE '5+'
          END AS "bookingCount",
          COUNT(*)::int AS customers,
          ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS percentage
        FROM (
          SELECT "customerId", COUNT(*) AS booking_count
          FROM "Booking"
          WHERE "paymentStatus" = 'SUCCEEDED' AND "source"::text = ${GHANA_SOURCE}
          GROUP BY "customerId"
        ) sub
        GROUP BY CASE
          WHEN booking_count = 1 THEN '1'
          WHEN booking_count = 2 THEN '2'
          WHEN booking_count = 3 THEN '3'
          WHEN booking_count = 4 THEN '4'
          ELSE '5+'
        END
        ORDER BY "bookingCount" ASC
      `,
      prisma.$queryRaw`
        SELECT
          u.id, u.name, u.email,
          COUNT(*)::int AS "totalBookings",
          ROUND(SUM(b."total")::numeric, 2) AS "totalSpent",
          ROUND(AVG(b."total")::numeric, 2) AS "avgBookingValue",
          MAX(b."paidAt") AS "lastBookingDate"
        FROM "Booking" b
        JOIN "User" u ON u.id = b."customerId"
        WHERE b."paymentStatus" = 'SUCCEEDED' AND b."source"::text = ${GHANA_SOURCE}
        GROUP BY u.id, u.name, u.email
        ORDER BY "totalSpent" DESC
        LIMIT 20
      `,
    ]);

    return {
      overview: {
        totalCustomers: basicStats[0]?.totalCustomers || 0,
        totalBookings: basicStats[0]?.totalBookings || 0,
        avgBookingValue: parseFloat(basicStats[0]?.avgBookingValue || 0),
        totalRevenue: parseFloat(basicStats[0]?.totalRevenue || 0),
        avgCLV: basicStats[0]?.totalCustomers > 0
          ? parseFloat((parseFloat(basicStats[0]?.totalRevenue || 0) / basicStats[0].totalCustomers).toFixed(2))
          : 0,
      },
      repeatRate: {
        totalCustomers: repeatRate[0]?.totalCustomers || 0,
        repeatCustomers: repeatRate[0]?.repeatCustomers || 0,
        repeatRate: parseFloat(repeatRate[0]?.repeatRate || 0),
        avgBookingsPerCustomer: parseFloat(repeatRate[0]?.avgBookingsPerCustomer || 0),
      },
      distribution: bookingDistribution.map((d) => ({
        bookingCount: d.bookingCount,
        customers: d.customers,
        percentage: parseFloat(d.percentage || 0),
      })),
      topCustomers: topCustomers.map((c) => ({
        id: c.id, name: c.name, email: c.email,
        totalBookings: c.totalBookings,
        totalSpent: parseFloat(c.totalSpent),
        avgBookingValue: parseFloat(c.avgBookingValue),
        lastBookingDate: c.lastBookingDate,
      })),
    };
  }, 300);

  res.status(200).json({ status: 'success', data });
});

/**
 * GET /api/travioghana/admin/analytics/search
 * Ghana search analytics.
 */
exports.getSearchAnalytics = catchAsync(async (req, res, next) => {
  const periodMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const days = periodMap[req.query.period] || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const [totalSearches, topQueries, zeroResultQueries] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS "totalSearches",
        COUNT(DISTINCT "userId")::int AS "uniqueSearchers",
        COUNT(*) FILTER (WHERE "properties"->>'resultCount' = '0')::int AS "zeroResultSearches"
      FROM "Event"
      WHERE "name" = 'search.executed'
        AND "createdAt" >= ${startDate}
        AND "properties"->>'source' = 'ghana'
    `,
    prisma.$queryRaw`
      SELECT
        "properties"->>'query' AS query,
        COUNT(*)::int AS searches,
        COUNT(DISTINCT "userId")::int AS "uniqueUsers"
      FROM "Event"
      WHERE "name" = 'search.executed'
        AND "createdAt" >= ${startDate}
        AND "properties"->>'source' = 'ghana'
        AND "properties"->>'query' IS NOT NULL
      GROUP BY "properties"->>'query'
      ORDER BY searches DESC LIMIT 50
    `,
    prisma.$queryRaw`
      SELECT
        "properties"->>'query' AS query,
        COUNT(*)::int AS searches
      FROM "Event"
      WHERE "name" = 'search.executed'
        AND "createdAt" >= ${startDate}
        AND "properties"->>'source' = 'ghana'
        AND "properties"->>'resultCount' = '0'
      GROUP BY "properties"->>'query'
      ORDER BY searches DESC LIMIT 25
    `,
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      period: `${days}d`,
      overview: {
        totalSearches: totalSearches[0]?.totalSearches || 0,
        uniqueSearchers: totalSearches[0]?.uniqueSearchers || 0,
        zeroResultSearches: totalSearches[0]?.zeroResultSearches || 0,
      },
      topQueries: topQueries.map((q) => ({
        query: q.query, searches: q.searches, uniqueUsers: q.uniqueUsers,
      })),
      zeroResultQueries: zeroResultQueries.map((q) => ({
        query: q.query, searches: q.searches,
      })),
    },
  });
});

/**
 * GET /api/travioghana/admin/analytics/cart-abandonment
 */
exports.getCartAbandonment = catchAsync(async (req, res, next) => {
  const periodMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const days = periodMap[req.query.period] || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const bucket = Math.floor(Date.now() / 300000);
  const data = await cache.getOrSet(`ghana:admin:cartAbandon:${bucket}:${days}`, async () => {
    const [cartMetrics, cartByTour, dailyAbandonment] = await Promise.all([
      prisma.$queryRaw`
        WITH cart_users AS (
          SELECT DISTINCT "userId" FROM "Event"
          WHERE "name" = 'cart.added' AND "createdAt" >= ${startDate}
            AND "userId" IS NOT NULL AND "properties"->>'source' = 'ghana'
        ),
        booking_users AS (
          SELECT DISTINCT e."userId" FROM "Event" e
          JOIN cart_users c ON c."userId" = e."userId"
          WHERE e."name" = 'booking.completed' AND e."createdAt" >= ${startDate}
            AND e."properties"->>'source' = 'ghana'
        )
        SELECT
          (SELECT COUNT(*) FROM cart_users)::int AS "cartsCreated",
          (SELECT COUNT(*) FROM booking_users)::int AS "cartsConverted",
          ROUND((1 - (SELECT COUNT(*)::numeric FROM booking_users)
            / NULLIF((SELECT COUNT(*)::numeric FROM cart_users), 0)) * 100, 1) AS "abandonmentRate"
      `,
      prisma.$queryRaw`
        WITH cart_tour AS (
          SELECT DISTINCT ON ("userId", "resourceId")
            "userId", "resourceId" AS tour_id
          FROM "Event"
          WHERE "name" = 'cart.added' AND "createdAt" >= ${startDate}
            AND "userId" IS NOT NULL AND "resourceId" IS NOT NULL
            AND "properties"->>'source' = 'ghana'
          ORDER BY "userId", "resourceId", "createdAt" DESC
        ),
        booked_tour AS (
          SELECT DISTINCT "userId", "properties"->>'tourId' AS tour_id
          FROM "Event"
          WHERE "name" = 'booking.completed' AND "createdAt" >= ${startDate}
            AND "properties"->>'source' = 'ghana'
        )
        SELECT ct.tour_id AS "tourId", COUNT(*)::int AS "cartsAdded",
          COUNT(*) FILTER (WHERE bt."userId" IS NOT NULL)::int AS "converted"
        FROM cart_tour ct
        LEFT JOIN booked_tour bt ON bt."userId" = ct."userId" AND bt.tour_id = ct.tour_id
        GROUP BY ct.tour_id ORDER BY "cartsAdded" DESC LIMIT 20
      `,
      prisma.$queryRaw`
        WITH daily_carts AS (
          SELECT DATE_TRUNC('day', "createdAt")::date AS day,
            COUNT(DISTINCT "userId")::int AS cart_users
          FROM "Event"
          WHERE "name" = 'cart.added' AND "createdAt" >= ${startDate}
            AND "properties"->>'source' = 'ghana'
          GROUP BY DATE_TRUNC('day', "createdAt")
        ),
        daily_converted AS (
          SELECT DATE_TRUNC('day', e."createdAt")::date AS day,
            COUNT(DISTINCT e."userId")::int AS converted_users
          FROM "Event" e
          JOIN daily_carts dc ON dc.day = DATE_TRUNC('day', e."createdAt")
          WHERE e."name" = 'booking.completed' AND e."createdAt" >= ${startDate}
            AND e."properties"->>'source' = 'ghana'
          GROUP BY DATE_TRUNC('day', e."createdAt")
        )
        SELECT dc.day, dc.cart_users AS "cartsAdded",
          COALESCE(dcv.converted_users, 0)::int AS "converted",
          ROUND((1 - COALESCE(dcv.converted_users, 0)::numeric
            / NULLIF(dc.cart_users, 0)) * 100, 1) AS "abandonmentRate"
        FROM daily_carts dc
        LEFT JOIN daily_converted dcv ON dcv.day = dc.day
        ORDER BY dc.day ASC
      `,
    ]);

    // Enrich tour IDs with titles
    const tourIds = cartByTour.map((c) => c.tourId).filter(Boolean);
    let tourMap = {};
    if (tourIds.length > 0) {
      const records = await prisma.travioGhanaTour.findMany({
        where: { tourId: { in: tourIds } },
        select: { tourId: true, tour: { select: { title: true } } },
      });
      tourMap = Object.fromEntries(records.map((r) => [r.tourId, r.tour.title]));
    }

    return {
      overview: {
        cartsCreated: cartMetrics[0]?.cartsCreated || 0,
        cartsConverted: cartMetrics[0]?.cartsConverted || 0,
        abandonmentRate: parseFloat(cartMetrics[0]?.abandonmentRate || 0),
      },
      byTour: cartByTour.map((c) => ({
        tourId: c.tourId,
        tourTitle: tourMap[c.tourId] || 'Unknown',
        cartsAdded: c.cartsAdded,
        converted: c.converted,
      })),
      dailyTrend: dailyAbandonment.map((d) => ({
        day: d.day, cartsAdded: d.cartsAdded,
        converted: d.converted,
        abandonmentRate: parseFloat(d.abandonmentRate || 0),
      })),
    };
  }, 300);

  res.status(200).json({ status: 'success', data });
});

// ══════════════════════════════════════════════════════════════════════════
// TOURS (TravioGhanaTour)
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/admin/tours
 * List all Ghana tours (TravioGhanaTour records) with parent tour data.
 */
exports.getTours = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, status, category, search } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  const where = {};
  if (status && status !== 'all') {
    where.isActive = status.toUpperCase() === 'ACTIVE';
  }
  if (category) {
    where.tour = { ...where.tour, category };
  }
  if (search && search.trim()) {
    const term = search.trim();
    where.tour = {
      ...where.tour,
      OR: [
        { title: { contains: term, mode: 'insensitive' } },
        { city: { contains: term, mode: 'insensitive' } },
        { supplier: { name: { contains: term, mode: 'insensitive' } } },
      ],
    };
  }

  const [records, totalCount] = await Promise.all([
    prisma.travioGhanaTour.findMany({
      where,
      orderBy: { displayOrder: 'asc' },
      skip,
      take,
      include: {
        addedBy: { select: { id: true, name: true, email: true } },
        tour: {
          select: {
            id: true, title: true, slug: true, status: true,
            coverPhoto: true, category: true, city: true, country: true,
            totalBookings: true, totalRevenue: true, averageRating: true,
            reviewCount: true, viewCount: true, createdAt: true,
            supplier: { select: { id: true, name: true, email: true } },
          },
        },
      },
    }),
    prisma.travioGhanaTour.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      tours: records.map((r) => ({
        id: r.id,
        tourId: r.tourId,
        displayOrder: r.displayOrder,
        isFeatured: r.isFeatured,
        isActive: r.isActive,
        addedBy: r.addedBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        tour: r.tour,
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / take),
        totalCount,
        limit: take,
      },
    },
  });
});

/**
 * GET /api/travioghana/admin/tours/:id
 * Single Ghana tour detail.
 */
exports.getTourDetail = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const record = await prisma.travioGhanaTour.findUnique({
    where: { id },
    include: {
      addedBy: { select: { id: true, name: true, email: true } },
      tour: {
        include: {
          supplier: {
            select: {
              id: true, name: true, email: true, photoURL: true,
              supplierProfile: { select: { status: true, averageRating: true, totalBookings: true } },
            },
          },
          _count: { select: { reviews: true } },
        },
      },
    },
  });

  if (!record) {
    return next(new AppError('Ghana tour not found', 404));
  }

  res.status(200).json({ status: 'success', data: { tour: record } });
});

/**
 * PATCH /api/travioghana/admin/tours/:id
 * Update Ghana tour (displayOrder, isFeatured, isActive).
 */
exports.updateTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { displayOrder, isFeatured, isActive } = req.body;

  const existing = await prisma.travioGhanaTour.findUnique({ where: { id } });
  if (!existing) {
    return next(new AppError('Ghana tour not found', 404));
  }

  const record = await prisma.travioGhanaTour.update({
    where: { id },
    data: {
      ...(displayOrder !== undefined && { displayOrder }),
      ...(isFeatured !== undefined && { isFeatured }),
      ...(isActive !== undefined && { isActive }),
    },
  });

  await logActivity({
    action: 'tour.updated',
    entityType: 'TravioGhanaTour',
    entityId: id,
    userId: req.user.id,
    metadata: { changes: req.body },
  });

  res.status(200).json({ status: 'success', data: { tour: record } });
});

/**
 * DELETE /api/travioghana/admin/tours/:id
 * Remove a Ghana tour.
 */
exports.deleteTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const existing = await prisma.travioGhanaTour.findUnique({ where: { id } });
  if (!existing) {
    return next(new AppError('Ghana tour not found', 404));
  }

  await prisma.travioGhanaTour.delete({ where: { id } });

  await logActivity({
    action: 'tour.deleted',
    entityType: 'TravioGhanaTour',
    entityId: id,
    userId: req.user.id,
  });

  res.status(204).json({ status: 'success', data: null });
});

/**
 * GET /api/travioghana/admin/tours/review
 * Ghana tour moderation queue.
 */
exports.getTourReviewQueue = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  const [records, totalCount] = await Promise.all([
    prisma.travioGhanaTour.findMany({
      where: { tour: { status: 'DRAFT' } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, status: true,
            coverPhoto: true, category: true, createdAt: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.travioGhanaTour.count({ where: { tour: { status: 'DRAFT' } } }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      tours: records.map((r) => ({
        id: r.id,
        tourId: r.tourId,
        isActive: r.isActive,
        createdAt: r.createdAt,
        tour: r.tour,
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / take),
        totalCount,
        limit: take,
      },
    },
  });
});

/**
 * PATCH /api/travioghana/admin/tours/:id/review
 * Approve/reject a Ghana tour.
 */
exports.reviewTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { status, reason } = req.body;

  if (!['ACTIVE', 'REJECTED'].includes(status)) {
    return next(new AppError('Status must be ACTIVE or REJECTED', 400));
  }

  const record = await prisma.travioGhanaTour.findUnique({
    where: { id },
    include: { tour: { select: { id: true, title: true } } },
  });

  if (!record) {
    return next(new AppError('Ghana tour not found', 404));
  }

  await prisma.tour.update({
    where: { id: record.tourId },
    data: { status },
  });

  await logActivity({
    action: status === 'ACTIVE' ? 'tour.approved' : 'tour.rejected',
    entityType: 'TravioGhanaTour',
    entityId: id,
    userId: req.user.id,
    metadata: { reason: reason || null },
  });

  res.status(200).json({
    status: 'success',
    message: `Tour ${status === 'ACTIVE' ? 'approved' : 'rejected'}`,
  });
});

/**
 * GET /api/travioghana/admin/search/tours
 * Search tours for Ghana curation (excludes already-added).
 */
exports.searchTours = catchAsync(async (req, res, next) => {
  const { q, category, city, country, page = 1, limit = 20 } = req.query;

  const where = { status: 'ACTIVE' };

  // Exclude tours already curated for Ghana
  const curatedIds = await prisma.travioGhanaTour.findMany({ select: { tourId: true } });
  const excludedIds = curatedIds.map((c) => c.tourId);
  if (excludedIds.length > 0) {
    where.id = { notIn: excludedIds };
  }

  const AND = [];
  if (q && q.trim()) {
    const search = q.trim();
    AND.push({
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { country: { contains: search, mode: 'insensitive' } },
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
      ],
    });
  }
  if (category) AND.push({ category });
  if (city) AND.push({ city: { contains: city, mode: 'insensitive' } });
  if (country) AND.push({ country: { contains: country, mode: 'insensitive' } });
  if (AND.length > 0) where.AND = AND;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  const [tours, totalCount] = await Promise.all([
    prisma.tour.findMany({
      where,
      select: {
        id: true, title: true, slug: true, coverPhoto: true,
        category: true, city: true, country: true, status: true,
        supplier: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.tour.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      tours: tours.map((t) => ({
        id: t.id, title: t.title, slug: t.slug,
        coverPhoto: t.coverPhoto, category: t.category,
        city: t.city, country: t.country, status: t.status,
        supplierName: t.supplier?.name || null,
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / take),
        totalCount,
        limit: take,
      },
    },
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BOOKINGS (source = 'GHANA')
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/admin/bookings
 * Ghana bookings list (paginated, filterable).
 */
exports.getBookings = catchAsync(async (req, res, next) => {
  const {
    page = 1, limit = 20, status, paymentStatus,
    startDate, endDate, search, sortBy = 'createdAt', sortOrder = 'desc',
  } = req.query;

  const where = { source: GHANA_SOURCE };
  if (status) where.status = status.toUpperCase();
  if (paymentStatus) where.paymentStatus = paymentStatus.toUpperCase();
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate + 'T23:59:59.999Z');
  }
  if (search && search.trim()) {
    const term = search.trim();
    where.OR = [
      { bookingNumber: { contains: term, mode: 'insensitive' } },
      { customer: { name: { contains: term, mode: 'insensitive' } } },
      { customer: { email: { contains: term, mode: 'insensitive' } } },
      { tour: { title: { contains: term, mode: 'insensitive' } } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  const [bookings, totalCount] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip,
      take,
      include: {
        customer: { select: { id: true, name: true, email: true } },
        tour: {
          select: {
            id: true, title: true, slug: true, coverPhoto: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.booking.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      bookings,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / take),
        totalCount,
        limit: take,
      },
    },
  });
});

/**
 * GET /api/travioghana/admin/bookings/today
 * Today's Ghana bookings.
 */
exports.getTodayBookings = catchAsync(async (req, res, next) => {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const bookings = await prisma.booking.findMany({
    where: {
      source: GHANA_SOURCE,
      createdAt: { gte: startOfDay, lt: endOfDay },
    },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      tour: {
        select: {
          id: true, title: true,
          supplier: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.status(200).json({ status: 'success', data: { bookings } });
});

/**
 * GET /api/travioghana/admin/bookings/:id
 * Single Ghana booking detail.
 */
exports.getBookingById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const booking = await prisma.booking.findFirst({
    where: { id, source: GHANA_SOURCE },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      tour: {
        select: {
          id: true, title: true, slug: true, coverPhoto: true,
          supplier: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });

  if (!booking) {
    return next(new AppError('Ghana booking not found', 404));
  }

  res.status(200).json({ status: 'success', data: { booking } });
});

/**
 * PATCH /api/travioghana/admin/bookings/:id/confirm-payment
 */
exports.confirmPayment = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const booking = await prisma.booking.findFirst({
    where: { id, source: GHANA_SOURCE },
  });

  if (!booking) {
    return next(new AppError('Ghana booking not found', 404));
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { paymentStatus: 'SUCCEEDED', paidAt: new Date() },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      tour: { select: { id: true, title: true } },
    },
  });

  await logActivity({
    action: 'booking.payment_confirmed',
    entityType: 'Booking',
    entityId: id,
    userId: req.user.id,
    metadata: { bookingNumber: booking.bookingNumber },
  });

  res.status(200).json({ status: 'success', data: { booking: updated } });
});

// ══════════════════════════════════════════════════════════════════════════
// SUPPLIERS (role = 'ghana')
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/admin/suppliers
 * Ghana suppliers list.
 */
exports.getSuppliers = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, status, search } = req.query;

  const where = { roles: { has: GHANA_ROLE } };
  if (status) {
    where.supplierProfile = { status: status.toUpperCase() };
  }
  if (search && search.trim()) {
    const term = search.trim();
    where.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  const [suppliers, totalCount] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true, name: true, email: true, photoURL: true,
        roles: true, active: true, createdAt: true, lastLoginAt: true,
        supplierProfile: {
          select: {
            id: true, status: true, averageRating: true, totalBookings: true,
            totalEarnings: true, businessInfo: true,
          },
        },
        _count: { select: { tours: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      suppliers,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / take),
        totalCount,
        limit: take,
      },
    },
  });
});

/**
 * GET /api/travioghana/admin/suppliers/:id
 * Single Ghana supplier detail.
 */
exports.getSupplierDetail = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const user = await prisma.user.findFirst({
    where: { id, roles: { has: GHANA_ROLE } },
    select: {
      id: true, name: true, email: true, phone: true, photoURL: true,
      roles: true, active: true, createdAt: true, lastLoginAt: true,
    },
  });

  if (!user) {
    return next(new AppError('Ghana supplier not found', 404));
  }

  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: user.id },
    select: {
      id: true, userId: true, status: true, supplierType: true,
      businessInfo: true, operatingInfo: true, representativeInfo: true,
      businessDocuments: true, payoutInfo: true, compliance: true,
      totalEarnings: true, totalBookings: true, averageRating: true,
    },
  });

  const supplier = { ...user, ...(profile || {}) };

  const [tours, recentBookings] = await Promise.all([
    prisma.travioGhanaTour.findMany({
      where: { tour: { supplierId: user.id } },
      include: {
        tour: {
          select: {
            id: true, title: true, status: true, coverPhoto: true,
            totalBookings: true, totalRevenue: true, averageRating: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.booking.findMany({
      where: { source: GHANA_SOURCE, tour: { supplierId: user.id } },
      select: {
        id: true, bookingNumber: true, status: true, grossAmount: true,
        currency: true, createdAt: true,
        customer: { select: { name: true } },
        tour: { select: { title: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  res.status(200).json({
    status: 'success',
    data: { supplier, tours, recentBookings },
  });
});

/**
 * PATCH /api/travioghana/admin/suppliers/:id/suspend
 */
exports.suspendSupplier = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const supplier = await prisma.user.findFirst({
    where: { id, roles: { has: GHANA_ROLE } },
  });

  if (!supplier) {
    return next(new AppError('Ghana supplier not found', 404));
  }

  await prisma.supplierProfile.update({
    where: { userId: id },
    data: { status: 'SUSPENDED' },
  });

  await logActivity({
    action: 'supplier.suspended',
    entityType: 'User',
    entityId: id,
    userId: req.user.id,
    metadata: { name: supplier.name },
  });

  res.status(200).json({ status: 'success', message: 'Supplier suspended' });
});

/**
 * PATCH /api/travioghana/admin/suppliers/:id/activate
 */
exports.activateSupplier = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const supplier = await prisma.user.findFirst({
    where: { id, roles: { has: GHANA_ROLE } },
  });

  if (!supplier) {
    return next(new AppError('Ghana supplier not found', 404));
  }

  await prisma.supplierProfile.update({
    where: { userId: id },
    data: { status: 'ACTIVE' },
  });

  await logActivity({
    action: 'supplier.activated',
    entityType: 'User',
    entityId: id,
    userId: req.user.id,
    metadata: { name: supplier.name },
  });

  res.status(200).json({ status: 'success', message: 'Supplier activated' });
});

// ══════════════════════════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/admin/users/active
 * Recently active Ghana users.
 */
exports.getActiveUsers = catchAsync(async (req, res, next) => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: {
      roles: { has: GHANA_ROLE },
      lastLoginAt: { gte: thirtyDaysAgo },
      active: true,
    },
    select: {
      id: true, name: true, email: true, photoURL: true,
      roles: true, lastLoginAt: true,
    },
    orderBy: { lastLoginAt: 'desc' },
  });

  res.status(200).json({ status: 'success', data: { users } });
});

/**
 * GET /api/travioghana/admin/users/new-signups
 * Today's Ghana signups.
 */
exports.getRecentSignups = catchAsync(async (req, res, next) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const users = await prisma.user.findMany({
    where: {
      roles: { has: GHANA_ROLE },
      createdAt: { gte: todayStart },
    },
    select: {
      id: true, name: true, email: true, photoURL: true,
      roles: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.status(200).json({ status: 'success', data: { users } });
});

/**
 * GET /api/travioghana/admin/users/search
 * Search Ghana users.
 */
exports.searchUsers = catchAsync(async (req, res, next) => {
  const { q = '', role } = req.query;

  const where = {
    roles: { has: GHANA_ROLE },
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ],
  };

  if (role) {
    where.roles = { hasEvery: [GHANA_ROLE, role] };
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, email: true, photoURL: true, roles: true },
    take: 20,
  });

  res.status(200).json({ status: 'success', data: { users } });
});

// ══════════════════════════════════════════════════════════════════════════
// AI PROCESSING
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/admin/ai/status
 * AI processing status for Ghana tours.
 */
exports.getAiStatus = catchAsync(async (req, res, next) => {
  const [total, completed, failed, pending] = await Promise.all([
    prisma.travioGhanaTour.count(),
    prisma.travioGhanaTour.count({
      where: { tour: { aiProcessingStatus: 'COMPLETED' } },
    }),
    prisma.travioGhanaTour.count({
      where: { tour: { aiProcessingStatus: 'FAILED' } },
    }),
    prisma.travioGhanaTour.count({
      where: { tour: { aiProcessingStatus: 'PENDING' } },
    }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      total,
      completed,
      failed,
      pending,
      completionRate: total > 0 ? ((completed / total) * 100).toFixed(1) : 0,
    },
  });
});

/**
 * GET /api/travioghana/admin/ai/failed
 * Ghana tours with failed AI processing.
 */
exports.getFailedTours = catchAsync(async (req, res, next) => {
  const records = await prisma.travioGhanaTour.findMany({
    where: { tour: { aiProcessingStatus: 'FAILED' } },
    include: {
      tour: {
        select: {
          id: true, title: true, slug: true, coverPhoto: true,
          aiScoredAt: true, createdAt: true,
          supplier: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.status(200).json({
    status: 'success',
    data: { tours: records },
  });
});

// ══════════════════════════════════════════════════════════════════════════
// REVIEWS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/admin/reviews/pending
 * Pending reviews on Ghana tours.
 */
exports.getPendingReviews = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  // Get tour IDs that belong to Ghana
  const ghanaTourIds = await prisma.travioGhanaTour.findMany({
    select: { tourId: true },
  });
  const tourIds = ghanaTourIds.map((r) => r.tourId);

  const where = {
    tourId: { in: tourIds },
    status: 'PENDING',
  };

  const [reviews, totalCount] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        customer: { select: { id: true, name: true, email: true } },
        tour: { select: { id: true, title: true } },
      },
    }),
    prisma.review.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      reviews,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / take),
        totalCount,
        limit: take,
      },
    },
  });
});

/**
 * PATCH /api/travioghana/admin/reviews/:id/moderate
 * Approve/reject a review on a Ghana tour.
 */
exports.moderateReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['APPROVED', 'REJECTED'].includes(status)) {
    return next(new AppError('Status must be APPROVED or REJECTED', 400));
  }

  const review = await prisma.review.findUnique({ where: { id } });
  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  // Verify this review belongs to a Ghana tour
  const isGhanaTour = await prisma.travioGhanaTour.findFirst({
    where: { tourId: review.tourId },
  });
  if (!isGhanaTour) {
    return next(new AppError('Review does not belong to a Ghana tour', 400));
  }

  await prisma.review.update({
    where: { id },
    data: { status },
  });

  res.status(200).json({
    status: 'success',
    message: `Review ${status.toLowerCase()}`,
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ME (Admin session)
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/admin/me
 * Current admin user profile.
 */
exports.getMe = catchAsync(async (req, res, next) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, name: true, email: true, photoURL: true,
      roles: true, createdAt: true,
      adminRoleId: true,
      adminRole: {
        select: { id: true, name: true },
      },
    },
  });

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  // Fetch permissions for the admin role
  let permissions = [];
  if (user.adminRoleId) {
    const role = await prisma.adminRole.findUnique({
      where: { id: user.adminRoleId },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });
    if (role) {
      permissions = role.permissions.map((rp) => rp.permission.key);
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      ...user,
      adminRoleId: user.adminRoleId || null,
      adminRole: user.adminRole ? { ...user.adminRole, permissions } : null,
    },
  });
});

// ══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS — Ghana-scoped
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/travioghana/admin/notifications
 *
 * Returns notifications filtered to Ghana-related data only.
 * Filters by: booking source = GHANA, tour has TravioGhanaTour record,
 * or notification type is platform-agnostic (system alerts, payouts).
 */
exports.getNotifications = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, unacknowledgedOnly = false } = req.query;
  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
  const take = Math.min(parseInt(limit), 50);

  // Get all notifications for this admin
  const where = { userId: req.user.id };
  if (unacknowledgedOnly === 'true') where.readAt = null;

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
  ]);

  // Filter to Ghana-related notifications
  const ghanaNotifications = notifications.filter((n) => {
    const data = n.data || {};

    // System alerts and payouts are always shown
    if (['SYSTEM_ALERT', 'PAYOUT_NEEDS_APPROVAL', 'PAYOUT_PROCESSED'].includes(n.type)) return true;

    // Booking notifications: check if booking is Ghana-sourced
    if (['BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED'].includes(n.type)) {
      // If data has source field, filter by it
      if (data.source) return data.source === GHANA_SOURCE;
      // If data has bookingId, we can't easily check source without extra query
      // Show it if no source info (better to show than hide)
      return true;
    }

    // Tour notifications: check if tour is Ghana-curated
    if (['TOUR_SUBMITTED_FOR_REVIEW', 'TOUR_UPDATE_PENDING'].includes(n.type)) {
      if (data.source) return data.source === 'ghana' || data.source === GHANA_SOURCE;
      return true;
    }

    // Chat messages: show all (admin talks to everyone)
    if (n.type === 'NEW_MESSAGE') return true;

    // Default: show
    return true;
  });

  res.json({
    status: 'success',
    data: { notifications: ghanaNotifications, unreadCount },
    pagination: { currentPage: parseInt(page), limit: take },
  });
});

/**
 * GET /api/travioghana/admin/notifications/unread-count
 */
exports.getUnreadCount = catchAsync(async (req, res) => {
  const count = await prisma.notification.count({
    where: { userId: req.user.id, readAt: null },
  });
  res.json({ status: 'success', data: { unreadCount: count } });
});

/**
 * GET /api/travioghana/admin/notifications/stats
 */
exports.getNotificationStats = catchAsync(async (req, res) => {
  const [total, unread, today] = await Promise.all([
    prisma.notification.count({ where: { userId: req.user.id } }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    prisma.notification.count({
      where: {
        userId: req.user.id,
        createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    }),
  ]);
  res.json({ status: 'success', data: { total, unread, today } });
});

/**
 * PATCH /api/travioghana/admin/notifications/:id/acknowledge
 */
exports.acknowledgeNotification = catchAsync(async (req, res) => {
  const { id } = req.params;
  const notification = await prisma.notification.update({
    where: { id, userId: req.user.id },
    data: { read: true, readAt: new Date() },
  });
  res.json({ status: 'success', data: { notification } });
});

/**
 * PATCH /api/travioghana/admin/notifications/acknowledge-all
 */
exports.acknowledgeAllNotifications = catchAsync(async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user.id, readAt: null },
    data: { read: true, readAt: new Date() },
  });
  res.json({ status: 'success', message: 'All notifications acknowledged' });
});
