/**
 * Stays analytics + reviews.
 *
 * Analytics are computed from StayBooking and StayProperty, so the supplier
 * dashboard has real numbers the moment the first manual/customer booking is
 * written. Reviews are supplier-facing read/reply endpoints; the customer
 * storefront (a separate project) is the writer.
 */

const prisma = require('../../core/services/prismaClient');
const AppError = require('../../core/services/appError');
const catchAsync = require('../../core/services/catchAsync');
const {
  supplierIdFor,
  objectOrEmpty,
  serializeStayReview,
  periodCutoff,
} = require('./staysShared');

const NON_CANCELLED = { notIn: ['CANCELLED', 'NO_SHOW'] };

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currencyOf(row) {
  return row.currency || 'GHS';
}

/** Group rows by currency and sum `amountKey` / count them. */
function sumByCurrency(rows, amountKey = 'amount') {
  const map = new Map();
  for (const row of rows) {
    const currency = currencyOf(row);
    const current = map.get(currency) || { currency, amount: 0, count: 0 };
    current.amount += Number(row[amountKey] || 0);
    current.count += 1;
    map.set(currency, current);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

function primaryOf(buckets) {
  return buckets[0] || { currency: 'GHS', amount: 0, count: 0 };
}

exports.getAnalytics = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const { cutoff } = periodCutoff(req.query?.period);
  const [properties, bookings] = await Promise.all([
    prisma.stayProperty.findMany({
      where: { supplierId, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true, status: true, data: true },
    }),
    prisma.stayBooking.findMany({
      where: { supplierId, checkIn: { gte: cutoff } },
      select: { propertyId: true, status: true, amount: true, currency: true, checkIn: true },
    }),
  ]);

  const valid = bookings.filter(
    (booking) => booking.status !== 'CANCELLED' && booking.status !== 'NO_SHOW',
  );
  const buckets = sumByCurrency(valid);
  const primary = primaryOf(buckets);
  const currency = primary.currency;
  const count = valid.length;

  const now = new Date();
  const revenueTrend = [];
  for (let index = 5; index >= 0; index -= 1) {
    const bucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    const key = monthKey(bucket);
    revenueTrend.push({
      month: bucket.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      value: valid
        .filter((booking) => currencyOf(booking) === currency && monthKey(booking.checkIn) === key)
        .reduce((sum, booking) => sum + Number(booking.amount || 0), 0),
    });
  }

  const byProperty = new Map();
  for (const booking of valid) {
    const current = byProperty.get(booking.propertyId) || { count: 0, byCurrency: new Map() };
    current.count += 1;
    const key = currencyOf(booking);
    current.byCurrency.set(
      key,
      (current.byCurrency.get(key) || 0) + Number(booking.amount || 0),
    );
    byProperty.set(booking.propertyId, current);
  }

  const propertyRows = properties.map((property) => {
    const stats = byProperty.get(property.id) || { count: 0, byCurrency: new Map() };
    const data = objectOrEmpty(property.data);
    const revenueByCurrency = Object.fromEntries(stats.byCurrency);
    const primaryRevenue = stats.byCurrency.get(currency) || 0;
    return {
      id: property.id,
      name: property.name,
      bookings: stats.count,
      revenue: primaryRevenue,
      currency,
      revenueByCurrency,
      photo: Array.isArray(data.photos) ? data.photos[0] || '' : '',
    };
  });

  res.status(200).json({
    status: 'success',
    data: {
      period: req.query?.period || '90 days',
      totalBookings: count,
      grossBookingValue: primary.amount,
      averageBookingValue: primary.count ? Math.round(primary.amount / primary.count) : 0,
      currency,
      mixedCurrencies: buckets.length > 1,
      currencies: buckets.map((bucket) => ({
        currency: bucket.currency,
        grossBookingValue: bucket.amount,
        bookings: bucket.count,
        averageBookingValue: bucket.count ? Math.round(bucket.amount / bucket.count) : 0,
      })),
      liveProperties: properties.filter((property) => property.status === 'ACTIVE').length,
      revenueTrend,
      bookingsByProperty: propertyRows.map((property) => ({
        id: property.id,
        name: property.name,
        count: property.bookings,
      })),
      bestSelling: [...propertyRows].sort((a, b) => b.bookings - a.bookings),
    },
  });
});

exports.getAnalyticsSummary = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const [propertyCounts, bookingCount, earningsByCurrency, reviewStats] = await Promise.all([
    prisma.stayProperty.groupBy({
      by: ['status'],
      where: { supplierId, status: { not: 'ARCHIVED' } },
      _count: true,
    }),
    prisma.stayBooking.count({
      where: { supplierId, status: NON_CANCELLED },
    }),
    prisma.stayBooking.groupBy({
      by: ['currency'],
      where: { supplierId, status: NON_CANCELLED },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.stayReview.aggregate({
      where: { supplierId, status: 'APPROVED' },
      _avg: { rating: true },
      _count: true,
    }),
  ]);

  const counts = Object.fromEntries(propertyCounts.map((row) => [row.status, row._count]));
  const total = propertyCounts.reduce((sum, row) => sum + row._count, 0);
  const buckets = earningsByCurrency
    .map((row) => ({
      currency: row.currency || 'GHS',
      totalEarnings: Number(row._sum.amount || 0),
      bookings: row._count,
    }))
    .sort((a, b) => b.totalEarnings - a.totalEarnings);
  const primary = buckets[0] || { currency: 'GHS', totalEarnings: 0, bookings: 0 };

  res.status(200).json({
    status: 'success',
    data: {
      properties: { active: counts.ACTIVE || 0, total },
      bookings: { total: bookingCount },
      earnings: {
        totalEarnings: primary.totalEarnings,
        currency: primary.currency,
        mixedCurrencies: buckets.length > 1,
        currencies: buckets,
      },
      reviews: {
        averageRating: Math.round((Number(reviewStats._avg.rating) || 0) * 10) / 10,
        total: reviewStats._count || 0,
      },
    },
  });
});

