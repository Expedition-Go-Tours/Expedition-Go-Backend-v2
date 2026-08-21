const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');

const EXCLUDED_REASON_KEYWORDS = ['weather', 'force majeure', 'customer-requested', 'customer requested'];

/**
 * Determines if a cancellation was caused by the supplier.
 * Excludes customer-initiated cancellations (REFUNDED status) and
 * cancellations with reasons matching excluded keywords (weather, force majeure, etc.).
 */
function isSupplierCaused(booking) {
  if (booking.status === 'REFUNDED') return false;
  const reason = booking.cancellationReason;
  if (!reason) return true;
  const lower = reason.toLowerCase();
  return !EXCLUDED_REASON_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Returns the 4-tier performance status based on cancellation rate and eligible bookings.
 * - < 10 eligible bookings: "Building performance record"
 * - < 2%: "Excellent"
 * - 2-3%: "Good"
 * - 3-5%: "Needs attention"
 * - 5%+: "High"
 */
function getStatus(rate, eligibleBookings) {
  if (eligibleBookings < 10) return 'Building performance record';
  if (rate < 2) return 'Excellent';
  if (rate < 3) return 'Good';
  if (rate < 5) return 'Needs attention';
  return 'High';
}

/**
 * GET /suppliers/cancellation/summary
 * Returns cancellation rate, status, booking counts, and performance metrics.
 */
exports.getCancellationSummary = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId || req.user?.id;
  if (!supplierId) {
    return res.status(200).json({
      status: 'success',
      data: {
        cancellationRate: 0,
        status: 'Building performance record',
        confirmed: 0,
        cancelled: 0,
        completed: 0,
        eligibleBookings: 0,
        completionRate: 0,
        bookingValueLost: 0,
        mostCommonReason: null,
      },
    });
  }

  const { productId, days = 30 } = req.query;
  const sinceDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

  const bookingWhere = {
    tour: { supplierId },
    travelDate: { gte: sinceDate },
    status: { in: ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'REFUNDED'] },
  };
  if (productId) bookingWhere.tourId = productId;

  const bookings = await prisma.booking.findMany({
    where: bookingWhere,
    select: { id: true, status: true, cancellationReason: true, grossAmount: true, travelDate: true },
  });

  const totalEligible = bookings.length;

  const confirmedCount = bookings.filter((b) => b.status === 'CONFIRMED').length;
  const completedCount = bookings.filter((b) => b.status === 'COMPLETED').length;

  const supplierCancelled = bookings.filter(
    (b) => b.status === 'CANCELLED' && isSupplierCaused(b),
  );
  const cancelledCount = supplierCancelled.length;

  const cancellationRate = totalEligible > 0 ? (cancelledCount / totalEligible) * 100 : 0;

  const now = new Date();
  const pastBookings = bookings.filter((b) => new Date(b.travelDate) < now);
  const pastCompletedCount = pastBookings.filter((b) => b.status === 'COMPLETED').length;
  const completionRate = pastBookings.length > 0
    ? (pastCompletedCount / pastBookings.length) * 100
    : 0;

  const bookingValueLost = supplierCancelled.reduce((sum, b) => sum + Number(b.grossAmount), 0);

  const reasonCounts = {};
  supplierCancelled.forEach((b) => {
    const reason = b.cancellationReason || 'Unknown';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  });
  const mostCommonReason =
    Object.keys(reasonCounts).length > 0
      ? Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0][0]
      : null;

  res.status(200).json({
    status: 'success',
    data: {
      cancellationRate: Math.round(cancellationRate * 10) / 10,
      status: getStatus(cancellationRate, totalEligible),
      confirmed: confirmedCount,
      cancelled: cancelledCount,
      completed: completedCount,
      eligibleBookings: totalEligible,
      completionRate: Math.round(completionRate * 10) / 10,
      bookingValueLost: Math.round(bookingValueLost * 100) / 100,
      mostCommonReason,
    },
  });
});

/**
 * GET /suppliers/cancellation/records
 */
exports.getCancellationRecords = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId || req.user?.id;
  if (!supplierId) {
    return res.status(200).json({
      status: 'success',
      data: { records: [], pagination: { currentPage: 1, totalPages: 0, totalCount: 0, limit: 25 } },
    });
  }

  const { productId, page = 1, limit = 25, days = 90 } = req.query;
  const pageSize = parseInt(limit);
  const sinceDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

  const where = {
    tour: { supplierId },
    status: 'CANCELLED',
    travelDate: { gte: sinceDate },
  };
  if (productId) where.tourId = productId;

  // Fetch all matching cancelled bookings (no pagination yet — filter first, paginate after)
  const allCancelled = await prisma.booking.findMany({
    where,
    orderBy: { travelDate: 'desc' },
    include: { tour: { select: { id: true, title: true } } },
  });

  // Filter to supplier-caused only, then paginate
  const supplierCaused = allCancelled.filter((r) => isSupplierCaused(r));
  const totalCount = supplierCaused.length;
  const totalPages = Math.ceil(totalCount / pageSize);
  const currentPage = Math.min(parseInt(page), Math.max(totalPages, 1));
  const skip = (currentPage - 1) * pageSize;
  const paged = supplierCaused.slice(skip, skip + pageSize);

  res.status(200).json({
    status: 'success',
    data: {
      records: paged.map((r) => ({
        id: r.id,
        travelDate: r.travelDate.toISOString().split('T')[0],
        reason: r.cancellationReason || 'Unknown',
        bookingReference: r.bookingNumber,
        productName: r.tour.title,
        bookingValue: Number(r.grossAmount),
        refundAmount: r.refundAmount != null ? Number(r.refundAmount) : null,
      })),
      pagination: {
        currentPage,
        totalPages,
        totalCount,
        limit: pageSize,
      },
    },
  });
});

/**
 * GET /suppliers/products/list
 * Returns the supplier's active tours for the product filter dropdown.
 */
exports.getCancellationProducts = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId || req.user?.id;
  if (!supplierId) {
    return res.status(200).json({ status: 'success', data: { products: [] } });
  }

  const tours = await prisma.tour.findMany({
    where: { supplierId, status: 'ACTIVE' },
    select: { id: true, title: true },
    orderBy: { title: 'asc' },
  });

  res.status(200).json({
    status: 'success',
    data: {
      products: tours.map((t) => ({ id: t.id, title: t.title })),
    },
  });
});
