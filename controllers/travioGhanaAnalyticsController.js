const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');

const CACHE_PREFIX = 'travioGhana:analytics:';
const cache = require('../utils/cacheHelper');

function dateRange(startDate, endDate, defaultDays = 30) {
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - defaultDays * 24 * 60 * 60 * 1000);
  return { start, end };
}

exports.getAnalyticsOverview = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  const { start, end } = dateRange(startDate, endDate);

  const cacheKey = `${CACHE_PREFIX}overview:${start.toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const [
      totalBookings,
      confirmedBookings,
      revenue,
      activeTours,
      totalCustomers,
      pendingPayouts,
    ] = await Promise.all([
      prisma.booking.count({
        where: { source: 'GHANA', createdAt: { gte: start, lte: end } },
      }),
      prisma.booking.count({
        where: { source: 'GHANA', status: 'CONFIRMED', createdAt: { gte: start, lte: end } },
      }),
      prisma.booking.aggregate({
        where: { source: 'GHANA', paymentStatus: 'SUCCEEDED', createdAt: { gte: start, lte: end } },
        _sum: { grossAmount: true },
      }),
      prisma.travioGhanaTour.count({ where: { isActive: true } }),
      prisma.booking.groupBy({
        by: ['customerId'],
        where: { source: 'GHANA', createdAt: { gte: start, lte: end } },
        _count: { customerId: true },
      }),
      prisma.payout.aggregate({
        where: {
          booking: { source: 'GHANA' },
          status: 'PENDING',
          createdAt: { gte: start, lte: end },
        },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalBookings,
      confirmedBookings,
      cancellationRate: totalBookings > 0
        ? parseFloat(((totalBookings - confirmedBookings) / totalBookings * 100).toFixed(1))
        : 0,
      totalRevenue: revenue._sum.grossAmount || 0,
      activeTours,
      uniqueCustomers: totalCustomers.length,
      pendingPayouts: pendingPayouts._sum.amount || 0,
    };
  }, 300);

  res.status(200).json({ status: 'success', data: result });
});

exports.getRevenueTrend = catchAsync(async (req, res, next) => {
  const { startDate, endDate, granularity = 'day' } = req.query;
  const { start, end } = dateRange(startDate, endDate);

  const cacheKey = `${CACHE_PREFIX}revenue:${start.toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}:${granularity}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const bookings = await prisma.booking.findMany({
      where: {
        source: 'GHANA',
        paymentStatus: 'SUCCEEDED',
        paidAt: { gte: start, lte: end },
      },
      select: { grossAmount: true, paidAt: true },
      orderBy: { paidAt: 'asc' },
    });

    const buckets = {};

    for (const b of bookings) {
      const d = new Date(b.paidAt);
      let key;
      if (granularity === 'month') {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      } else if (granularity === 'week') {
        const startOfYear = new Date(d.getFullYear(), 0, 1);
        const week = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
        key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
      } else {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      buckets[key] = (buckets[key] || 0) + parseFloat(b.grossAmount);
    }

    const trend = Object.entries(buckets).map(([date, revenue]) => ({ date, revenue: parseFloat(revenue.toFixed(2)) }));

    return {
      granularity,
      dataPoints: trend.length,
      trend,
      totalRevenue: trend.reduce((s, p) => s + p.revenue, 0),
    };
  }, 300);

  res.status(200).json({ status: 'success', data: result });
});

