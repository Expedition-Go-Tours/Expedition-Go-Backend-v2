/**
 * Admin Controller — Platform-Wide Analytics & Management
 *
 * Exposes endpoints that the admin dashboard consumes.
 * Every query is intentionally raw SQL (via prisma.$queryRaw or $transaction)
 * so that we can scale to millions of rows without ORM overhead.
 *
 * DESIGN:
 *  - Supplier-specific analytics live in supplierController.js
 *  - Tour-specific analytics live in tourController.js
 *  - This controller is for CROSS-CUTTING platform views only.
 *
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');

/**
 * GET /api/admin/analytics/overview
 *
 * Platform-wide snapshot for the admin dashboard.
 * Returns everything needed for a single-page overview:
 *   - Revenue & booking volumes (today, week, month, YTD)
 *   - Active users & new signups
 *   - Top tours & suppliers by revenue
 *   - Booking status distribution
 *   - Recent activity feed
 *
 * All time periods are calendar-based (UTC midnight boundaries).
 */
exports.getOverview = catchAsync(async (req, res, next) => {
  const now = new Date();

  // Start-of-day for "today" range
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const previous30Start = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    revenueToday,
    revenueYesterday,
    revenueThisWeek,
    revenueThisMonth,
    revenueYTD,
    bookingsToday,
    bookingsYesterday,
    bookingsThisWeek,
    bookingsThisMonth,
    bookingsYTD,
    signupsToday,
    signupsYesterday,
    signupsThisWeek,
    signupsThisMonth,
    signupsYTD,
    activeUsers,
    activeUsersPrevious,
    topTours,
    topSuppliers,
    bookingStatusDist,
    recentEvents,
    allUsers,
    totalEventCount,
  ] = await Promise.all([

    /* Revenue aggregations */
    prisma.booking.aggregate({
      _sum: { total: true, supplierPayout: true, commissionAmount: true },
      where: { paidAt: { gte: todayStart }, paymentStatus: 'SUCCEEDED' },
    }),
    prisma.booking.aggregate({
      _sum: { total: true, supplierPayout: true, commissionAmount: true },
      where: { paidAt: { gte: yesterdayStart, lt: todayStart }, paymentStatus: 'SUCCEEDED' },
    }),
    prisma.booking.aggregate({
      _sum: { total: true, supplierPayout: true, commissionAmount: true },
      where: { paidAt: { gte: weekStart }, paymentStatus: 'SUCCEEDED' },
    }),
    prisma.booking.aggregate({
      _sum: { total: true, supplierPayout: true, commissionAmount: true },
      where: { paidAt: { gte: monthStart }, paymentStatus: 'SUCCEEDED' },
    }),
    prisma.booking.aggregate({
      _sum: { total: true, supplierPayout: true, commissionAmount: true },
      where: { paidAt: { gte: yearStart }, paymentStatus: 'SUCCEEDED' },
    }),

    /* Booking volume aggregations */
    prisma.booking.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.booking.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart } } }),
    prisma.booking.count({ where: { createdAt: { gte: weekStart } } }),
    prisma.booking.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.booking.count({ where: { createdAt: { gte: yearStart } } }),

    /* User signups */
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.user.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart } } }),
    prisma.user.count({ where: { createdAt: { gte: weekStart } } }),
    prisma.user.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.user.count({ where: { createdAt: { gte: yearStart } } }),

    /* Active users (logged in within last 30 days) */
    prisma.user.count({
      where: {
        lastLoginAt: { gte: thirtyDaysAgo },
        active: true,
      },
    }),

    /* Active users previous 30-day period */
    prisma.user.count({
      where: {
        lastLoginAt: { gte: previous30Start, lt: thirtyDaysAgo },
        active: true,
      },
    }),

    /* Top 10 tours by total revenue (confirmed bookings) */
    prisma.$queryRaw`
      SELECT
        t.id,
        t.title,
        t."coverPhoto",
        COALESCE(b.booking_count, 0)::int AS "totalBookings",
        t."totalRevenue",
        t."averageRating",
        COALESCE(r.review_count, 0)::int AS "reviewCount"
      FROM "Tour" t
      LEFT JOIN (
        SELECT "tourId", COUNT(*)::int AS booking_count
        FROM "Booking" WHERE "paymentStatus" = 'SUCCEEDED'
        GROUP BY "tourId"
      ) b ON b."tourId" = t.id
      LEFT JOIN (
        SELECT "tourId", COUNT(*)::int AS review_count
        FROM "Review" WHERE status = 'APPROVED'
        GROUP BY "tourId"
      ) r ON r."tourId" = t.id
      WHERE t.status = 'ACTIVE'
      ORDER BY t."totalRevenue" DESC
      LIMIT 10
    `,

    /* Top 10 suppliers by total earnings */
    prisma.$queryRaw`
      SELECT
        u.id,
        u.name,
        u.email,
        u."photoURL",
        sp."totalEarnings",
        sp."totalBookings",
        sp."averageRating"
      FROM "SupplierProfile" sp
      JOIN "User" u ON u.id = sp."userId"
      WHERE sp.status = 'ACTIVE'
      ORDER BY sp."totalEarnings" DESC
      LIMIT 10
    `,

    /* Booking status distribution */
    prisma.booking.groupBy({
      by: ['status'],
      _count: true,
    }),

    /* Platform-wide recent events (last 20) */
    prisma.event.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        name: true,
        userId: true,
        resource: true,
        resourceId: true,
        properties: true,
        createdAt: true,
      },
    }),

    /* User names for event feed */
    prisma.user.findMany({
      select: { id: true, name: true },
    }),

    /* Total platform events (quick sanity metric) */
    prisma.event.count(),
  ]);

  // Flatten revenue sums with safe defaults
  const fmt = (agg) => ({
    revenue:      parseFloat(agg._sum.total || 0).toFixed(2),
    supplierPayout: parseFloat(agg._sum.supplierPayout || 0).toFixed(2),
    commission:   parseFloat(agg._sum.commissionAmount || 0).toFixed(2),
  });

  res.status(200).json({
    status: 'success',
    data: {
      overview: {
        revenue: {
          today:    fmt(revenueToday),
          yesterday: fmt(revenueYesterday),
          thisWeek: fmt(revenueThisWeek),
          thisMonth:fmt(revenueThisMonth),
          ytd:      fmt(revenueYTD),
        },
        bookings: {
          today:    bookingsToday,
          yesterday: bookingsYesterday,
          thisWeek: bookingsThisWeek,
          thisMonth:bookingsThisMonth,
          ytd:      bookingsYTD,
        },
        signups: {
          today:    signupsToday,
          yesterday: signupsYesterday,
          thisWeek: signupsThisWeek,
          thisMonth:signupsThisMonth,
          ytd:      signupsYTD,
        },
        activeUsersLast30Days: activeUsers,
        activeUsersPrevious30: activeUsersPrevious,
      },
      topTours,
      topSuppliers,
      bookingStatusDistribution: bookingStatusDist.map((b) => ({
        status: b.status,
        count:  b._count,
      })),
      eventFeed: recentEvents.map((e) => {
        const user = allUsers.find((u) => u.id === e.userId);
        return { ...e, userName: user?.name || null };
      }),
      totalEvents: totalEventCount,
    },
  });
});

