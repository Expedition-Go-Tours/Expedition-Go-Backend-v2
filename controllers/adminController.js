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

const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const cache = require('../utils/cacheHelper');
const { logActivity } = require('../utils/auditLogger');
const { enqueueNotification } = require('../utils/queue');
const adminNotifService = require('../utils/adminNotificationService');
const { buildTourDiff, computeChangesSummary, mergeDraftContent, buildLiveUpdateData } = require('../utils/tourDraft');
const { deleteCloudinaryImage } = require('../utils/cloudinaryHelper');

function buildAuditMessage(action, resource, metadata = {}) {
  if (action.startsWith('webhook.')) {
    const eventType = action.replace(/^webhook\.(stripe|test)\.?/, '');
    const isError = action.includes('.error');
    const prefix = action.includes('test.') ? 'Test webhook' : 'Webhook';
    const suffix = isError ? ' — error' : '';
    return `${prefix} received — ${eventType}${suffix}`;
  }

  const messages = {
    'auth.login': () => {
      const methods = { local: 'email/password', google: 'Google', google_onetap: 'Google One Tap' };
      const method = methods[metadata.method] || metadata.method || 'unknown';
      return metadata.success === false
        ? `Failed login via ${method}${metadata.reason ? ` — ${metadata.reason.replace(/_/g, ' ')}` : ''}`
        : `Login via ${method}`;
    },
    'auth.password_changed': () => 'Password changed',
    'auth.password_reset_requested': () => 'Password reset requested',
    'auth.password_reset_completed': () => 'Password reset completed',
    'booking.created': () => {
      const tour = metadata.tourTitle || '';
      const price = metadata.total ? `${metadata.currency || '$'}${metadata.total}` : '';
      const details = [tour, price].filter(Boolean).join(' ');
      return details ? `Booking created — ${details}` : 'Booking created';
    },
    'booking.cancelled': () => 'Booking cancelled',
    'booking.status_updated': () => 'Booking status updated',
    'booking.payment_confirmed': () => {
      const ref = metadata.reference ? ` (Ref: ${metadata.reference})` : '';
      return `Payment confirmed${ref}`;
    },
    'tour.created': () => 'Tour created',
    'tour.updated': () => 'Tour updated',
    'tour.deleted': () => 'Tour deleted',
    'tour.photo.deleted': () => 'Tour photo removed',
    'tour.seeded': () => 'Tours imported from file',
    'review.created': () => 'Review submitted',
    'review.updated': () => 'Review updated',
    'review.deleted': () => 'Review deleted',
    'review.response_added': () => 'Response added to review',
    'review.response_updated': () => 'Response updated on review',
    'review.response_deleted': () => 'Response removed from review',
    'review.approve': () => 'Review approved',
    'review.reject': () => 'Review rejected',
    'review.flag': () => 'Review flagged',
    'review.admin_updated': () => 'Review updated by admin',
    'review.admin_deleted': () => 'Review removed by admin',
    'review.admin_response_updated': () => 'Review response updated by admin',
    'review.admin_response_deleted': () => 'Review response removed by admin',
    'payout.approved': () => 'Payout approved',
    'payout.released': () => 'Payout released',
    'payout.failed': () => 'Payout failed',
    'payout_method.added': () => 'Payout method added',
    'payout_method.updated': () => 'Payout method updated',
    'payout_method.deleted': () => 'Payout method removed',
    'payout_method.verified': () => 'Payout method verified',
    'payout_method.unverified': () => 'Payout method unverified',
    'supplier.applied': () => 'Supplier application received',
    'supplier.approve': () => 'Supplier approved',
    'supplier.reject': () => 'Supplier rejected',
    'supplier.suspended': () => 'Supplier suspended',
    'supplier.reactivated': () => 'Supplier reactivated',
    'supplier.activated': () => 'Supplier activated',
    'special-offer.created': () => 'Special offer created',
    'special-offer.updated': () => 'Special offer updated',
    'special-offer.deleted': () => 'Special offer removed',
    'special-offer.toggled': () => 'Special offer toggled',
    'team.member_added': () => 'Team member added',
    'team.invite_sent': () => 'Team invite sent',
    'team.invite_accepted': () => 'Team invite accepted',
    'team.invite_declined': () => 'Team invite declined',
    'team.invite_resend': () => 'Team invite resent',
    'team.invite_revoked': () => 'Team invite revoked',
    'team.member_removed': () => 'Team member removed',
    'team.role_changed': () => 'Team role changed',
    'user.profile_updated': () => 'Profile updated',
    'user.account_deleted': () => 'Account deleted',
    'user.deleted_by_admin': () => 'User account deleted by admin',
    'user.wishlist_added': () => 'Wishlist item added',
    'user.wishlist_removed': () => 'Wishlist item removed',
    'user.like_added': () => 'Tour liked',
    'user.like_removed': () => 'Tour unliked',
    'settings.updated': () => 'System settings updated',
    'admin_role.created': () => 'Admin role created',
    'admin_role.updated': () => 'Admin role updated',
    'admin_role.deleted': () => 'Admin role deleted',
    'admin.granted': () => 'Admin privileges granted',
    'admin.role_changed': () => 'Admin role changed',
    'admin.revoked': () => 'Admin privileges revoked',
    'system.cache_cleared': () => 'Application cache cleared',
  };

  const builder = messages[action];
  if (builder) return builder();

  return action.replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

exports.buildAuditMessage = buildAuditMessage;

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
  const period = req.query.period || 'today';
  const periodMap = { today: 0, last_week: 7, last_month: 30, last_quarter: 90 };
  const periodDays = periodMap[period] ?? 7;

  const now = new Date();
  const bucket = Math.floor(now.getTime() / 120000);
  const cacheKey = `admin:overview:${bucket}:${periodDays}`;

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

  // Earliest boundary across all windows — bounds the scans without missing any period
  const scanStart = new Date(Math.min(
    currentPeriodStart.getTime(),
    previousPeriodStart.getTime(),
    weekStart.getTime(),
    monthStart.getTime(),
    yearStart.getTime(),
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

    /* Revenue + booking volume in a single scan (FILTER aggregation) */
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
      WHERE "createdAt" >= ${scanStart} OR "paidAt" >= ${scanStart}
    `,

    /* Signups, active users and total events in a single scan (FILTER aggregation) */
    prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE "createdAt" >= ${currentPeriodStart})::int AS "signupsToday",
        COUNT(*) FILTER (WHERE "createdAt" >= ${previousPeriodStart} AND "createdAt" < ${currentPeriodStart})::int AS "signupsYesterday",
        COUNT(*) FILTER (WHERE "createdAt" >= ${weekStart})::int AS "signupsWeek",
        COUNT(*) FILTER (WHERE "createdAt" >= ${monthStart})::int AS "signupsMonth",
        COUNT(*) FILTER (WHERE "createdAt" >= ${yearStart})::int AS "signupsYtd",
        COUNT(*) FILTER (WHERE "lastLoginAt" >= ${currentPeriodStart} AND "active" = true)::int AS "activeToday",
        COUNT(*) FILTER (WHERE "lastLoginAt" >= ${previousPeriodStart} AND "lastLoginAt" < ${currentPeriodStart} AND "active" = true)::int AS "activePrevious",
        (SELECT COUNT(*) FROM "Event")::int AS "totalEvents"
      FROM "User"
      WHERE "createdAt" >= ${scanStart} OR "lastLoginAt" >= ${scanStart}
    `,

    /* Weekly booking volume (period-aware: daily for ≤30d, weekly for 90d) */
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
            WHERE "createdAt" >= CURRENT_DATE - (${periodDays - 1} || ' days')::interval
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
            WHERE "createdAt" >= CURRENT_DATE - (${Math.min(periodDays || 7, 30) - 1} || ' days')::interval
            GROUP BY "createdAt"::date
          ) b ON d.date = b.date
          ORDER BY d.date ASC
        `,

    /* Top 10 tours by period revenue (confirmed bookings) */
    prisma.$queryRaw`
      SELECT
        t.id,
        t.title,
        t."coverPhoto",
        COALESCE(b.booking_count, 0)::int AS "totalBookings",
        COALESCE(b.total_revenue, 0)::float AS "totalRevenue",
        t."averageRating",
        COALESCE(r.review_count, 0)::int AS "reviewCount"
      FROM "Tour" t
      LEFT JOIN (
        SELECT "tourId", COUNT(*)::int AS booking_count, SUM(total)::float AS total_revenue
        FROM "Booking"
        WHERE "paymentStatus" = 'SUCCEEDED' AND "createdAt" >= ${currentPeriodStart}
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

    /* Top 10 suppliers by period earnings */
    prisma.$queryRaw`
      SELECT
        u.id,
        u.name,
        u.email,
        u."photoURL",
        COALESCE(period.total_earnings, 0)::float AS "totalEarnings",
        COALESCE(period.booking_count, 0)::int AS "totalBookings",
        sp."averageRating"
      FROM "SupplierProfile" sp
      JOIN "User" u ON u.id = sp."userId"
      LEFT JOIN (
        SELECT t."supplierId",
               COUNT(*)::int AS booking_count,
               SUM(bo."supplierPayout")::float AS total_earnings
        FROM "Booking" bo
        JOIN "Tour" t ON t.id = bo."tourId"
        WHERE bo."paymentStatus" = 'SUCCEEDED' AND bo."createdAt" >= ${currentPeriodStart}
        GROUP BY t."supplierId"
      ) period ON period."supplierId" = u.id
      WHERE sp.status = 'ACTIVE'
      ORDER BY COALESCE(period.total_earnings, 0) DESC
      LIMIT 10
    `,

    /* Booking status distribution (filtered by period) */
    prisma.booking.groupBy({
      by: ['status'],
      _count: true,
      where: { createdAt: { gte: currentPeriodStart } },
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

    /* Recent admin audit logs (last 20) */
    prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        userId: true,
        userEmail: true,
        action: true,
        resource: true,
        resourceId: true,
        metadata: true,
        createdAt: true,
      },
    }),
  ]);

  // Batch-fetch only the users that appear in the event feed (not ALL users)
  const eventUserIds = [...new Set([
    ...recentEvents.map((e) => e.userId).filter(Boolean),
    ...recentAuditLogs.map((a) => a.userId).filter(Boolean),
  ])];
  const allUsers = eventUserIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: eventUserIds } },
        select: { id: true, name: true },
      })
    : [];

  const bAgg = bookingAgg[0] || {};
  const uAgg = userAgg[0] || {};

  const round2 = (v) => Math.round(parseFloat(v || 0) * 100) / 100;
  const fmt = (prefix) => ({
    revenue:        round2(bAgg[`${prefix}Revenue`]),
    supplierPayout: round2(bAgg[`${prefix}Payout`]),
    commission:     round2(bAgg[`${prefix}Commission`]),
  });
  const num = (v) => parseInt(v, 10) || 0;

  const data = {
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
      bookingStatusDistribution: bookingStatusDist.map((b) => ({
        status: b.status,
        count:  b._count,
      })),
      eventFeed: [
        ...recentEvents.map((e) => ({ ...e })),
        ...recentAuditLogs.map((a) => ({
          id: a.id,
          name: a.action,
          userId: a.userId,
          resource: a.resource,
          resourceId: a.resourceId,
          properties: {
            message: buildAuditMessage(a.action, a.resource, (a.metadata || {})),
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

  return data;
  }, 120); // Cache for 2 minutes

  res.status(200).json(result);
});

/**
 * GET /api/admin/analytics/revenue-trend
 *
 * Monthly revenue breakdown for charting (last 24 months).
 * Returns revenue, bookings, and commission per month.
 */
exports.getRevenueTrend = catchAsync(async (req, res, next) => {
  const bucket = Math.floor(Date.now() / 300000);
  const months = await cache.getOrSet(`admin:revenueTrend:${bucket}`, async () => {
    return prisma.$queryRaw`
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
  }, 300);

  res.status(200).json({ status: 'success', data: { months } });
});

/**
 * GET /api/admin/analytics/user-growth
 *
 * New user signups per month (last 24 months).
 * Broken down by role so we can see customer vs. supplier growth.
 */
exports.getUserGrowth = catchAsync(async (req, res, next) => {
  const bucket = Math.floor(Date.now() / 300000);
  const growth = await cache.getOrSet(`admin:userGrowth:${bucket}`, async () => {
    return prisma.$queryRaw`
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
  }, 300);

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
    search,
    page = 1,
    limit = 20,
    sortBy = 'totalRevenue',
    sortOrder = 'desc',
  } = req.query;

  const allowedSorts = ['totalRevenue', 'totalBookings', 'averageRating', 'viewCount', 'createdAt'];
  const field = allowedSorts.includes(sortBy) ? sortBy : 'totalRevenue';
  const order = sortOrder === 'asc' ? 'asc' : 'desc';

  const filterStatus = status && status !== 'all' ? status.toUpperCase() : undefined;
  // ARCHIVED is a soft-delete: deleted tours must never appear in the default
  // view or KPI totals. Admins can still audit them via the explicit
  // status=ARCHIVED filter, which bypasses this exclusion.
  const where = filterStatus
    ? { status: filterStatus }
    : { status: { not: 'ARCHIVED' } };
  // category filtering via JSON is expensive at scale; accept this for now.
  if (category) {
    where.categorization = { path: ['category'], equals: category };
  }
  // Search must run server-side: the admin table only fetches one page
  // (sorted by revenue), so a client-side filter over rawTours would hide
  // any tour that is not already on the page.
  if (search && search.trim()) {
    const term = search.trim();
    where.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { supplier: { name: { contains: term, mode: 'insensitive' } } },
    ];
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
        expeditionTour: { select: { isActive: true, bookingFlow: true, externalUrl: true } },
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

  const bucket = Math.floor(Date.now() / 300000);
  const result = await cache.getOrSet(`admin:funnel:${bucket}:${days}`, async () => {
    const [viewed, cartAdded, checkoutStarted, completed, stepData] = await Promise.all([

  // Each query counts unique userIds who performed the event at least once in the period.
  // This is the true "user funnel" — a single user may be counted at most once per step.
      prisma.event.groupBy({
        by: ['userId'],
        where: { name: 'tour.viewed', createdAt: { gte: startDate }, userId: { not: null } },
        _count: true,
      }),

      prisma.event.groupBy({
        by: ['userId'],
        where: { name: 'cart.added', createdAt: { gte: startDate }, userId: { not: null } },
        _count: true,
      }),

      prisma.event.groupBy({
        by: ['userId'],
        where: { name: 'booking.initiated', createdAt: { gte: startDate }, userId: { not: null } },
        _count: true,
      }),

      prisma.event.groupBy({
        by: ['userId'],
        where: { name: 'booking.completed', createdAt: { gte: startDate }, userId: { not: null } },
        _count: true,
      }),

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

    return {
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
    };
  });

  res.status(200).json({ status: 'success', data: result });
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

  const bucket = Math.floor(Date.now() / 300000);
  const data = await cache.getOrSet(`admin:clv:${bucket}`, async () => {
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

    return {
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
    };
  });

  res.status(200).json({ status: 'success', data });
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
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const users = await prisma.user.findMany({
    where: {
      createdAt: { gte: todayStart },
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

exports.searchUsers = catchAsync(async (req, res) => {
  const { q = "", role } = req.query;

  const where = {
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ],
  };

  if (role) {
    where.roles = { has: role };
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, email: true, photoURL: true, roles: true },
    take: 20,
  });

  const optimized = users.map((u) => ({
    ...u,
    photoURL: u.photoURL,
  }));

  res.status(200).json({ status: 'success', data: { users: optimized } });
});

exports.getUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      photoURL: true,
      phone: true,
      roles: true,
      active: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  const [bookings, reviewStats, recentReviews] = await Promise.all([
    prisma.booking.findMany({
      where: { customerId: id },
      select: {
        id: true,
        bookingNumber: true,
        status: true,
        selectedDate: true,
        total: true,
        currency: true,
        createdAt: true,
        tour: {
          select: {
            id: true,
            title: true,
            coverPhoto: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.review.aggregate({
      where: { customerId: id },
      _count: { id: true },
      _avg: { rating: true },
    }),
    prisma.review.findMany({
      where: { customerId: id },
      select: {
        id: true,
        rating: true,
        title: true,
        comment: true,
        status: true,
        createdAt: true,
        tour: {
          select: { id: true, title: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      user: {
        ...user,
        photoURL: user.photoURL,
      },
      bookings: bookings.map((b) => ({
        ...b,
        tour: b.tour
          ? { ...b.tour, coverPhoto: b.tour.coverPhoto }
          : null,
      })),
      reviewStats: {
        totalReviews: reviewStats._count.id,
        averageRating: reviewStats._avg.rating
          ? Math.round(reviewStats._avg.rating * 10) / 10
          : null,
      },
      recentReviews,
    },
  });
});

exports.getMe = catchAsync(async (req, res, next) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      photoURL: true,
      roles: true,
      adminRoleId: true,
      adminRole: {
        select: { id: true, name: true },
      },
    },
  });

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
      photoURL: user.photoURL,
      adminRole: user.adminRole
        ? { ...user.adminRole, permissions }
        : null,
    },
  });
});

/**
 * GET /api/admin/bookings
 *
 * Returns paginated bookings with optional status filter, search, and date range.
 */
exports.getBookings = catchAsync(async (req, res) => {
  const { page = '1', limit = '20', status = '', search = '', startDate, endDate, supplierId } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const where = {};

  if (status) {
    where.status = status;
  }

  if (search) {
    const q = search.trim();
    where.OR = [
      { bookingNumber: { contains: q, mode: 'insensitive' } },
      { customer: { name: { contains: q, mode: 'insensitive' } } },
      { tour: { title: { contains: q, mode: 'insensitive' } } },
      { tour: { supplier: { name: { contains: q, mode: 'insensitive' } } } },
    ];
  }

  if (supplierId) {
    where.tour = { ...(where.tour || {}), supplierId };
  }

  if (startDate || endDate) {
    where.selectedDate = {};
    if (startDate) where.selectedDate.gte = new Date(startDate);
    if (endDate) where.selectedDate.lte = new Date(endDate);
  }

  const [bookings, totalCount, counts] = await Promise.all([
    prisma.booking.findMany({
      where,
      select: {
        id: true,
        bookingNumber: true,
        status: true,
        paymentStatus: true,
        total: true,
        currency: true,
        selectedDate: true,
        subtotal: true,
        taxes: true,
        fees: true,
        discounts: true,
        commissionRate: true,
        commissionAmount: true,
        supplierPayout: true,
        travelers: true,
        specialRequests: true,
        cancellationReason: true,
        paidAt: true,
        createdAt: true,
        updatedAt: true,
        customer: {
          select: { id: true, name: true, email: true, photoURL: true, phone: true },
        },
        tour: {
          select: {
            id: true,
            title: true,
            coverPhoto: true,
            supplier: { select: { id: true, name: true } },
          },
        },
        payouts: {
          select: { id: true, amount: true, currency: true, status: true, paidAt: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
    }),
    prisma.booking.count({ where }),
    prisma.booking.groupBy({
      by: ['status'],
      _count: { id: true },
    }),
  ]);

  const countsMap = { total: totalCount };
  counts.forEach((c) => { countsMap[c.status] = c._count.id; });

  const optimized = bookings.map((b) => ({
    ...b,
    total: Number(b.total),
    subtotal: Number(b.subtotal),
    taxes: Number(b.taxes),
    fees: Number(b.fees),
    discounts: Number(b.discounts),
    commissionAmount: Number(b.commissionAmount),
    supplierPayout: Number(b.supplierPayout),
    customer: {
      ...b.customer,
      photoURL: b.customer.photoURL || null,
    },
    payouts: b.payouts.map((p) => ({ ...p, amount: Number(p.amount) })),
  }));

  res.status(200).json({
    status: 'success',
    data: {
      bookings: optimized,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalCount / limitNum),
        totalCount,
      },
      counts: countsMap,
    },
  });
});

/**
 * GET /api/admin/bookings/:id
 *
 * Returns a single booking with full details.
 */
exports.getBookingById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      paymentStatus: true,
      total: true,
      currency: true,
      selectedDate: true,
      selectedTime: true,
      subtotal: true,
      taxes: true,
      fees: true,
      discounts: true,
      commissionRate: true,
      commissionAmount: true,
      supplierPayout: true,
      travelers: true,
      specialRequests: true,
      cancellationReason: true,
      paidAt: true,
      createdAt: true,
      updatedAt: true,
      customer: {
        select: { id: true, name: true, email: true, photoURL: true, phone: true },
      },
      tour: {
        select: {
          id: true,
          title: true,
          coverPhoto: true,
          supplier: { select: { id: true, name: true } },
        },
      },
      payouts: {
        select: { id: true, amount: true, currency: true, status: true, paidAt: true, createdAt: true },
      },
    },
  });

  if (!booking) {
    return next(new AppError('Booking not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: {
      ...booking,
      total: Number(booking.total),
      subtotal: Number(booking.subtotal),
      taxes: Number(booking.taxes),
      fees: Number(booking.fees),
      discounts: Number(booking.discounts),
      commissionAmount: Number(booking.commissionAmount),
      supplierPayout: Number(booking.supplierPayout),
      customer: {
        ...booking.customer,
        photoURL: booking.customer.photoURL || null,
      },
      payouts: booking.payouts.map((p) => ({ ...p, amount: Number(p.amount) })),
    },
  });
});

/**
 * PATCH /api/admin/bookings/:id/confirm-payment
 *
 * Confirms payment for a booking. Updates paymentStatus to PAID and
 * optionally transitions booking status to CONFIRMED if currently PENDING.
 */
exports.confirmPayment = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reference } = req.body;

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { id: true, status: true, paymentStatus: true },
  });

  if (!booking) {
    return next(new AppError('Booking not found', 404));
  }

  if (booking.paymentStatus === 'PAID' || booking.paymentStatus === 'SUCCEEDED') {
    return next(new AppError('Payment has already been confirmed for this booking', 400));
  }

  const updateData = {
    paymentStatus: 'PAID',
    paidAt: new Date(),
  };

  if (booking.status === 'PENDING') {
    updateData.status = 'CONFIRMED';
  }

  if (reference) {
    updateData.supplierNotes = `Payment confirmed. Reference: ${reference}`;
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      paymentStatus: true,
      paidAt: true,
    },
  });

  logActivity({
    userId: req.user.id,
    userEmail: req.user.email,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    action: 'booking.payment_confirmed',
    resource: 'Booking',
    resourceId: id,
    metadata: {
      previousPaymentStatus: booking.paymentStatus,
      previousStatus: booking.status,
      newPaymentStatus: updated.paymentStatus,
      newStatus: updated.status,
      reference: reference || null,
    },
  });

  res.status(200).json({
    status: 'success',
    data: updated,
  });
});

