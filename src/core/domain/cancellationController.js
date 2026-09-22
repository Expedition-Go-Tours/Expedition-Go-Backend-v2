const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const { enqueueNotification } = require('../services/queue');
const { getReason, ORIGINS } = require('../services/cancellationReasons');

// Legacy heuristic — ONLY used for rows that predate the structured fields
// (countsTowardRate IS NULL, i.e. before backfillCancellationFields.js ran).
// Kept byte-for-byte equivalent to the old keyword matcher so historical
// rates don't jump around during the rollout.
const LEGACY_EXCLUDED_KEYWORDS = ['weather', 'force majeure', 'customer-requested', 'customer requested'];

/**
 * Does this cancellation count against the supplier's cancellation rate?
 *
 * Structured rows (the only kind written from now on) answer from
 * countsTowardRate/origin — never from free-text matching. Pre-rollout rows
 * fall back to the legacy heuristic until the backfill script normalizes them.
 */
function isSupplierCaused(booking) {
  // Fast path: structured origin makes the decision for customer/system cancels.
  if (booking.cancellationOrigin === ORIGINS.CUSTOMER || booking.cancellationOrigin === ORIGINS.SYSTEM) {
    return false;
  }
  // Structured flag always wins when present.
  if (typeof booking.countsTowardRate === 'boolean') return booking.countsTowardRate;
  // Structured code without the flag yet → derive from the taxonomy.
  if (booking.cancellationCode) {
    const reason = getReason(booking.cancellationCode);
    if (reason) {
      return reason.category === 'OPERATIONAL';
    }
  }

  // ── Legacy rows only (pre-structured history) ──
  if (booking.status === 'REFUNDED') return false;
  const reason = booking.cancellationReason;
  if (!reason) return true;
  const lower = reason.toLowerCase();
  return !LEGACY_EXCLUDED_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * GetYourGuide Performance Quality Standards thresholds:
 * - < 10 eligible bookings → "Building performance record" (not enough data)
 * - ≤ 1%  → Excellent
 * - ≤ 2%  → Good
 * - ≤ 5%  → Needs attention (warn)
 * - > 5%  → High (warn — compute + notify only, never auto-delist)
 */
function getStatus(rate, eligibleBookings) {
  if (eligibleBookings < 10) return 'Building performance record';
  if (rate <= 1) return 'Excellent';
  if (rate <= 2) return 'Good';
  if (rate <= 5) return 'Needs attention';
  return 'High';
}

// A supplier only hears about a threshold breach once a day (checked against
// their notification bell before enqueueing).
const BREACH_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function alertRateBreachIfDue(supplierId, status, rate) {
  if (!supplierId) return;
  if (status !== 'Needs attention' && status !== 'High') return;

  try {
    const recent = await prisma.notification.findFirst({
      where: {
        userId: supplierId,
        type: 'CANCELLATION_RATE_ALERT',
        createdAt: { gt: new Date(Date.now() - BREACH_ALERT_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return;

    await enqueueNotification({
      userId: supplierId,
      type: 'CANCELLATION_RATE_ALERT',
      title: status === 'High' ? 'High cancellation rate' : 'Cancellation rate needs attention',
      message:
        status === 'High'
          ? `Your 90-day cancellation rate is ${rate}%. Above 5% is considered a high cancellation rate — please review why bookings are being cancelled.`
          : `Your 90-day cancellation rate is ${rate}%. Between 2% and 5% needs attention — please review why bookings are being cancelled.`,
      data: { rate, status, windowDays: 90 },
    });
  } catch (err) {
    console.error('[Cancellation] rate breach alert failed:', err.message);
  }
}

/**
 * GET /suppliers/cancellation/summary
 * Returns cancellation rate, status, booking counts, and performance metrics.
 * Default window is 90 days (GYG's standard reporting period).
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
        noShow: 0,
        noShowRate: 0,
        eligibleBookings: 0,
        completionRate: 0,
        bookingValueLost: 0,
        mostCommonReason: null,
        days: 90,
      },
    });
  }

  const { productId, days = 90 } = req.query;
  const sinceDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

  const bookingWhere = {
    tour: { supplierId },
    travelDate: { gte: sinceDate },
    status: { in: ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'NO_SHOW'] },
  };
  if (productId) bookingWhere.tourId = productId;

  const bookings = await prisma.booking.findMany({
    where: bookingWhere,
    select: {
      id: true,
      status: true,
      cancellationReason: true,
      cancellationCode: true,
      cancellationCategory: true,
      cancellationOrigin: true,
      countsTowardRate: true,
      grossAmount: true,
      travelDate: true,
    },
  });

  const totalEligible = bookings.length;

  const confirmedCount = bookings.filter((b) => b.status === 'CONFIRMED').length;
  const completedCount = bookings.filter((b) => b.status === 'COMPLETED').length;

  const supplierCancelled = bookings.filter(
    (b) => (b.status === 'CANCELLED' || b.status === 'REFUNDED') && isSupplierCaused(b),
  );
  const cancelledCount = supplierCancelled.length;

  // GYG's second supplier metric: no-shows must stay ≤ 0.2% of bookings.
  const noShowCount = bookings.filter((b) => b.status === 'NO_SHOW').length;

  const cancellationRate = totalEligible > 0 ? (cancelledCount / totalEligible) * 100 : 0;
  const noShowRate = totalEligible > 0 ? (noShowCount / totalEligible) * 100 : 0;

  const now = new Date();
  const pastBookings = bookings.filter((b) => new Date(b.travelDate) < now);
  const pastCompletedCount = pastBookings.filter((b) => b.status === 'COMPLETED').length;
  const completionRate = pastBookings.length > 0
    ? (pastCompletedCount / pastBookings.length) * 100
    : 0;

  const bookingValueLost = supplierCancelled.reduce((sum, b) => sum + Number(b.grossAmount), 0);

  const reasonCounts = {};
  supplierCancelled.forEach((b) => {
    const reason =
      (b.cancellationCode && getReason(b.cancellationCode)?.label) ||
      b.cancellationReason ||
      'Unknown';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  });
  const mostCommonReason =
    Object.keys(reasonCounts).length > 0
      ? Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0][0]
      : null;

  const roundedRate = Math.round(cancellationRate * 10) / 10;
  const status = getStatus(cancellationRate, totalEligible);

  // Warn-only breach alert (never auto-delist) — only for a real request.
  if (req.supplierId) {
    alertRateBreachIfDue(supplierId, status, roundedRate);
  }

  res.status(200).json({
    status: 'success',
    data: {
      cancellationRate: roundedRate,
      status,
      confirmed: confirmedCount,
      cancelled: cancelledCount,
      completed: completedCount,
      noShow: noShowCount,
      noShowRate: Math.round(noShowRate * 100) / 100,
      eligibleBookings: totalEligible,
      completionRate: Math.round(completionRate * 10) / 10,
      bookingValueLost: Math.round(bookingValueLost * 100) / 100,
      mostCommonReason,
      days: parseInt(days),
    },
  });
});

/**
 * GET /suppliers/cancellation/records
 * Supplier-caused cancellations only — customer/system cancels and excluded
 * categories (force majeure, customer-requested) never appear here.
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
    status: { in: ['CANCELLED', 'REFUNDED'] },
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
        reason:
          (r.cancellationCode && getReason(r.cancellationCode)?.label) ||
          r.cancellationReason ||
          'Unknown',
        category: r.cancellationCategory || null,
        origin: r.cancellationOrigin || null,
        countsTowardRate: typeof r.countsTowardRate === 'boolean' ? r.countsTowardRate : null,
        cancellationFee: r.cancellationFee != null ? Number(r.cancellationFee) : null,
        refundStatus: r.refundStatus || null,
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

// Exported for unit tests.
exports.isSupplierCaused = isSupplierCaused;
exports.getStatus = getStatus;