/**
 * GET /api/admin/analytics/revenue-trend
 *
 * Monthly revenue breakdown for charting (last 24 months).
 * Returns revenue, bookings, and commission per month.
 */
exports.getRevenueTrend = catchAsync(async (req, res, next) => {
  const months = await prisma.$queryRaw`
    SELECT
      DATE_TRUNC('month', "paidAt")::date AS month,
      COUNT(*)::int                       AS bookings,
      ROUND(SUM("total")::numeric, 2)     AS revenue,
      ROUND(SUM("commissionAmount")::numeric, 2) AS commission,
      ROUND(SUM("supplierPayout")::numeric, 2)   AS "supplierPayout"
    FROM "Booking"
    WHERE "paidAt" >= NOW() - INTERVAL '24 months'
      AND "paymentStatus" = 'SUCCEEDED'
    GROUP BY DATE_TRUNC('month', "paidAt")
    ORDER BY month ASC
  `;

  res.status(200).json({ status: 'success', data: { months } });
});

/**
 * GET /api/admin/analytics/user-growth
 *
 * New user signups per month (last 24 months).
 * Broken down by role so we can see customer vs. supplier growth.
 */
exports.getUserGrowth = catchAsync(async (req, res, next) => {
  const growth = await prisma.$queryRaw`
    SELECT
      DATE_TRUNC('month', "createdAt")::date AS month,
      COUNT(*)::int                          AS total,
      COUNT(*) FILTER (WHERE 'customer' = ANY("roles"))::int AS customers,
      COUNT(*) FILTER (WHERE 'supplier'  = ANY("roles"))::int AS suppliers
    FROM "User"
    WHERE "createdAt" >= NOW() - INTERVAL '24 months'
    GROUP BY DATE_TRUNC('month', "createdAt")
    ORDER BY month ASC
  `;

  res.status(200).json({ status: 'success', data: { growth } });
});