// =============================================================================
// EXPEDITION GO — LISTING MANAGEMENT
// =============================================================================

/**
 * GET /api/admin/expedition/listings
 *
 * Returns all ExpeditionTour records with tour + supplier info.
 * Paginated, searchable, filterable by status and bookingFlow.
 */
exports.getExpeditionListings = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, status, bookingFlow, search } = req.query;

  const where = {};
  if (status === 'active') where.isActive = true;
  else if (status === 'inactive') where.isActive = false;
  if (bookingFlow) where.bookingFlow = bookingFlow;
  if (search) {
    where.tour = {
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
      ],
    };
  }

  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);

  const [records, totalCount] = await Promise.all([
    prisma.expeditionTour.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { displayOrder: 'asc' }],
      skip,
      take: Math.min(parseInt(limit), 50),
      include: {
        tour: {
          select: {
            id: true,
            title: true,
            slug: true,
            coverPhoto: true,
            category: true,
            status: true,
            createdAt: true,
            supplier: { select: { id: true, name: true, photoURL: true } },
          },
        },
        publishedBy: { select: { id: true, name: true, email: true } },
        unpublishedBy: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.expeditionTour.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      listings: records,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / Math.min(parseInt(limit), 50)),
        totalCount,
        limit: Math.min(parseInt(limit), 50),
      },
    },
  });
});