exports.getTourPerformance = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  const { start, end } = dateRange(startDate, endDate);

  const cacheKey = `${CACHE_PREFIX}tourPerf:${start.toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const bookings = await prisma.booking.groupBy({
      by: ['tourId'],
      where: { source: 'GHANA', createdAt: { gte: start, lte: end } },
      _count: { id: true },
      _sum: { grossAmount: true },
      orderBy: { _count: { id: 'desc' } },
    });

    const tourIds = bookings.map((b) => b.tourId);
    const tours = await prisma.tour.findMany({
      where: { id: { in: tourIds } },
      select: { id: true, title: true, slug: true, category: true, coverPhoto: true, averageRating: true },
    });

    const tourMap = Object.fromEntries(tours.map((t) => [t.id, t]));

    const performance = bookings.map((b) => {
      const t = tourMap[b.tourId] || {};
      return {
        tourId: b.tourId,
        title: t.title || 'Unknown',
        slug: t.slug || '',
        category: t.category || null,
        coverPhoto: t.coverPhoto || null,
        averageRating: t.averageRating || null,
        totalBookings: b._count.id,
        totalRevenue: parseFloat((b._sum.grossAmount || 0).toFixed(2)),
      };
    });

    return {
      total: performance.length,
      tours: performance,
    };
  }, 300);

  res.status(200).json({ status: 'success', data: result });
});

exports.getBookingAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  const { start, end } = dateRange(startDate, endDate);

  const cacheKey = `${CACHE_PREFIX}bookings:${start.toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const [statusBreakdown, dailyTrend] = await Promise.all([
      prisma.booking.groupBy({
        by: ['status'],
        where: { source: 'GHANA', createdAt: { gte: start, lte: end } },
        _count: { id: true },
      }),
      (async () => {
        const records = await prisma.booking.findMany({
          where: { source: 'GHANA', createdAt: { gte: start, lte: end } },
          select: { createdAt: true, grossAmount: true, status: true },
          orderBy: { createdAt: 'asc' },
        });

        const days = {};
        for (const r of records) {
          const day = r.createdAt.toISOString().slice(0, 10);
          if (!days[day]) days[day] = { date: day, bookings: 0, revenue: 0, completed: 0, cancelled: 0 };
          days[day].bookings += 1;
          days[day].revenue += parseFloat(r.grossAmount || 0);
          if (r.status === 'COMPLETED') days[day].completed += 1;
          if (r.status === 'CANCELLED') days[day].cancelled += 1;
        }

        return Object.values(days);
      })(),
    ]);

    return { statusBreakdown, dailyTrend };
  }, 300);

  res.status(200).json({ status: 'success', data: result });
});