/**
 * GET /api/admin/analytics/tour-performance
 *
 * Tour-level performance metrics for admin comparison view.
 * Paginated, filterable by status and category.
 */
exports.getTourPerformance = catchAsync(async (req, res, next) => {
  const {
    status,
    category,
    page = 1,
    limit = 20,
    sortBy = 'totalRevenue',
    sortOrder = 'desc',
  } = req.query;

  const allowedSorts = ['totalRevenue', 'totalBookings', 'averageRating', 'viewCount', 'createdAt'];
  const field = allowedSorts.includes(sortBy) ? sortBy : 'totalRevenue';
  const order = sortOrder === 'asc' ? 'asc' : 'desc';

  const filterStatus = status && status !== 'all' ? status.toUpperCase() : undefined;
  const where = { ...(filterStatus && { status: filterStatus }) };
  // category filtering via JSON is expensive at scale; accept this for now.
  if (category) {
    where.categorization = { path: ['category'], equals: category };
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [tours, totalCount] = await Promise.all([
    prisma.tour.findMany({
      where,
      orderBy: { [field]: order },
      skip,
      take: parseInt(limit),
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        coverPhoto: true,
        totalBookings: true,
        totalRevenue: true,
        averageRating: true,
        reviewCount: true,
        viewCount: true,
        createdAt: true,
        supplier: { select: { id: true, name: true } },
        _count: { select: { bookings: true } },
      },
    }),
    prisma.tour.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      tours,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        totalCount,
        limit: parseInt(limit),
      },
    },
  });
});

// =============================================================================
// PHASE 2 — MARKETPLACE ANALYTICS
// =============================================================================

/**
 * GET /api/admin/analytics/funnel
 *
 * Booking conversion funnel: viewed → cart_added → checkout → completed
 * Each step is a user count, not an event count (deduplicated by userId).
 * The funnel shows how many unique users reached each stage.
 *
 * Query params: period (7d | 30d | 90d | 1y) — defaults to 30d
 */