/**
 * PATCH /api/admin/tours/:tourId/expedition-publish
 *
 * Toggle a tour's Expedition Go listing.
 * Body: { isActive: boolean }
 * Auto-detects bookingFlow:
 *   - If the tour's supplier has 'expedition' role → DIRECT
 *   - Otherwise → EXTERNAL (with auto-generated externalUrl to TravioAfrica)
 */
exports.toggleExpeditionPublish = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const { isActive } = req.body;
  const adminId = req.user.id;

  if (typeof isActive !== 'boolean') {
    return next(new AppError('isActive must be a boolean', 400));
  }

  const tour = await prisma.tour.findUnique({
    where: { id: tourId },
    select: {
      id: true,
      slug: true,
      supplierId: true,
      supplier: { select: { roles: true } },
    },
  });
  if (!tour) return next(new AppError('Tour not found', 404));

  const existing = await prisma.expeditionTour.findUnique({ where: { tourId } });

  const data = {};
  if (isActive) {
    // Auto-detect booking flow based on supplier's roles
    const hasExpeditionRole = tour.supplier.roles.includes('expedition');
    data.bookingFlow = hasExpeditionRole ? 'DIRECT' : 'EXTERNAL';
    data.externalUrl = hasExpeditionRole
      ? null
      : `https://travioafrica.com/tours/${tour.slug}?ref=expedition`;

    data.publishedById = adminId;
    data.publishedAt = new Date();
    data.isActive = true;
  } else {
    data.isActive = false;
    data.unpublishedById = adminId;
    data.unpublishedAt = new Date();
    data.unpublishReason = req.body.reason || null;
  }

  // Preserve displayOrder and isFeatured on reactivation
  if (existing) {
    if (existing.displayOrder) data.displayOrder = existing.displayOrder;
    if (existing.isFeatured) data.isFeatured = existing.isFeatured;
  }

  const record = await prisma.expeditionTour.upsert({
    where: { tourId },
    create: {
      tourId,
      isActive: data.isActive ?? false,
      bookingFlow: data.bookingFlow ?? 'DIRECT',
      externalUrl: data.externalUrl ?? null,
      publishedById: data.publishedById ?? null,
      publishedAt: data.publishedAt ?? null,
      displayOrder: existing?.displayOrder ?? 0,
      isFeatured: existing?.isFeatured ?? false,
    },
    update: data,
    include: {
      tour: {
        select: {
          id: true,
          title: true,
          slug: true,
          coverPhoto: true,
          supplier: { select: { id: true, name: true } },
        },
      },
      publishedBy: { select: { id: true, name: true, email: true } },
      unpublishedBy: { select: { id: true, name: true, email: true } },
    },
  });

  logActivity({
    action: isActive ? 'expedition.tour.published' : 'expedition.tour.unpublished',
    userId: adminId,
    resource: 'ExpeditionTour',
    resourceId: record.id,
    metadata: {
      tourId,
      bookingFlow: record.bookingFlow,
      isActive: record.isActive,
    },
  });

  cache.invalidateTourCaches(tourId).catch((err) =>
    console.warn('[cache] invalidateTourCaches failed:', err?.message)
  );

  res.status(200).json({
    status: 'success',
    data: record,
  });
});