exports.getConversionFunnel = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  const { start, end } = dateRange(startDate, endDate);

  const cacheKey = `${CACHE_PREFIX}funnel:${start.toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const [
      totalImpressions,
      tourViewEvents,
      checkoutCalculations,
      bookingAttempts,
      successfulBookings,
    ] = await Promise.all([
      prisma.trackedClick.aggregate({
        where: {
          source: 'ghana',
          createdAt: { gte: start, lte: end },
          event: { in: ['impression', 'tour_view', 'page_view'] },
        },
        _count: true,
      }),
      prisma.trackedClick.count({
        where: {
          source: 'ghana',
          createdAt: { gte: start, lte: end },
          event: 'tour_view',
        },
      }),
      prisma.trackedClick.count({
        where: {
          source: 'ghana',
          createdAt: { gte: start, lte: end },
          event: 'checkout_calculate',
        },
      }),
      prisma.booking.count({
        where: { source: 'GHANA', createdAt: { gte: start, lte: end } },
      }),
      prisma.booking.count({
        where: { source: 'GHANA', status: 'CONFIRMED', createdAt: { gte: start, lte: end } },
      }),
    ]);

    const funnel = [
      { stage: 'impressions', count: totalImpressions._count || 0 },
      { stage: 'tour_views', count: tourViewEvents },
      { stage: 'checkout_starts', count: checkoutCalculations },
      { stage: 'booking_attempts', count: bookingAttempts },
      { stage: 'confirmed_bookings', count: successfulBookings },
    ];

    const rates = [];
    for (let i = 1; i < funnel.length; i++) {
      const from = funnel[i - 1].count;
      rates.push({
        from: funnel[i - 1].stage,
        to: funnel[i].stage,
        rate: from > 0 ? parseFloat(((funnel[i].count / from) * 100).toFixed(1)) : 0,
      });
    }

    return { funnel, conversionRates: rates };
  }, 300);

  res.status(200).json({ status: 'success', data: result });
});

exports.getCustomerAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  const { start, end } = dateRange(startDate, endDate);

  const cacheKey = `${CACHE_PREFIX}customers:${start.toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const bookings = await prisma.booking.findMany({
      where: { source: 'GHANA', createdAt: { gte: start, lte: end } },
      select: { customerId: true, grossAmount: true, createdAt: true },
    });

    const customerMap = new Map();
    for (const b of bookings) {
      if (!customerMap.has(b.customerId)) {
        customerMap.set(b.customerId, { bookings: 0, totalSpent: 0, firstBooking: b.createdAt, lastBooking: b.createdAt });
      }
      const c = customerMap.get(b.customerId);
      c.bookings += 1;
      c.totalSpent += parseFloat(b.grossAmount || 0);
      if (b.createdAt < c.firstBooking) c.firstBooking = b.createdAt;
      if (b.createdAt > c.lastBooking) c.lastBooking = b.createdAt;
    }

    const customers = Array.from(customerMap.values());
    const totalCustomers = customers.length;
    const repeatCustomers = customers.filter((c) => c.bookings > 1).length;
    const avgOrderValue = customers.length > 0
      ? parseFloat((customers.reduce((s, c) => s + c.totalSpent, 0) / customers.reduce((s, c) => s + c.bookings, 0)).toFixed(2))
      : 0;

    // CLV: average total spent per customer
    const customerLifetimeValue = totalCustomers > 0
      ? parseFloat((customers.reduce((s, c) => s + c.totalSpent, 0) / totalCustomers).toFixed(2))
      : 0;

    return {
      totalCustomers,
      repeatCustomers,
      repeatRate: totalCustomers > 0 ? parseFloat(((repeatCustomers / totalCustomers) * 100).toFixed(1)) : 0,
      averageOrderValue: avgOrderValue,
      customerLifetimeValue,
    };
  }, 300);

  res.status(200).json({ status: 'success', data: result });
});

exports.getCartAbandonment = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  const { start, end } = dateRange(startDate, endDate);

  const cacheKey = `${CACHE_PREFIX}cartAbandon:${start.toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const [cartItems, successfulCheckouts] = await Promise.all([
      prisma.cartItem.findMany({
        where: { createdAt: { gte: start, lte: end } },
        select: { createdAt: true, expiresAt: true },
      }),
      prisma.booking.count({
        where: { source: 'GHANA', createdAt: { gte: start, lte: end } },
      }),
    ]);

    const totalCartItems = cartItems.length;

    return {
      totalCartCreations: totalCartItems,
      successfulCheckouts,
      abandonmentRate: totalCartItems > 0
        ? parseFloat((((totalCartItems - successfulCheckouts) / totalCartItems) * 100).toFixed(1))
        : 0,
    };
  }, 300);

  res.status(200).json({ status: 'success', data: result });
});

exports.getSearchAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  const { start, end } = dateRange(startDate, endDate);

  const cacheKey = `${CACHE_PREFIX}search:${start.toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const clicks = await prisma.trackedClick.findMany({
      where: {
        source: 'ghana',
        createdAt: { gte: start, lte: end },
        event: { in: ['search', 'search_result_click'] },
      },
      select: { event: true, target: true, createdAt: true },
    });

    const searchCount = clicks.filter((c) => c.event === 'search').length;
    const clickCount = clicks.filter((c) => c.event === 'search_result_click').length;

    // Top search terms from target field
    const termMap = new Map();
    for (const c of clicks) {
      if (c.target) {
        termMap.set(c.target, (termMap.get(c.target) || 0) + 1);
      }
    }

    const topSearches = Array.from(termMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([term, count]) => ({ term, count }));

    return {
      totalSearches: searchCount,
      resultClicks: clickCount,
      clickThroughRate: searchCount > 0 ? parseFloat(((clickCount / searchCount) * 100).toFixed(1)) : 0,
      topSearches,
    };
  }, 300);

  res.status(200).json({ status: 'success', data: result });
});