exports.getFunnel = catchAsync(async (req, res, next) => {
  const periodMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const days = periodMap[req.query.period] || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Each query counts unique userIds who performed the event at least once in the period.
  // This is the true "user funnel" — a single user may be counted at most once per step.
  const [viewed, cartAdded, checkoutStarted, completed, stepData] = await Promise.all([
    // Step 1: Users who viewed any tour
    prisma.event.groupBy({
      by: ['userId'],
      where: { name: 'tour.viewed', createdAt: { gte: startDate }, userId: { not: null } },
      _count: true,
    }),

    // Step 2: Users who added to cart
    prisma.event.groupBy({
      by: ['userId'],
      where: { name: 'cart.added', createdAt: { gte: startDate }, userId: { not: null } },
      _count: true,
    }),

    // Step 3: Users who started checkout
    prisma.event.groupBy({
      by: ['userId'],
      where: { name: 'booking.initiated', createdAt: { gte: startDate }, userId: { not: null } },
      _count: true,
    }),

    // Step 4: Users who successfully paid
    prisma.event.groupBy({
      by: ['userId'],
      where: { name: 'booking.completed', createdAt: { gte: startDate }, userId: { not: null } },
      _count: true,
    }),

    // Also get daily breakdown for charting
    prisma.$queryRaw`
      SELECT
        name,
        DATE_TRUNC('day', "createdAt")::date AS day,
        COUNT(DISTINCT "userId")::int AS users
      FROM "Event"
      WHERE "createdAt" >= ${startDate}
        AND "name" IN ('tour.viewed', 'cart.added', 'booking.initiated', 'booking.completed')
        AND "userId" IS NOT NULL
      GROUP BY name, DATE_TRUNC('day', "createdAt")
      ORDER BY day ASC
    `,
  ]);

  const viewedUsers = viewed.length;
  const cartUsers = cartAdded.length;
  const checkoutUsers = checkoutStarted.length;
  const completedUsers = completed.length;

  const calcRate = (numerator, denominator) =>
    denominator > 0 ? parseFloat(((numerator / denominator) * 100).toFixed(1)) : 0;

  res.status(200).json({
    status: 'success',
    data: {
      period: `${days}d`,
      funnel: [
        { step: 'viewed',          users: viewedUsers,     dropOff: null },
        { step: 'cart_added',      users: cartUsers,       dropOff: `${(100 - calcRate(cartUsers, viewedUsers))}%` },
        { step: 'checkout_started',users: checkoutUsers,    dropOff: `${(100 - calcRate(checkoutUsers, cartUsers))}%` },
        { step: 'booking_completed',users: completedUsers,  dropOff: `${(100 - calcRate(completedUsers, checkoutUsers))}%` },
      ],
      conversionRates: {
        viewToCart:  calcRate(cartUsers, viewedUsers),
        cartToCheckout: calcRate(checkoutUsers, cartUsers),
        checkoutToComplete: calcRate(completedUsers, checkoutUsers),
        overall:    calcRate(completedUsers, viewedUsers),
      },
      dailyTrend: stepData,
    },
  });
});

/**
 * GET /api/admin/analytics/clv
 *
 * Customer Lifetime Value & Repeat Booking Rate.
 * Answers:
 *   - How much revenue does the average customer generate?
 *   - What percentage of customers book more than once?
 *   - Who are the top customers by lifetime value?
 *   - How are customers distributed by booking count?
 */