/**
 * PATCH /api/admin/expedition/bulk-publish
 *
 * Batch publish/unpublish multiple tours on Expedition Go.
 * Body: { operations: [{ tourId, isActive }] }
 */
exports.bulkExpeditionPublish = catchAsync(async (req, res, next) => {
  const { operations } = req.body;
  const adminId = req.user.id;

  if (!Array.isArray(operations) || operations.length === 0) {
    return next(new AppError('operations must be a non-empty array of { tourId, isActive }', 400));
  }

  if (operations.length > 50) {
    return next(new AppError('Maximum 50 operations per request', 400));
  }

  const results = [];
  const errors = [];

  for (const op of operations) {
    try {
      const tour = await prisma.tour.findUnique({
        where: { id: op.tourId },
        select: {
          id: true,
          slug: true,
          supplier: { select: { roles: true } },
        },
      });
      if (!tour) {
        errors.push({ tourId: op.tourId, error: 'Tour not found' });
        continue;
      }

      const existing = await prisma.expeditionTour.findUnique({ where: { tourId: op.tourId } });

      if (op.isActive) {
        const hasExpeditionRole = tour.supplier.roles.includes('expedition');
        const record = await prisma.expeditionTour.upsert({
          where: { tourId: op.tourId },
          create: {
            tourId: op.tourId,
            isActive: true,
            bookingFlow: hasExpeditionRole ? 'DIRECT' : 'EXTERNAL',
            externalUrl: hasExpeditionRole
              ? null
              : `https://travioafrica.com/tours/${tour.slug}?ref=expedition`,
            publishedById: adminId,
            publishedAt: new Date(),
          },
          update: {
            isActive: true,
            bookingFlow: hasExpeditionRole ? 'DIRECT' : 'EXTERNAL',
            externalUrl: hasExpeditionRole
              ? null
              : `https://travioafrica.com/tours/${tour.slug}?ref=expedition`,
            publishedById: adminId,
            publishedAt: new Date(),
            unpublishedById: null,
            unpublishedAt: null,
            unpublishReason: null,
          },
        });
        results.push(record);
      } else {
        const record = await prisma.expeditionTour.update({
          where: { tourId: op.tourId },
          data: {
            isActive: false,
            unpublishedById: adminId,
            unpublishedAt: new Date(),
            unpublishReason: op.reason || null,
          },
        });
        results.push(record);
      }
    } catch (err) {
      errors.push({ tourId: op.tourId, error: err.message });
    }
  }

  logActivity({
    action: 'expedition.bulk.publish',
    userId: adminId,
    resource: 'ExpeditionTour',
    metadata: { total: operations.length, succeeded: results.length, failed: errors.length },
  });

  // Invalidate tour caches for all affected tours
  const tourIds = operations.map((op) => op.tourId);
  Promise.allSettled(tourIds.map((tid) => cache.invalidateTourCaches(tid))).catch(() => {});

  res.status(200).json({
    status: 'success',
    data: { results, errors },
  });
});

