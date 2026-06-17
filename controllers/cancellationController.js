const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');

const EXCLUDED_REASON_KEYWORDS = ['weather', 'force majeure', 'customer-requested', 'customer requested'];

function isSupplierCaused(reason) {
  if (!reason) return true;
  const lower = reason.toLowerCase();
  return !EXCLUDED_REASON_KEYWORDS.some((kw) => lower.includes(kw));
}

function getStatus(rate) {
  if (rate < 2) return 'Excellent';
  if (rate <= 5) return 'Warning';
  return 'Poor';
}

/**
 * GET /suppliers/cancellation/summary
 */
exports.getCancellationSummary = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId || req.user?.id;
  if (!supplierId) {
    return res.status(200).json({
      status: 'success',
      data: { cancellationRate: 0, status: 'Excellent', bookingValueLost: 0, mostCommonReason: null },
    });
  }

  const { productId } = req.query;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const bookingWhere = {
    tour: { supplierId },
    selectedDate: { gte: ninetyDaysAgo },
  };
  if (productId) bookingWhere.tourId = productId;

  const bookings = await prisma.booking.findMany({
    where: bookingWhere,
    select: { id: true, status: true, cancellationReason: true, total: true },
  });

  const totalEligible = bookings.length;
  const supplierCancelled = bookings.filter(
    (b) => b.status === 'CANCELLED' && isSupplierCaused(b.cancellationReason),
  );
  const cancelledCount = supplierCancelled.length;
  const cancellationRate = totalEligible > 0 ? (cancelledCount / totalEligible) * 100 : 0;
  const bookingValueLost = supplierCancelled.reduce((sum, b) => sum + Number(b.total), 0);

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
      status: getStatus(cancellationRate),
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

  const { productId, page = 1, limit = 25 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const where = {
    tour: { supplierId },
    status: 'CANCELLED',
    selectedDate: { gte: ninetyDaysAgo },
  };
  if (productId) where.tourId = productId;

  const [allCancelled, totalCount] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { selectedDate: 'desc' },
      skip,
      take: parseInt(limit),
      include: { tour: { select: { id: true, title: true } } },
    }),
    prisma.booking.count({ where }),
  ]);

  const supplierCausedRecords = allCancelled.filter((r) => isSupplierCaused(r.cancellationReason));
  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      records: supplierCausedRecords.map((r) => ({
        id: r.id,
        travelDate: r.selectedDate.toISOString().split('T')[0],
        reason: r.cancellationReason || 'Unknown',
        bookingReference: r.bookingNumber,
        productName: r.tour.title,
        bookingValue: Number(r.total),
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount: supplierCausedRecords.length,
        limit: parseInt(limit),
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