exports.getCLV = catchAsync(async (req, res, next) => {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const [
    basicStats,
    repeatRate,
    bookingDistribution,
    topCustomers,
    monthlyCohorts,
  ] = await Promise.all([

    // Basic customer stats
    prisma.$queryRaw`
      SELECT
        COUNT(DISTINCT "customerId")::int             AS "totalCustomers",
        COUNT(*)::int                                  AS "totalBookings",
        ROUND(AVG("total")::numeric, 2)               AS "avgBookingValue",
        ROUND(SUM("total")::numeric, 2)                AS "totalRevenue"
      FROM "Booking"
      WHERE "paymentStatus" = 'SUCCEEDED'
    `,

    // Repeat booking rate
    prisma.$queryRaw`
      WITH customer_bookings AS (
        SELECT "customerId", COUNT(*)::int AS booking_count
        FROM "Booking"
        WHERE "paymentStatus" = 'SUCCEEDED'
        GROUP BY "customerId"
      )
      SELECT
        COUNT(*)::int                                          AS "totalCustomers",
        COUNT(*) FILTER (WHERE booking_count >= 2)::int        AS "repeatCustomers",
        COUNT(*) FILTER (WHERE booking_count >= 2)::int * 100.0 / NULLIF(COUNT(*), 0) AS "repeatRate",
        ROUND(AVG(booking_count)::numeric, 2)                  AS "avgBookingsPerCustomer"
      FROM customer_bookings
    `,

    // Distribution: how many customers have 1, 2, 3, 4+ bookings
    prisma.$queryRaw`
      WITH customer_bookings AS (
        SELECT "customerId", COUNT(*)::int AS booking_count
        FROM "Booking"
        WHERE "paymentStatus" = 'SUCCEEDED'
        GROUP BY "customerId"
      )
      SELECT
        CASE
          WHEN booking_count = 1 THEN '1'
          WHEN booking_count = 2 THEN '2'
          WHEN booking_count = 3 THEN '3'
          WHEN booking_count = 4 THEN '4'
          ELSE '5+'
        END AS "bookingCount",
        COUNT(*)::int AS customers,
        ROUND(SUM(booking_count) * 100.0 / NULLIF(SUM(SUM(booking_count)) OVER (), 0), 1) AS "percentage"
      FROM customer_bookings
      GROUP BY CASE
        WHEN booking_count = 1 THEN '1'
        WHEN booking_count = 2 THEN '2'
        WHEN booking_count = 3 THEN '3'
        WHEN booking_count = 4 THEN '4'
        ELSE '5+'
      END
      ORDER BY "bookingCount" ASC
    `,

    // Top 20 customers by total spend (CLV)
    prisma.$queryRaw`
      SELECT
        u.id,
        u.name,
        u.email,
        COUNT(*)::int                         AS "totalBookings",
        ROUND(SUM(b.total)::numeric, 2)       AS "totalSpent",
        ROUND(AVG(b.total)::numeric, 2)       AS "avgBookingValue",
        MAX(b."paidAt")                       AS "lastBookingDate"
      FROM "Booking" b
      JOIN "User" u ON u.id = b."customerId"
      WHERE b."paymentStatus" = 'SUCCEEDED'
      GROUP BY u.id, u.name, u.email
      ORDER BY "totalSpent" DESC
      LIMIT 20
    `,

    // Monthly signup cohort performance (YTD)
    prisma.$queryRaw`
      WITH signup_cohorts AS (
        SELECT
          u.id,
          DATE_TRUNC('month', u."createdAt")::date AS "signupMonth"
        FROM "User" u
        WHERE u."createdAt" >= ${yearStart}
      ),
      cohort_bookings AS (
        SELECT
          sc."signupMonth",
          COUNT(DISTINCT sc.id)::int            AS "users",
          COUNT(DISTINCT b.id)::int             AS "bookings",
          ROUND(COALESCE(SUM(b.total), 0)::numeric, 2) AS "revenue"
        FROM signup_cohorts sc
        LEFT JOIN "Booking" b ON b."customerId" = sc.id AND b."paymentStatus" = 'SUCCEEDED'
        GROUP BY sc."signupMonth"
        ORDER BY sc."signupMonth" ASC
      )
      SELECT *,
        ROUND("bookings"::numeric / NULLIF("users", 0), 2) AS "bookingsPerUser",
        ROUND("revenue"::numeric / NULLIF("users", 0), 2)  AS "revenuePerUser"
      FROM cohort_bookings
    `,
  ]);

  const fmt = (r) => ({
    totalCustomers: r[0].totalCustomers,
    totalBookings: r[0].totalBookings,
    avgBookingValue: r[0].avgBookingValue,
    totalRevenue: r[0].totalRevenue,
    avgCLV: r[0].totalCustomers > 0
      ? parseFloat((parseFloat(r[0].totalRevenue) / r[0].totalCustomers).toFixed(2))
      : 0,
  });

  res.status(200).json({
    status: 'success',
    data: {
      overview: fmt(basicStats),
      repeatRate: {
        totalCustomers: repeatRate[0].totalCustomers,
        repeatCustomers: repeatRate[0].repeatCustomers,
        repeatRate: parseFloat(parseFloat(repeatRate[0].repeatRate || 0).toFixed(1)),
        avgBookingsPerCustomer: parseFloat(repeatRate[0].avgBookingsPerCustomer || 0),
      },
      distribution: bookingDistribution.map((d) => ({
        bookingCount: d.bookingCount,
        customers: d.customers,
        percentage: parseFloat(d.percentage || 0),
      })),
      topCustomers: topCustomers.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        totalBookings: c.totalBookings,
        totalSpent: parseFloat(c.totalSpent),
        avgBookingValue: parseFloat(c.avgBookingValue),
        lastBookingDate: c.lastBookingDate,
      })),
      cohorts: monthlyCohorts.map((c) => ({
        month: c.signupMonth,
        users: c.users,
        bookings: c.bookings,
        revenue: parseFloat(c.revenue),
        bookingsPerUser: parseFloat(c.bookingsPerUser || 0),
        revenuePerUser: parseFloat(c.revenuePerUser || 0),
      })),
    },
  });
});