/**
 * GET /api/admin/expedition/suppliers
 *
 * Returns all suppliers who have tours (optionally on Expedition Go),
 * with aggregate counts: total tours, tours on EG, active EG tours.
 * Useful for the Control Room supplier-level drill-down.
 */
exports.getExpeditionSuppliers = catchAsync(async (req, res) => {
  const { search } = req.query;

  const where = { roles: { has: 'supplier' } };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  const suppliers = await prisma.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      photoURL: true,
      _count: {
        select: {
          // ARCHIVED is a soft-delete: deleted tours must never count as
          // inventory or as "on Expedition" anywhere.
          tours: { where: { status: { not: 'ARCHIVED' } } },
        },
      },
      tours: {
        select: {
          expeditionTour: {
            select: { isActive: true, bookingFlow: true },
          },
        },
        where: {
          status: { not: 'ARCHIVED' },
          expeditionTour: { isNot: null },
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  const mapped = suppliers
    .map((s) => {
      const onExp = s.tours.length;
      const activeOnExp = s.tours.filter((t) => t.expeditionTour?.isActive).length;
      const directCount = s.tours.filter((t) => t.expeditionTour?.bookingFlow === 'DIRECT').length;
      return {
        id: s.id,
        name: s.name,
        email: s.email,
        photoURL: s.photoURL,
        totalTours: s._count.tours,
        onExpedition: onExp,
        activeOnExpedition: activeOnExp,
        directCount,
      };
    })
    .filter((s) => s.totalTours > 0);

  res.status(200).json({ status: 'success', data: { suppliers: mapped } });
});

/**
 * GET /api/admin/expedition/suppliers/:id/tours
 *
 * Returns all tours belonging to a specific supplier with their
 * ExpeditionTour status (if any). Used by Control Room's per-supplier view.
 */
exports.getExpeditionSupplierTours = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const statusFilter = req.query.status || 'active';

  const supplier = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, photoURL: true, email: true },
  });
  if (!supplier) return next(new AppError('Supplier not found', 404));

  const where = { supplierId: id };
  if (statusFilter === 'active') {
    where.status = { notIn: ['ARCHIVED'] };
  } else if (statusFilter !== 'all') {
    where.status = statusFilter.toUpperCase();
  }

  const tours = await prisma.tour.findMany({
    where,
    select: {
      id: true,
      title: true,
      slug: true,
      coverPhoto: true,
      status: true,
      category: true,
      totalBookings: true,
      averageRating: true,
      createdAt: true,
      expeditionTour: {
        select: {
          id: true,
          isActive: true,
          bookingFlow: true,
          externalUrl: true,
          isFeatured: true,
          displayOrder: true,
          syncStatus: true,
          lastSyncAt: true,
          syncError: true,
          publishedAt: true,
          publishedBy: { select: { id: true, name: true } },
          unpublishedAt: true,
          unpublishReason: true,
        },
      },
    },
    orderBy: [
      { status: 'asc' },
      { updatedAt: 'desc' },
    ],
  });

  res.status(200).json({
    status: 'success',
    data: { supplier, tours },
  });
});

