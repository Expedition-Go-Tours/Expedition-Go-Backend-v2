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

function sumAmount(rows) {
  return rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
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
      select: { propertyId: true, status: true, amount: true, checkIn: true },
    }),
  ]);

  const valid = bookings.filter((booking) => booking.status !== 'CANCELLED' && booking.status !== 'NO_SHOW');
  const gross = sumAmount(valid);
  const count = valid.length;

  const now = new Date();
  const revenueTrend = [];
  for (let index = 5; index >= 0; index -= 1) {
    const bucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    const key = monthKey(bucket);
    revenueTrend.push({
      month: bucket.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      value: valid
        .filter((booking) => monthKey(booking.checkIn) === key)
        .reduce((sum, booking) => sum + Number(booking.amount || 0), 0),
    });
  }

  const byProperty = new Map();
  for (const booking of valid) {
    const current = byProperty.get(booking.propertyId) || { count: 0, revenue: 0 };
    current.count += 1;
    current.revenue += Number(booking.amount || 0);
    byProperty.set(booking.propertyId, current);
  }

  const propertyRows = properties.map((property) => {
    const stats = byProperty.get(property.id) || { count: 0, revenue: 0 };
    const data = objectOrEmpty(property.data);
    return {
      id: property.id,
      name: property.name,
      bookings: stats.count,
      revenue: stats.revenue,
      photo: Array.isArray(data.photos) ? data.photos[0] || '' : '',
    };
  });

  res.status(200).json({
    status: 'success',
    data: {
      period: req.query?.period || '90 days',
      totalBookings: count,
      grossBookingValue: gross,
      averageBookingValue: count ? Math.round(gross / count) : 0,
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
  const [propertyCounts, bookingCount, earnings, reviewStats] = await Promise.all([
    prisma.stayProperty.groupBy({
      by: ['status'],
      where: { supplierId, status: { not: 'ARCHIVED' } },
      _count: true,
    }),
    prisma.stayBooking.count({
      where: { supplierId, status: NON_CANCELLED },
    }),
    prisma.stayBooking.aggregate({
      where: { supplierId, status: NON_CANCELLED },
      _sum: { amount: true },
    }),
    prisma.stayReview.aggregate({
      where: { supplierId, status: 'APPROVED' },
      _avg: { rating: true },
      _count: true,
    }),
  ]);

  const counts = Object.fromEntries(propertyCounts.map((row) => [row.status, row._count]));
  const total = propertyCounts.reduce((sum, row) => sum + row._count, 0);

  res.status(200).json({
    status: 'success',
    data: {
      properties: { active: counts.ACTIVE || 0, total },
      bookings: { total: bookingCount },
      earnings: { totalEarnings: Number(earnings._sum.amount || 0) },
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
    by: ['propertyId'],
    where: { supplierId, status: NON_CANCELLED },
    _count: true,
    _sum: { amount: true },
  });
  const stats = new Map(grouped.map((row) => [row.propertyId, row]));

  const rows = properties.map((property) => {
    const data = objectOrEmpty(property.data);
    const row = stats.get(property.id);
    return {
      propertyId: property.id,
      name: property.name,
      bookings: row?._count || 0,
      revenue: Number(row?._sum?.amount || 0),
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
    select: { checkIn: true, amount: true },
  });

  const buckets = new Map();
  for (let index = months - 1; index >= 0; index -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    buckets.set(monthKey(date), 0);
  }
  for (const booking of bookings) {
    const key = monthKey(booking.checkIn);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + Number(booking.amount || 0));
  }

  res.status(200).json({
    status: 'success',
    data: {
      months: [...buckets.entries()].map(([month, revenue]) => ({ month, revenue })),
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