/**
 * GET /api/admin/analytics/search
 *
 * Search analytics — what users are looking for.
 * Shows:
 *   - Total searches & unique searchers
 *   - Top search queries
 *   - Zero-result queries (demand without supply)
 *   - Search-to-view conversion
 *
 * Query params: period (7d | 30d | 90d | 1y) — defaults to 30d
 */
exports.getSearchAnalytics = catchAsync(async (req, res, next) => {
  const periodMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const days = periodMap[req.query.period] || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const [
    totalSearches,
    topQueries,
    zeroResultQueries,
    dailySearchTrend,
    searchOutcome,
  ] = await Promise.all([

    // Total search volume metrics
    prisma.$queryRaw`
      SELECT
        COUNT(*)::int                                          AS "totalSearches",
        COUNT(DISTINCT "userId")::int                          AS "uniqueSearchers",
        COUNT(*) FILTER (WHERE "properties"->>'resultCount' = '0')::int AS "zeroResultSearches",
        ROUND(
          COUNT(*) FILTER (WHERE "properties"->>'resultCount' = '0') * 100.0
          / NULLIF(COUNT(*), 0), 1
        ) AS "zeroResultRate"
      FROM "Event"
      WHERE "name" = 'search.executed'
        AND "createdAt" >= ${startDate}
    `,

    // Top search queries
    prisma.$queryRaw`
      SELECT
        "properties"->>'query' AS query,
        COUNT(*)::int AS searches,
        COUNT(DISTINCT "userId")::int AS "uniqueUsers",
        ROUND(AVG(("properties"->>'resultCount')::int), 1) AS "avgResults"
      FROM "Event"
      WHERE "name" = 'search.executed'
        AND "createdAt" >= ${startDate}
        AND "properties"->>'query' IS NOT NULL
        AND "properties"->>'query' != ''
      GROUP BY "properties"->>'query'
      ORDER BY searches DESC
      LIMIT 50
    `,

    // Zero-result queries (product opportunity)
    prisma.$queryRaw`
      SELECT
        "properties"->>'query' AS query,
        COUNT(*)::int AS searches,
        COUNT(DISTINCT "userId")::int AS "uniqueUsers"
      FROM "Event"
      WHERE "name" = 'search.executed'
        AND "createdAt" >= ${startDate}
        AND "properties"->>'resultCount' = '0'
        AND "properties"->>'query' IS NOT NULL
        AND "properties"->>'query' != ''
      GROUP BY "properties"->>'query'
      ORDER BY searches DESC
      LIMIT 25
    `,

    // Daily search volume
    prisma.$queryRaw`
      SELECT
        DATE_TRUNC('day', "createdAt")::date AS day,
        COUNT(*)::int AS searches,
        COUNT(*) FILTER (WHERE "properties"->>'resultCount' != '0')::int AS "searchesWithResults"
      FROM "Event"
      WHERE "name" = 'search.executed'
        AND "createdAt" >= ${startDate}
      GROUP BY DATE_TRUNC('day', "createdAt")
      ORDER BY day ASC
    `,

    // What happens after a search: did the user view a tour?
    prisma.$queryRaw`
      WITH searchers AS (
        SELECT DISTINCT "userId"
        FROM "Event"
        WHERE "name" = 'search.executed'
          AND "createdAt" >= ${startDate}
          AND "userId" IS NOT NULL
      ),
      viewers AS (
        SELECT DISTINCT e."userId"
        FROM "Event" e
        JOIN searchers s ON s."userId" = e."userId"
        WHERE e."name" = 'tour.viewed'
          AND e."createdAt" >= ${startDate}
      ),
      bookers AS (
        SELECT DISTINCT e."userId"
        FROM "Event" e
        JOIN searchers s ON s."userId" = e."userId"
        WHERE e."name" = 'booking.completed'
          AND e."createdAt" >= ${startDate}
      )
      SELECT
        (SELECT COUNT(*) FROM searchers)::int AS "searchers",
        (SELECT COUNT(*) FROM viewers)::int   AS "viewersAfterSearch",
        (SELECT COUNT(*) FROM bookers)::int   AS "bookersAfterSearch"
    `,
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      period: `${days}d`,
      overview: {
        totalSearches:          totalSearches[0].totalSearches,
        uniqueSearchers:        totalSearches[0].uniqueSearchers,
        zeroResultSearches:     totalSearches[0].zeroResultSearches,
        zeroResultRate:         parseFloat(totalSearches[0].zeroResultRate || 0),
      },
      searchOutcome: {
        searchers:              searchOutcome[0].searchers,
        viewersAfterSearch:     searchOutcome[0].viewersAfterSearch,
        bookersAfterSearch:     searchOutcome[0].bookersAfterSearch,
        searchToViewRate:       searchOutcome[0].searchers > 0
          ? parseFloat(((searchOutcome[0].viewersAfterSearch / searchOutcome[0].searchers) * 100).toFixed(1))
          : 0,
        searchToBookRate:       searchOutcome[0].searchers > 0
          ? parseFloat(((searchOutcome[0].bookersAfterSearch / searchOutcome[0].searchers) * 100).toFixed(1))
          : 0,
      },
      topQueries: topQueries.map((q) => ({
        query: q.query,
        searches: q.searches,
        uniqueUsers: q.uniqueUsers,
        avgResults: parseFloat(q.avgResults || 0),
      })),
      zeroResultQueries: zeroResultQueries.map((q) => ({
        query: q.query,
        searches: q.searches,
        uniqueUsers: q.uniqueUsers,
      })),
      dailyTrend: dailySearchTrend.map((d) => ({
        day: d.day,
        searches: d.searches,
        searchesWithResults: d.searchesWithResults,
      })),
    },
  });
});