// ================================
// TOUR MODERATION (Submit-for-Review)
// ================================

/**
 * GET /admin/tours/review
 * List tours in the moderation queue (pending / rejected / active) with
 * supplier info and submission metadata. Supports search + pagination.
 */
exports.getTourReviewQueue = catchAsync(async (req, res) => {
  const {
    status,
    page = 1,
    limit = 20,
    search,
  } = req.query;

  // Empty status means "show all pending" (the All tab) — both new
  // submissions awaiting review and live tours with pending edits.
  const requestedStatus = typeof status === 'string' ? status.trim() : '';

  const validStatuses = ['PENDING_APPROVAL', 'REJECTED', 'ACTIVE', 'PENDING_EDITS'];
  const searchOR = search && search.trim()
    ? [
        { title: { contains: search.trim(), mode: 'insensitive' } },
        { supplier: { name: { contains: search.trim(), mode: 'insensitive' } } },
      ]
    : null;

  const where = {};
  // Live-tour edits keep `status: ACTIVE` while the edit itself lives in
  // draftStatus — a tab must look at BOTH columns to see what it promised.
  if (requestedStatus === 'PENDING_EDITS') {
    where.draftStatus = 'PENDING_APPROVAL';
  } else if (requestedStatus === 'PENDING_APPROVAL') {
    const statusOR = [{ status: 'PENDING_APPROVAL' }, { draftStatus: 'PENDING_APPROVAL' }];
    if (searchOR) {
      where.AND = [{ OR: statusOR }, { OR: searchOR }];
    } else {
      where.OR = statusOR;
    }
  } else if (requestedStatus === 'REJECTED') {
    // New submissions are rejected via `status`, live-tour edits via
    // `draftStatus` — the tab must show both.
    const statusOR = [{ status: 'REJECTED' }, { draftStatus: 'REJECTED' }];
    if (searchOR) {
      where.AND = [{ OR: statusOR }, { OR: searchOR }];
    } else {
      where.OR = statusOR;
    }
  } else if (validStatuses.includes(requestedStatus)) {
    where.status = status;
    if (searchOR) {
      where.OR = searchOR;
    }
  } else {
    // Default "All" tab: only show pending items (new submissions + live-tour edits)
    const pendingOR = [{ status: 'PENDING_APPROVAL' }, { draftStatus: 'PENDING_APPROVAL' }];
    if (searchOR) {
      where.AND = [{ OR: pendingOR }, { OR: searchOR }];
    } else {
      where.OR = pendingOR;
    }
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [tours, totalCount, pendingCount, rejectedCount, pendingEditsCount] = await Promise.all([
    prisma.tour.findMany({
      where,
      orderBy: [
        { submittedAt: 'desc' },
        { draftSubmittedAt: 'desc' },
        { updatedAt: 'desc' },
      ],
      skip,
      take: parseInt(limit),
      include: {
        supplier: {
          select: { id: true, name: true, email: true, photoURL: true },
        },
        _count: {
          select: { bookings: true, reviews: true },
        },
      },
    }),
    prisma.tour.count({ where }),
    // Counts mirror each tab's semantics — pending includes live-tour edits,
    // and rejected includes rejected live-tour edits — so the stat cards
    // never disagree with the list below them.
    prisma.tour.count({ where: { OR: [{ status: 'PENDING_APPROVAL' }, { draftStatus: 'PENDING_APPROVAL' }] } }),
    prisma.tour.count({ where: { OR: [{ status: 'REJECTED' }, { draftStatus: 'REJECTED' }] } }),
    prisma.tour.count({ where: { draftStatus: 'PENDING_APPROVAL' } }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      tours,
      counts: { pending: pendingCount, rejected: rejectedCount, pendingEdits: pendingEditsCount },
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
 * GET /admin/tours/:id
 * Fetch a single tour for the admin dashboard regardless of its public status.
 * Mirrors the public tour-detail shape so the dashboard normalizer stays identical.
 * Does not apply the `status = 'ACTIVE'` filter and never counts a view.
 */
exports.getTourAdminDetail = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const tour = await prisma.tour.findFirst({
    where: { OR: [{ id }, { slug: id }] },
    include: {
      supplier: {
        select: {
          id: true,
          name: true,
          email: true,
          photoURL: true,
          supplierProfile: {
            select: {
              averageRating: true,
              totalBookings: true,
              businessInfo: true,
            },
          },
        },
      },
      reviews: {
        where: { status: 'APPROVED' },
        include: {
          customer: {
            select: { id: true, name: true, photoURL: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
      _count: {
        select: { reviews: true, bookings: true },
      },
      specialOfferTargets: {
        include: { specialOffer: true },
      },
      expeditionTour: true,
    },
  });

  if (!tour) return next(new AppError('Tour not found', 404));

  const specialOffers = (tour.specialOfferTargets || [])
    .map((t) => t.specialOffer)
    .filter(Boolean);

  res.status(200).json({
    status: 'success',
    data: {
      tour: {
        ...tour,
        photos: tour.photos,
        specialOffers,
        coverPhoto: tour.coverPhoto || null,
      },
    },
  });
});

/**
 * GET /admin/tours/:id/draft
 * Fetch the live version, the pending draft, and a sectioned diff for review.
 */
exports.getTourDraftReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const tour = await prisma.tour.findUnique({ where: { id } });
  if (!tour) {
    return next(new AppError('Tour not found', 404));
  }

  const live = {
    id: tour.id,
    title: tour.title,
    description: tour.description,
    photos: tour.photos || [],
    coverPhoto: tour.coverPhoto,
    tags: tour.tags || [],
    metaTitle: tour.metaTitle,
    metaDescription: tour.metaDescription,
    categorization: tour.categorization,
    theme: tour.theme,
    productContent: tour.productContent,
    schedulesAndPricing: tour.schedulesAndPricing,
    bookingAndTickets: tour.bookingAndTickets,
  };
  const draft = tour.draftContent && typeof tour.draftContent === 'object'
    ? mergeDraftContent(tour, tour.draftContent)
    : null;
  const diff = draft ? buildTourDiff(live, draft) : [];

  res.status(200).json({
    status: 'success',
    data: {
      tour: {
        id: tour.id,
        title: tour.title,
        status: tour.status,
        draftStatus: tour.draftStatus || null,
        draftSubmittedAt: tour.draftSubmittedAt || null,
        draftReviewNote: tour.draftReviewNote || null,
        supplier: tour.supplierId,
      },
      live,
      draft,
      diff,
      changesSummary: computeChangesSummary(diff),
    },
  });
});

/**
 * PATCH /admin/tours/:id/review
 * Approve or flag a tour that is awaiting approval.
 *  - approve → ACTIVE (live on storefront) + supplier notified
 *  - flag   → REJECTED (sent back with a reason) + supplier notified
 */
exports.reviewTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { action, reason } = req.body || {};
  const adminId = req.user.id;

  if (!['approve', 'flag'].includes(action)) {
    return next(new AppError('Action must be either "approve" or "flag"', 400));
  }
  if (action === 'flag' && (!reason || !String(reason).trim())) {
    return next(new AppError('A reason is required when flagging a tour', 400));
  }

  const tour = await prisma.tour.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      supplierId: true,
      supplier: { select: { id: true, name: true, email: true } },
    },
  });
  if (!tour) {
    return next(new AppError('Tour not found', 404));
  }
  if (tour.status !== 'PENDING_APPROVAL') {
    // Idempotency: a retry/double-click after the first decision is not an
    // error — the tour has simply already been reviewed.
    if (tour.status === 'ACTIVE' || tour.status === 'REJECTED') {
      return res.status(200).json({
        status: 'success',
        message: 'This tour has already been reviewed.',
        data: { alreadyProcessed: true, tour },
      });
    }
    return next(new AppError(`Only tours awaiting approval can be reviewed. Current status: ${tour.status}`, 400));
  }

  const now = new Date();
  const isApprove = action === 'approve';

  const updated = await prisma.tour.update({
    where: { id },
    data: isApprove
      ? { status: 'ACTIVE', reviewedBy: adminId, reviewedAt: now, reviewNote: null }
      : { status: 'REJECTED', reviewedBy: adminId, reviewedAt: now, reviewNote: String(reason).trim() },
    include: {
      supplier: { select: { id: true, name: true, photoURL: true } },
    },
  });

  // Invalidate with the slug so the expedition detail key (expedition:detail:${slug})
  // and the curated expedition list caches are cleared — the approval is only
  // visible once every cache layer reflects the new state.
  cache.invalidateTourCaches(id, updated.slug).catch((err) => console.warn('[Admin] invalidateTourCaches failed:', err?.message));

  await logActivity({
    userId: adminId,
    action: isApprove ? 'tour.approved' : 'tour.flagged',
    resource: 'Tour',
    resourceId: tour.id,
    metadata: { title: tour.title, reason: isApprove ? null : reason },
  });

  // Notify the supplier (in-app + realtime socket)
  enqueueNotification({
    userId: tour.supplierId,
    type: isApprove ? 'TOUR_APPROVED' : 'TOUR_FLAGGED',
    title: isApprove ? 'Tour Approved' : 'Tour Needs Changes',
    message: isApprove
      ? `"${tour.title}" has been approved and is now live on the platform.`
      : `"${tour.title}" was flagged for changes: ${String(reason).trim()}`,
    data: { tourId: tour.id, status: isApprove ? 'ACTIVE' : 'REJECTED', reason: isApprove ? null : reason },
  }).catch((err) => console.warn('[Admin] Supplier notification failed:', err?.message));

  // Push a refresh event to any other open admin consoles
  adminNotifService.emitToRoom('admin-room', {
    type: 'TOUR_REVIEW_RESOLVED',
    title: isApprove ? 'Tour Approved' : 'Tour Flagged',
    message: `"${tour.title}" was ${isApprove ? 'approved' : 'flagged'}`,
    data: { tourId: tour.id, action, status: isApprove ? 'ACTIVE' : 'REJECTED' },
  }).catch(() => {});

  res.status(200).json({
    status: 'success',
    message: isApprove ? 'Tour approved and is now live' : 'Tour flagged and returned to the supplier',
    data: { tour: updated },
  });
});

/**
 * PATCH /admin/tours/:id/draft-review
 * Approve or flag a pending edit to a LIVE tour.
 *  - approve → draft merged into the live columns (tour stays ACTIVE, no downtime) + supplier notified
 *  - flag   → draft marked REJECTED with a reason; live version untouched + supplier notified
 */
exports.reviewTourDraft = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { action, reason } = req.body || {};
  const adminId = req.user.id;

  if (!['approve', 'flag'].includes(action)) {
    return next(new AppError('Action must be either "approve" or "flag"', 400));
  }
  if (action === 'flag' && (!reason || !String(reason).trim())) {
    return next(new AppError('A reason is required when flagging a draft', 400));
  }

  const tour = await prisma.tour.findUnique({
    where: { id },
    include: { supplier: { select: { id: true, name: true, email: true } } },
  });
  if (!tour) {
    return next(new AppError('Tour not found', 404));
  }
  if (tour.draftStatus !== 'PENDING_APPROVAL') {
    // Idempotency: a retry/double-click after the first decision is not an
    // error — this draft has simply already been reviewed (null = approved
    // earlier, REJECTED = flagged earlier).
    if (tour.draftStatus === null || tour.draftStatus === 'REJECTED') {
      return res.status(200).json({
        status: 'success',
        message: 'This update has already been reviewed.',
        data: { alreadyProcessed: true, tour },
      });
    }
    return next(new AppError(`No draft awaiting approval. Current draft status: ${tour.draftStatus || 'none'}`, 400));
  }

  const now = new Date();
  const isApprove = action === 'approve';
  const normalize = (url) => {
    const m = url.match(/\/upload\/(?:w_\d+[^/]*\/)?(?:v\d+\/)?(.+)$/);
    return m ? m[1] : url;
  };

  if (isApprove) {
    const processed = await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRawUnsafe('SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE', id);
      if (!locked) {
        throw new AppError('Tour not found', 404);
      }
      const liveRow = await tx.tour.findUnique({ where: { id } });

      // Idempotency — a concurrent request may have already reviewed this draft
      // while we waited on the row lock. Never apply the same merge twice.
      if (liveRow.draftStatus !== 'PENDING_APPROVAL') {
        return { alreadyProcessed: true, tour: liveRow };
      }

      // Empty-draft guard — never report success when the update changes nothing.
      const draftSnapshot = mergeDraftContent(liveRow, tour.draftContent);
      const diff = buildTourDiff(liveRow, draftSnapshot);
      if (diff.length === 0) {
        throw new AppError('Cannot approve: the submitted update contains no changes', 400);
      }

      const updateData = await buildLiveUpdateData(tx, liveRow, tour.draftContent);

      const updated = await tx.tour.update({
        where: { id },
        data: {
          ...updateData,
          status: 'ACTIVE',
          reviewedBy: adminId,
          reviewedAt: now,
          reviewNote: null,
          draftContent: null,
          draftStatus: null,
          draftSubmittedAt: null,
          draftReviewedAt: now,
          draftReviewNote: null,
        },
        include: { supplier: { select: { id: true, name: true, photoURL: true } } },
      });

      return { alreadyProcessed: false, updated, oldSlug: liveRow.slug, newSlug: updated.slug };
    });

    if (processed.alreadyProcessed) {
      return res.status(200).json({
        status: 'success',
        message: 'This update has already been reviewed.',
        data: { alreadyProcessed: true, tour: processed.tour },
      });
    }

    const updated = processed.updated;

    const draftPhotos = (tour.draftContent.photos || []).map(normalize);
    const removedPhotos = (tour.photos || []).filter((url) => !draftPhotos.includes(normalize(url)));
    if (removedPhotos.length > 0) {
      await Promise.allSettled(removedPhotos.map((url) => deleteCloudinaryImage(url)));
    }

    // Invalidate BOTH slugs — approval regenerates the slug when the title
    // changes (buildLiveUpdateData → createSlug), and the old slug's
    // expedition:detail key must not linger for another 5 minutes.
    const slugs = [...new Set([processed.oldSlug, processed.newSlug].filter(Boolean))];
    for (const slug of slugs) {
      cache.invalidateTourCaches(id, slug).catch((err) => console.warn('[Admin] invalidateTourCaches failed:', err?.message));
    }

    await logActivity({
      userId: adminId,
      action: 'tour.draft_approved',
      resource: 'Tour',
      resourceId: tour.id,
      metadata: { title: tour.title },
    });

    enqueueNotification({
      userId: tour.supplierId,
      type: 'TOUR_APPROVED',
      title: 'Tour Update Approved',
      message: `Your update to "${tour.title}" has been approved and is now live.`,
      data: { tourId: tour.id, status: 'ACTIVE' },
    }).catch((err) => console.warn('[Admin] Supplier notification failed:', err?.message));

    adminNotifService.emitToRoom('admin-room', {
      type: 'TOUR_REVIEW_RESOLVED',
      title: 'Tour Update Approved',
      message: `"${tour.title}" update approved`,
      data: { tourId: tour.id, action, status: 'ACTIVE' },
    }).catch(() => {});

    return res.status(200).json({
      status: 'success',
      message: 'Tour update approved and applied to the live listing',
      data: { tour: updated },
    });
  }

  const flaggedResult = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRawUnsafe('SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE', id);
    if (!locked) {
      throw new AppError('Tour not found', 404);
    }
    const row = await tx.tour.findUnique({ where: { id } });
    if (row.draftStatus !== 'PENDING_APPROVAL') {
      return { alreadyProcessed: true, tour: row };
    }
    const updated = await tx.tour.update({
      where: { id },
      data: {
        draftStatus: 'REJECTED',
        draftReviewedAt: now,
        draftReviewNote: String(reason).trim(),
      },
    });
    return { alreadyProcessed: false, tour: updated };
  });

  if (flaggedResult.alreadyProcessed) {
    return res.status(200).json({
      status: 'success',
      message: 'This update has already been reviewed.',
      data: { alreadyProcessed: true, tour: flaggedResult.tour },
    });
  }

  const flagged = flaggedResult.tour;

  await logActivity({
    userId: adminId,
    action: 'tour.draft_flagged',
    resource: 'Tour',
    resourceId: tour.id,
    metadata: { title: tour.title, reason },
  });

  enqueueNotification({
    userId: tour.supplierId,
    type: 'TOUR_FLAGGED',
    title: 'Tour Update Needs Changes',
    message: `Your update to "${tour.title}" was flagged: ${String(reason).trim()}. The live tour is unchanged.`,
    data: { tourId: tour.id, status: 'REJECTED', reason: String(reason).trim() },
  }).catch((err) => console.warn('[Admin] Supplier notification failed:', err?.message));

  adminNotifService.emitToRoom('admin-room', {
    type: 'TOUR_REVIEW_RESOLVED',
    title: 'Tour Update Flagged',
    message: `"${tour.title}" update flagged`,
    data: { tourId: tour.id, action, status: 'REJECTED' },
  }).catch(() => {});

  res.status(200).json({
    status: 'success',
    message: 'Tour update flagged and returned to the supplier. The live tour is unchanged.',
    data: { tour: flagged },
  });
});
