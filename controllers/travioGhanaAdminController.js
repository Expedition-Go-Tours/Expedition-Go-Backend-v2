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
const adminController = require('./adminController');

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
      weeklyBookings,
      topTours,
      topSuppliers,
      bookingStatusDist,
      recentEvents,
      recentAuditLogs,
    ] = await Promise.all([
      // Revenue + booking volume (Ghana only)
      prisma.$queryRaw`
        SELECT
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${currentPeriodStart}), 0)::float AS "todayRevenue",
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${previousPeriodStart} AND "paidAt" < ${currentPeriodStart}), 0)::float AS "yesterdayRevenue",
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${weekStart}), 0)::float AS "weekRevenue",
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${monthStart}), 0)::float AS "monthRevenue",
          COALESCE(SUM("total") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${yearStart}), 0)::float AS "ytdRevenue",
          COALESCE(SUM("supplierPayout") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${currentPeriodStart}), 0)::float AS "todayPayout",
          COALESCE(SUM("supplierPayout") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${previousPeriodStart} AND "paidAt" < ${currentPeriodStart}), 0)::float AS "yesterdayPayout",
          COALESCE(SUM("supplierPayout") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${weekStart}), 0)::float AS "weekPayout",
          COALESCE(SUM("supplierPayout") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${monthStart}), 0)::float AS "monthPayout",
          COALESCE(SUM("supplierPayout") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${yearStart}), 0)::float AS "ytdPayout",
          COALESCE(SUM("commissionAmount") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${currentPeriodStart}), 0)::float AS "todayCommission",
          COALESCE(SUM("commissionAmount") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${previousPeriodStart} AND "paidAt" < ${currentPeriodStart}), 0)::float AS "yesterdayCommission",
          COALESCE(SUM("commissionAmount") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${weekStart}), 0)::float AS "weekCommission",
          COALESCE(SUM("commissionAmount") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${monthStart}), 0)::float AS "monthCommission",
          COALESCE(SUM("commissionAmount") FILTER (WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${yearStart}), 0)::float AS "ytdCommission",
          COUNT(*) FILTER (WHERE "createdAt" >= ${currentPeriodStart})::int AS "todayBookings",
          COUNT(*) FILTER (WHERE "createdAt" >= ${previousPeriodStart} AND "createdAt" < ${currentPeriodStart})::int AS "yesterdayBookings",
          COUNT(*) FILTER (WHERE "createdAt" >= ${weekStart})::int AS "weekBookings",
          COUNT(*) FILTER (WHERE "createdAt" >= ${monthStart})::int AS "monthBookings",
          COUNT(*) FILTER (WHERE "createdAt" >= ${yearStart})::int AS "ytdBookings"
        FROM "Booking"
        WHERE "source"::text = ${GHANA_SOURCE}
          AND ("createdAt" >= ${scanStart} OR "paidAt" >= ${scanStart})
      `,

      // Ghana user signups + active users
      prisma.$queryRaw`
        SELECT
          COUNT(*) FILTER (WHERE "createdAt" >= ${currentPeriodStart})::int AS "signupsToday",
          COUNT(*) FILTER (WHERE "createdAt" >= ${previousPeriodStart} AND "createdAt" < ${currentPeriodStart})::int AS "signupsYesterday",
          COUNT(*) FILTER (WHERE "createdAt" >= ${weekStart})::int AS "signupsWeek",
          COUNT(*) FILTER (WHERE "createdAt" >= ${monthStart})::int AS "signupsMonth",
          COUNT(*) FILTER (WHERE "createdAt" >= ${yearStart})::int AS "signupsYtd",
          COUNT(*) FILTER (WHERE "lastLoginAt" >= ${currentPeriodStart} AND "active" = true)::int AS "activeToday",
          COUNT(*) FILTER (WHERE "lastLoginAt" >= ${previousPeriodStart} AND "lastLoginAt" < ${currentPeriodStart} AND "active" = true)::int AS "activePrevious",
          (SELECT COUNT(*) FROM "Event" e JOIN "User" u ON u.id = e."userId" WHERE ${GHANA_ROLE} = ANY(u."roles"::text[]))::int AS "totalEvents"
        FROM "User"
        WHERE ${GHANA_ROLE} = ANY("roles"::text[])
          AND ("createdAt" >= ${scanStart} OR "lastLoginAt" >= ${scanStart})
      `,

      // Weekly booking volume (Ghana only, period-aware)
      periodDays > 31
        ? prisma.$queryRaw`
            SELECT
              TO_CHAR(date_trunc('week', d.date), 'Mon DD') AS day,
              COALESCE(SUM(b.count), 0)::int AS count
            FROM generate_series(
              date_trunc('week', CURRENT_DATE - (${periodDays - 1} || ' days')::interval),
              date_trunc('week', CURRENT_DATE),
              '1 week'
            ) d(date)
            LEFT JOIN (
              SELECT "createdAt"::date AS date, COUNT(*)::int AS count
              FROM "Booking"
              WHERE "source"::text = ${GHANA_SOURCE}
                AND "createdAt" >= CURRENT_DATE - (${periodDays - 1} || ' days')::interval
              GROUP BY "createdAt"::date
            ) b ON b.date >= d.date AND b.date < d.date + INTERVAL '7 days'
            GROUP BY date_trunc('week', d.date), d.date
            ORDER BY d.date ASC
          `
        : prisma.$queryRaw`
            SELECT
              TO_CHAR(d.date, ${periodDays > 7 ? 'MM/DD' : 'Dy'}) AS day,
              COALESCE(b.count, 0)::int AS count
            FROM generate_series(
              CURRENT_DATE - (${Math.min(periodDays || 7, 30) - 1} || ' days')::interval,
              CURRENT_DATE, '1 day'
            ) d(date)
            LEFT JOIN (
              SELECT "createdAt"::date AS date, COUNT(*)::int AS count
              FROM "Booking"
              WHERE "source"::text = ${GHANA_SOURCE}
                AND "createdAt" >= CURRENT_DATE - (${Math.min(periodDays || 7, 30) - 1} || ' days')::interval
              GROUP BY "createdAt"::date
            ) b ON d.date = b.date
            ORDER BY d.date ASC
          `,

      // Top 10 Ghana tours by period revenue (confirmed bookings)
      prisma.$queryRaw`
        SELECT
          t.id,
          t.title,
          t."coverPhoto",
          COALESCE(b.booking_count, 0)::int AS "totalBookings",
          COALESCE(b.total_revenue, 0)::float AS "totalRevenue",
          t."averageRating",
          COALESCE(r.review_count, 0)::int AS "reviewCount",
          COALESCE((t."schedulesAndPricing"->>'currency'), 'USD') AS "currency"
        FROM "Tour" t
        JOIN "TravioGhanaTour" g ON g."tourId" = t.id
        LEFT JOIN (
          SELECT "tourId", COUNT(*)::int AS booking_count, SUM(total)::float AS total_revenue
          FROM "Booking"
          WHERE "paymentStatus" = 'SUCCEEDED' AND "paidAt" >= ${currentPeriodStart}
          GROUP BY "tourId"
        ) b ON b."tourId" = t.id
        LEFT JOIN (
          SELECT "tourId", COUNT(*)::int AS review_count
          FROM "Review" WHERE status = 'APPROVED'
          GROUP BY "tourId"
        ) r ON r."tourId" = t.id
        WHERE t.status = 'ACTIVE'
        ORDER BY COALESCE(b.total_revenue, 0) DESC
        LIMIT 10
      `,

      // Top 10 Ghana suppliers by period earnings
      prisma.$queryRaw`
        SELECT
          u.id,
          u.name,
          u.email,
          u."photoURL",
          COALESCE(period.total_earnings, 0)::float AS "totalEarnings",
          COALESCE(period.booking_count, 0)::int AS "totalBookings",
          COALESCE(period.currency, 'USD') AS "currency",
          sp."averageRating"
        FROM "SupplierProfile" sp
        JOIN "User" u ON u.id = sp."userId"
        LEFT JOIN (
          SELECT t."supplierId",
                 COUNT(*)::int AS booking_count,
                 SUM(bo."supplierPayout")::float AS total_earnings,
                 MODE() WITHIN GROUP (ORDER BY bo.currency) AS currency
          FROM "Booking" bo
          JOIN "Tour" t ON t.id = bo."tourId"
          WHERE bo."paymentStatus" = 'SUCCEEDED' AND bo."paidAt" >= ${currentPeriodStart}
            AND bo."source"::text = ${GHANA_SOURCE}
          GROUP BY t."supplierId"
        ) period ON period."supplierId" = u.id
        WHERE sp.status = 'ACTIVE' AND ${GHANA_ROLE} = ANY(u."roles"::text[])
        ORDER BY COALESCE(period.total_earnings, 0) DESC
        LIMIT 10
      `,

      // Booking status distribution (Ghana only)
      prisma.$queryRaw`
        SELECT status, COUNT(*)::int AS count
        FROM "Booking"
        WHERE "source"::text = ${GHANA_SOURCE}
        GROUP BY status
      `,

      // Ghana-related recent events
      prisma.event.findMany({
        where: { userId: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 60,
        select: { id: true, name: true, userId: true, resource: true, resourceId: true, properties: true, createdAt: true },
      }),

      // Recent admin audit logs
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, userId: true, userEmail: true, action: true, resource: true, resourceId: true, metadata: true, createdAt: true },
      }),
    ]);

    // Restrict events to Ghana-role users
    const eventUserIds = [...new Set([
      ...recentEvents.map((e) => e.userId).filter(Boolean),
      ...recentAuditLogs.map((a) => a.userId).filter(Boolean),
    ])];
    const allUsers = eventUserIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: eventUserIds } },
          select: { id: true, name: true, roles: true },
        })
      : [];
    const ghanaUserIds = new Set(allUsers.filter((u) => u.roles.includes(GHANA_ROLE)).map((u) => u.id));
    const ghanaEvents = recentEvents.filter((e) => ghanaUserIds.has(e.userId));

    const bAgg = bookingAgg[0] || {};
    const uAgg = userAgg[0] || {};

    const round2 = (v) => Math.round(parseFloat(v || 0) * 100) / 100;
    const fmt = (prefix) => ({
      revenue:        round2(bAgg[`${prefix}Revenue`]),
      supplierPayout: round2(bAgg[`${prefix}Payout`]),
      commission:     round2(bAgg[`${prefix}Commission`]),
    });
    const num = (v) => parseInt(v, 10) || 0;

    return {
      status: 'success',
      data: {
        overview: {
          revenue: {
            today:     fmt('today'),
            yesterday: fmt('yesterday'),
            thisWeek:  fmt('week'),
            thisMonth: fmt('month'),
            ytd:       fmt('ytd'),
          },
          bookings: {
            today:     num(bAgg.todayBookings),
            yesterday: num(bAgg.yesterdayBookings),
            thisWeek:  num(bAgg.weekBookings),
            thisMonth: num(bAgg.monthBookings),
            ytd:       num(bAgg.ytdBookings),
          },
          signups: {
            today:     num(uAgg.signupsToday),
            yesterday: num(uAgg.signupsYesterday),
            thisWeek:  num(uAgg.signupsWeek),
            thisMonth: num(uAgg.signupsMonth),
            ytd:       num(uAgg.signupsYtd),
          },
          activeUsers:         num(uAgg.activeToday),
          activeUsersPrevious: num(uAgg.activePrevious),
        },
        weeklyBookingData: weeklyBookings,
        topTours,
        topSuppliers,
        bookingStatusDistribution: bookingStatusDist,
        eventFeed: [
          ...ghanaEvents.map((e) => ({ ...e })),
          ...recentAuditLogs.map((a) => ({
            id: a.id,
            name: a.action,
            userId: a.userId,
            resource: a.resource,
            resourceId: a.resourceId,
            properties: {
              message: adminController.buildAuditMessage(a.action, a.resource, (a.metadata || {})),
            },
            createdAt: a.createdAt,
          })),
        ]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 20)
          .map((e) => {
            const user = allUsers.find((u) => u.id === e.userId);
            return { ...e, userName: user?.name || null };
          }),
        totalEvents: num(uAgg.totalEvents),
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
            schedulesAndPricing: true,
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
  // period: 30d | 90d | 1y — default 24 months (backward compat).
  const periodMonths = { '30d': 1, '90d': 3, '1y': 12 }[req.query.period] || 24;
  const bucket = Math.floor(Date.now() / 300000);
  const growth = await cache.getOrSet(`ghana:admin:userGrowth:${bucket}:${periodMonths}`, async () => {
    return prisma.$queryRaw`
      SELECT
        DATE_TRUNC('month', "createdAt")::date AS month,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE 'customer' = ANY("roles"::text[]))::int AS customers,
        COUNT(*) FILTER (WHERE 'supplier' = ANY("roles"::text[]))::int AS suppliers
      FROM "User"
      WHERE ${GHANA_ROLE} = ANY("roles"::text[])
        AND "createdAt" >= NOW() - (${periodMonths} || ' months')::interval
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

  const record = await prisma.travioGhanaTour.findFirst({
    where: { OR: [{ id }, { tourId: id }] },
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

  // Flatten the TravioGhanaTour wrapper: the frontend (TourDetail.tsx
  // normalizeTour) reads flat fields (title, status, schedulesAndPricing,
  // supplier, _count, ...) — same shape as the shared admin tour detail.
  const { tour, ...listing } = record;
  res.status(200).json({
    status: 'success',
    data: { tour: { ...listing, ...tour, travioGhanaTour: listing } },
  });
});

/**
 * PATCH /api/travioghana/admin/tours/:id
 * Update Ghana tour (displayOrder, isFeatured, isActive).
 */
exports.updateTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { displayOrder, isFeatured, isActive } = req.body;

  const existing = await prisma.travioGhanaTour.findFirst({ where: { OR: [{ id }, { tourId: id }] } });
  if (!existing) {
    return next(new AppError('Ghana tour not found', 404));
  }

  const record = await prisma.travioGhanaTour.update({
    where: { id: existing.id },
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

  const existing = await prisma.travioGhanaTour.findFirst({ where: { OR: [{ id }, { tourId: id }] } });
  if (!existing) {
    return next(new AppError('Ghana tour not found', 404));
  }

  await prisma.travioGhanaTour.delete({ where: { id: existing.id } });

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
  const { status, page = 1, limit = 20, search } = req.query;

  // Ghana scope: only tours that have a TravioGhanaTour listing.
  const ghanaScope = { travioGhanaTour: { isNot: null } };

  const requestedStatus = typeof status === 'string' ? status.trim() : '';
  const validStatuses = ['PENDING_APPROVAL', 'REJECTED', 'ACTIVE', 'PENDING_EDITS'];
  const searchOR = search && search.trim()
    ? [
        { title: { contains: search.trim(), mode: 'insensitive' } },
        { supplier: { name: { contains: search.trim(), mode: 'insensitive' } } },
      ]
    : null;

  // Mirror the shared admin review queue: live-tour edits keep status ACTIVE
  // while the edit lives in draftStatus, so tabs must look at both columns.
  let where = { ...ghanaScope };
  if (requestedStatus === 'PENDING_EDITS') {
    where.draftStatus = 'PENDING_APPROVAL';
  } else if (requestedStatus === 'PENDING_APPROVAL') {
    const statusOR = [{ status: 'PENDING_APPROVAL' }, { draftStatus: 'PENDING_APPROVAL' }];
    where.AND = searchOR ? [{ OR: statusOR }, { OR: searchOR }] : [{ OR: statusOR }];
  } else if (requestedStatus === 'REJECTED') {
    const statusOR = [{ status: 'REJECTED' }, { draftStatus: 'REJECTED' }];
    where.AND = searchOR ? [{ OR: statusOR }, { OR: searchOR }] : [{ OR: statusOR }];
  } else if (validStatuses.includes(requestedStatus)) {
    where.status = requestedStatus;
    if (searchOR) where.OR = searchOR;
  } else {
    // Default "All" tab: pending items only (new submissions + live-tour edits)
    const pendingOR = [{ status: 'PENDING_APPROVAL' }, { draftStatus: 'PENDING_APPROVAL' }];
    where.AND = searchOR ? [{ OR: pendingOR }, { OR: searchOR }] : [{ OR: pendingOR }];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  const [tours, totalCount, pendingCount, rejectedCount, pendingEditsCount] = await Promise.all([
    prisma.tour.findMany({
      where,
      orderBy: [
        { submittedAt: 'desc' },
        { draftSubmittedAt: 'desc' },
        { updatedAt: 'desc' },
      ],
      skip,
      take,
      include: {
        supplier: {
          select: { id: true, name: true, email: true, photoURL: true },
        },
        travioGhanaTour: {
          select: { id: true, isActive: true, isFeatured: true, displayOrder: true },
        },
        _count: {
          select: { bookings: true, reviews: true },
        },
      },
    }),
    prisma.tour.count({ where }),
    prisma.tour.count({ where: { ...ghanaScope, OR: [{ status: 'PENDING_APPROVAL' }, { draftStatus: 'PENDING_APPROVAL' }] } }),
    prisma.tour.count({ where: { ...ghanaScope, OR: [{ status: 'REJECTED' }, { draftStatus: 'REJECTED' }] } }),
    prisma.tour.count({ where: { ...ghanaScope, draftStatus: 'PENDING_APPROVAL' } }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      tours,
      counts: { pending: pendingCount, rejected: rejectedCount, pendingEdits: pendingEditsCount },
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
  const { action, status, reason } = req.body || {};

  // Frontend sends { action: 'approve' | 'flag', reason } (same as the shared
  // admin controller); accept the older { status } form too for compat.
  let newStatus;
  if (action) {
    if (!['approve', 'flag'].includes(action)) {
      return next(new AppError('Action must be either "approve" or "flag"', 400));
    }
    if (action === 'flag' && (!reason || !String(reason).trim())) {
      return next(new AppError('A reason is required when flagging a tour', 400));
    }
    newStatus = action === 'approve' ? 'ACTIVE' : 'REJECTED';
  } else {
    if (!['ACTIVE', 'REJECTED'].includes(status)) {
      return next(new AppError('Status must be ACTIVE or REJECTED', 400));
    }
    newStatus = status;
  }

  const record = await prisma.travioGhanaTour.findFirst({
    where: { OR: [{ id }, { tourId: id }] },
    include: { tour: { select: { id: true, title: true } } },
  });

  if (!record) {
    return next(new AppError('Ghana tour not found', 404));
  }

  await prisma.tour.update({
    where: { id: record.tourId },
    data: { status: newStatus },
  });

  await logActivity({
    action: newStatus === 'ACTIVE' ? 'tour.approved' : 'tour.rejected',
    entityType: 'TravioGhanaTour',
    entityId: id,
    userId: req.user.id,
    metadata: { reason: reason || null },
  });

  res.status(200).json({
    status: 'success',
    message: `Tour ${newStatus === 'ACTIVE' ? 'approved' : 'rejected'}`,
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

  // Whitelist sortable Booking columns — never interpolate a client-supplied
  // value into orderBy (invalid Prisma order keys would otherwise surface).
  const ALLOWED_BOOKING_SORTS = ['createdAt', 'updatedAt', 'total', 'status', 'paymentStatus', 'bookingNumber'];
  const orderField = ALLOWED_BOOKING_SORTS.includes(sortBy) ? sortBy : 'createdAt';
  const orderDir = sortOrder === 'asc' ? 'asc' : 'desc';

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

  const [bookings, totalCount, counts, ghanaTotal] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { [orderField]: orderDir },
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
        payouts: {
          select: {
            id: true, amount: true, currency: true, status: true,
            createdAt: true, paidAt: true, approvedAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    }),
    prisma.booking.count({ where }),
    prisma.booking.groupBy({
      by: ['status'],
      where: { source: GHANA_SOURCE },
      _count: { _all: true },
    }),
    prisma.booking.count({ where: { source: GHANA_SOURCE } }),
  ]);

  const countsObj = { total: ghanaTotal, PENDING: 0, CONFIRMED: 0, COMPLETED: 0, CANCELLED: 0 };
  for (const c of counts) countsObj[c.status] = c._count._all;

  res.status(200).json({
    status: 'success',
    data: {
      bookings,
      counts: countsObj,
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
      payouts: {
        select: {
          id: true, amount: true, currency: true, status: true,
          createdAt: true, paidAt: true, approvedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!booking) {
    return next(new AppError('Ghana booking not found', 404));
  }

  // Frontend (BookingDetailPanel) reads data.data as the booking itself.
  res.status(200).json({ status: 'success', data: booking });
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
  // The UserGrowth drill-down dialog sends ?period=30d|90d|1y&role=...
  // (plus the Overview "new signups" card which calls without a period —
  // that defaults to today).
  const periodMap = { '30d': 30, '90d': 90, '1y': 365 };
  const days = req.query.period ? periodMap[req.query.period] : null;
  const { role } = req.query;

  const where = { roles: { has: GHANA_ROLE } };
  if (days) {
    where.createdAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  } else {
    const now = new Date();
    where.createdAt = { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) };
  }
  if (role) where.roles = { hasEvery: [GHANA_ROLE, role] };

  const users = await prisma.user.findMany({
    where,
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
  // Ghana-scoped mirror of the shared admin AI status (same response shape).
  const statusCounts = await prisma.$queryRaw`
    SELECT t."aiProcessingStatus", COUNT(*)::int AS count
    FROM "Tour" t
    JOIN "TravioGhanaTour" g ON g."tourId" = t.id
    WHERE t.status = 'ACTIVE'
    GROUP BY t."aiProcessingStatus"
  `;

  const tourStats = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of statusCounts) {
    tourStats.total += row.count;
    const key = row.aiProcessingStatus.toLowerCase();
    if (key in tourStats) tourStats[key] = row.count;
  }

  const imageStats = await prisma.tourImageAnalysis.groupBy({
    by: ['aiStatus'],
    where: { tour: { travioGhanaTour: { isNot: null } } },
    _count: { id: true },
  });

  const imageAnalysis = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of imageStats) {
    imageAnalysis.total += row._count.id;
    const key = row.aiStatus.toLowerCase();
    if (key in imageAnalysis) imageAnalysis[key] = row._count.id;
  }

  const attractionStats = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "heroImage" IS NOT NULL)::int AS with_hero_image,
      COUNT(*) FILTER (WHERE "heroImageSource" = 'ai_selected')::int AS ai_selected,
      COUNT(*) FILTER (WHERE "heroImageSource" = 'fallback')::int AS fallback_image,
      COUNT(*) FILTER (WHERE "manualOverride" = true)::int AS manual_override
    FROM "Attraction"
  `;

  const { getAiCronStatus } = require('../utils/aiCronFallback');
  const cronStatus = getAiCronStatus();

  const lastProcessed = await prisma.tour.findFirst({
    where: { aiProcessingStatus: 'COMPLETED', travioGhanaTour: { isNot: null } },
    orderBy: { aiScoredAt: 'desc' },
    select: { aiScoredAt: true, title: true },
  });

  res.json({
    status: 'success',
    data: {
      tours: tourStats,
      imageAnalysis,
      attractions: attractionStats[0] || {},
      cron: cronStatus,
      lastProcessed: lastProcessed
        ? { title: lastProcessed.title, at: lastProcessed.aiScoredAt }
        : null,
    },
  });
});

/**
 * GET /api/travioghana/admin/ai/failed
 * Ghana tours with failed AI processing.
 */
exports.getFailedTours = catchAsync(async (req, res, next) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const tours = await prisma.tour.findMany({
    where: {
      aiProcessingStatus: 'FAILED',
      status: 'ACTIVE',
      travioGhanaTour: { isNot: null },
    },
    select: {
      id: true,
      title: true,
      category: true,
      city: true,
      createdAt: true,
      aiScoredAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const failedImages = await prisma.tourImageAnalysis.findMany({
    where: { aiStatus: 'FAILED', tour: { travioGhanaTour: { isNot: null } } },
    select: {
      id: true,
      tourId: true,
      imageUrl: true,
      aiRetryCount: true,
      aiDescription: true,
    },
    orderBy: { aiRetryCount: 'desc' },
    take: 50,
  });

  res.json({
    status: 'success',
    data: {
      tours,
      failedImages,
      tourCount: tours.length,
      imageCount: failedImages.length,
    },
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

  const [reviews, totalCount, counts] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        customer: { select: { id: true, name: true, email: true, photoURL: true } },
        tour: {
          select: {
            id: true, title: true, slug: true, coverPhoto: true,
            supplier: { select: { id: true, name: true, photoURL: true } },
          },
        },
      },
    }),
    prisma.review.count({ where }),
    Promise.all([
      prisma.review.count({ where: { tourId: { in: tourIds }, status: 'PENDING' } }),
      prisma.review.count({ where: { tourId: { in: tourIds }, flaggedAt: { not: null } } }),
      prisma.review.count({
        where: {
          tourId: { in: tourIds },
          moderatedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    ]),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      reviews,
      counts: {
        pending: counts[0],
        flagged: counts[1],
        moderatedToday: counts[2],
      },
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
  const { action, status, reason } = req.body || {};

  // Frontend sends { action: 'approve' | 'reject' | 'flag', reason } (same as
  // the shared admin controller); accept the older { status } form too.
  let newStatus;
  if (action) {
    if (!['approve', 'reject', 'flag'].includes(action)) {
      return next(new AppError('Action must be "approve", "reject" or "flag"', 400));
    }
    newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
  } else {
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return next(new AppError('Status must be APPROVED or REJECTED', 400));
    }
    newStatus = status;
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
    data: { status: newStatus },
  });

  res.status(200).json({
    status: 'success',
    message: `Review ${newStatus.toLowerCase()}`,
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
  const [total, unacknowledged, byType, recent] = await Promise.all([
    prisma.notification.count({ where: { userId: req.user.id } }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    prisma.notification.groupBy({
      by: ['type'],
      where: { userId: req.user.id },
      _count: { _all: true },
    }),
    prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true, type: true, title: true, message: true, data: true,
        read: true, readAt: true, createdAt: true,
      },
    }),
  ]);
  res.json({
    status: 'success',
    data: {
      total,
      unacknowledged,
      byType: byType.map((t) => ({ type: t.type, _count: t._count._all })),
      recent: recent.map((n) => ({ ...n, acknowledged: n.read })),
    },
  });
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