/**
 * GET /api/admin/analytics/cart-abandonment
 *
 * Cart abandonment rate & reasons.
 * Uses events to track:
 *   - Total carts created
 *   - Carts that converted to bookings
 *   - Abandonment rate
 *   - Abandoned carts by tour
 *
 * Query params: period (7d | 30d | 90d | 1y) — defaults to 30d
 */
exports.getCartAbandonment = catchAsync(async (req, res, next) => {
  const periodMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const days = periodMap[req.query.period] || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const [
    cartMetrics,
    cartByTour,
    dailyAbandonment,
  ] = await Promise.all([

    // Cart-level metrics
    prisma.$queryRaw`
      WITH cart_users AS (
        SELECT DISTINCT "userId"
        FROM "Event"
        WHERE "name" = 'cart.added'
          AND "createdAt" >= ${startDate}
          AND "userId" IS NOT NULL
      ),
      booking_users AS (
        SELECT DISTINCT e."userId"
        FROM "Event" e
        JOIN cart_users c ON c."userId" = e."userId"
        WHERE e."name" = 'booking.completed'
          AND e."createdAt" >= ${startDate}
      )
      SELECT
        (SELECT COUNT(*) FROM cart_users)::int               AS "cartsCreated",
        (SELECT COUNT(*) FROM booking_users)::int             AS "cartsConverted",
        ROUND(
          (1 - (SELECT COUNT(*)::numeric FROM booking_users)
                / NULLIF((SELECT COUNT(*)::numeric FROM cart_users), 0))
          * 100, 1
        ) AS "abandonmentRate"
    `,

    // Abandonment by tour (which tours get abandoned most?)
    prisma.$queryRaw`
      WITH cart_tour AS (
        SELECT DISTINCT ON ("userId", "resourceId")
          "userId",
          "resourceId" AS tour_id,
          "createdAt" AS cart_time
        FROM "Event"
        WHERE "name" = 'cart.added'
          AND "createdAt" >= ${startDate}
          AND "userId" IS NOT NULL
          AND "resourceId" IS NOT NULL
        ORDER BY "userId", "resourceId", "createdAt" DESC
      ),
      booked_tour AS (
        SELECT DISTINCT "userId", "properties"->>'tourId' AS tour_id
        FROM "Event"
        WHERE "name" = 'booking.completed'
          AND "createdAt" >= ${startDate}
      )
      SELECT
        ct.tour_id AS "tourId",
        COUNT(*)::int AS "cartsAdded",
        COUNT(*) FILTER (WHERE bt."userId" IS NOT NULL)::int AS "converted"
      FROM cart_tour ct
      LEFT JOIN booked_tour bt ON bt."userId" = ct."userId" AND bt.tour_id = ct.tour_id
      GROUP BY ct.tour_id
      ORDER BY "cartsAdded" DESC
      LIMIT 20
    `,

    // Daily abandonment chart
    prisma.$queryRaw`
      WITH daily_carts AS (
        SELECT
          DATE_TRUNC('day', "createdAt")::date AS day,
          COUNT(DISTINCT "userId")::int AS cart_users
        FROM "Event"
        WHERE "name" = 'cart.added'
          AND "createdAt" >= ${startDate}
        GROUP BY DATE_TRUNC('day', "createdAt")
      ),
      daily_converted AS (
        SELECT
          DATE_TRUNC('day', e."createdAt")::date AS day,
          COUNT(DISTINCT e."userId")::int AS converted_users
        FROM "Event" e
        JOIN daily_carts dc ON dc.day = DATE_TRUNC('day', e."createdAt")
        WHERE e."name" = 'booking.completed'
          AND e."createdAt" >= ${startDate}
        GROUP BY DATE_TRUNC('day', e."createdAt")
      )
      SELECT
        dc.day,
        dc.cart_users AS "cartsAdded",
        COALESCE(dcv.converted_users, 0)::int AS "converted",
        ROUND(
          (1 - COALESCE(dcv.converted_users, 0)::numeric
                / NULLIF(dc.cart_users, 0))
          * 100, 1
        ) AS "abandonmentRate"
      FROM daily_carts dc
      LEFT JOIN daily_converted dcv ON dcv.day = dc.day
      ORDER BY dc.day ASC
    `,
  ]);

  // Enrich top abandoned tours with titles
  const tourIds = cartByTour.map((c) => c.tourId).filter(Boolean);
  let tourMap = {};
  if (tourIds.length > 0) {
    const tours = await prisma.tour.findMany({
      where: { id: { in: tourIds } },
      select: { id: true, title: true },
    });

    tourMap = Object.fromEntries(tours.map((t) => [t.id, t.title]));
  }

  res.status(200).json({
    status: 'success',
    data: {
      period: `${days}d`,
      overview: {
        cartsCreated: cartMetrics[0].cartsCreated,
        cartsConverted: cartMetrics[0].cartsConverted,
        abandonmentRate: parseFloat(cartMetrics[0].abandonmentRate || 0),
      },
      byTour: cartByTour.map((c) => ({
        tourId: c.tourId,
        tourTitle: tourMap[c.tourId] || 'Unknown',
        cartsAdded: c.cartsAdded,
        converted: c.converted,
        abandonmentRate: c.cartsAdded > 0
          ? parseFloat((((c.cartsAdded - c.converted) / c.cartsAdded) * 100).toFixed(1))
          : 0,
      })),
      dailyTrend: dailyAbandonment.map((d) => ({
        day: d.day,
        cartsAdded: d.cartsAdded,
        converted: d.converted,
        abandonmentRate: parseFloat(d.abandonmentRate || 0),
      })),
    },
  });
});