exports.getPropertyAnalytics = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const properties = await prisma.stayProperty.findMany({
    where: { supplierId, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, data: true },
  });
  const grouped = await prisma.stayBooking.groupBy({
    by: ['propertyId', 'currency'],
    where: { supplierId, status: NON_CANCELLED },
    _count: true,
    _sum: { amount: true },
  });

  const stats = new Map();
  for (const row of grouped) {
    const perProperty = stats.get(row.propertyId) || new Map();
    perProperty.set(row.currency || 'GHS', {
      count: row._count || 0,
      amount: Number(row._sum?.amount || 0),
    });
    stats.set(row.propertyId, perProperty);
  }

  const rows = properties.map((property) => {
    const data = objectOrEmpty(property.data);
    const byCurrency = stats.get(property.id) || new Map();
    const primary = [...byCurrency.entries()].sort((a, b) => b[1].amount - a[1].amount)[0];
    return {
      propertyId: property.id,
      name: property.name,
      bookings: [...byCurrency.values()].reduce((sum, bucket) => sum + bucket.count, 0),
      revenue: primary ? primary[1].amount : 0,
      currency: primary ? primary[0] : 'GHS',
      revenueByCurrency: Object.fromEntries(
        [...byCurrency.entries()].map(([currency, bucket]) => [currency, bucket.amount]),
      ),
      photo: Array.isArray(data.photos) ? data.photos[0] || '' : '',
    };
  });

  res.status(200).json({ status: 'success', data: { properties: rows } });
});

exports.getMonthlyRevenue = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const months = Math.min(24, Math.max(1, parseInt(req.query?.months, 10) || 12));
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const bookings = await prisma.stayBooking.findMany({
    where: { supplierId, checkIn: { gte: start }, status: NON_CANCELLED },
    select: { checkIn: true, amount: true, currency: true },
  });

  const keys = [];
  for (let index = months - 1; index >= 0; index -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    keys.push(monthKey(date));
  }

  const totals = new Map();
  for (const booking of bookings) {
    const key = monthKey(booking.checkIn);
    if (!keys.includes(key)) continue;
    const currency = currencyOf(booking);
    const series = totals.get(currency) || new Map(keys.map((month) => [month, 0]));
    series.set(key, series.get(key) + Number(booking.amount || 0));
    totals.set(currency, series);
  }

  const primaryCurrency = [...totals.entries()]
    .map(([currency, series]) => ({
      currency,
      total: [...series.values()].reduce((sum, value) => sum + value, 0),
    }))
    .sort((a, b) => b.total - a.total)[0]?.currency || 'GHS';
  const primarySeries = totals.get(primaryCurrency) || new Map(keys.map((month) => [month, 0]));

  res.status(200).json({
    status: 'success',
    data: {
      currency: primaryCurrency,
      mixedCurrencies: totals.size > 1,
      months: keys.map((month) => ({ month, revenue: primarySeries.get(month) || 0 })),
      series: [...totals.entries()].map(([currency, series]) => ({
        currency,
        months: keys.map((month) => ({ month, revenue: series.get(month) || 0 })),
      })),
    },
  });
});

exports.listReviews = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const filter = String(req.query?.filter || 'All');
  const where = { supplierId, status: 'APPROVED' };
  if (filter === 'Replied') where.reply = { not: null };
  else if (filter === 'Needs reply' || filter === 'Unreplied') where.reply = null;

  const rows = await prisma.stayReview.findMany({
    where,
    include: { property: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  res.status(200).json({
    status: 'success',
    data: { reviews: rows.map(serializeStayReview) },
  });
});

exports.replyToReview = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const reply = typeof req.body?.reply === 'string' ? req.body.reply.trim() : '';
  if (!reply) throw new AppError('Reply is required', 400);
  if (reply.length > 2000) throw new AppError('Reply is too long', 400);

  const existing = await prisma.stayReview.findFirst({
    where: { id: req.params.id, supplierId },
    select: { id: true },
  });
  if (!existing) throw new AppError('Review not found', 404);

  const review = await prisma.stayReview.update({
    where: { id: existing.id },
    data: { reply, repliedAt: new Date() },
    include: { property: { select: { id: true, name: true } } },
  });

  res.status(200).json({
    status: 'success',
    data: { review: serializeStayReview(review) },
  });
});