/**
 * Get list of users who signed up in the last 30 days
 */
exports.getRecentSignups = catchAsync(async (req, res, next) => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: {
      createdAt: { gte: thirtyDaysAgo },
    },
    select: {
      id: true,
      name: true,
      email: true,
      photoURL: true,
      roles: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.status(200).json({
    status: 'success',
    data: { users },
  });
});

/**
 * Get list of recently active users (last 30 days)
 */
exports.getActiveUsers = catchAsync(async (req, res, next) => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: {
      lastLoginAt: { gte: thirtyDaysAgo },
      active: true,
    },
    select: {
      id: true,
      name: true,
      email: true,
      photoURL: true,
      roles: true,
      lastLoginAt: true,
    },
    orderBy: { lastLoginAt: 'desc' },
  });

  res.status(200).json({
    status: 'success',
    data: { users },
  });
});

/**
 * GET /api/admin/bookings/today
 *
 * Returns today's bookings with customer, tour, and supplier details.
 */
exports.getTodayBookings = catchAsync(async (req, res, next) => {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const bookings = await prisma.booking.findMany({
    where: {
      createdAt: { gte: startOfDay, lt: endOfDay },
    },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      tour: {
        select: {
          id: true,
          title: true,
          supplier: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.status(200).json({
    status: 'success',
    data: { bookings },
  });
});
