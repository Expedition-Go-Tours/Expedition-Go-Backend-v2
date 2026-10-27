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

// GetYourGuide's published bar is a single 1.0% pass/fail, so anything above
// 1% must not be labelled "Good". The extra bands below exist to tell a
// supplier how far past the standard they are, not to imply 1–2% is healthy.
const STANDARD_RATE = 1;

/**
 * GetYourGuide Performance Quality Standards thresholds:
 * - < 10 eligible bookings → "Building performance record" (not enough data)
 * - ≤ 1%  → Excellent (meets the standard)
 * - ≤ 2%  → Above standard (fails the 1% bar; warn)
 * - ≤ 5%  → At risk (warn)
 * - > 5%  → High (warn — compute + notify only, never auto-delist)
 */
function getStatus(rate, eligibleBookings) {
  if (eligibleBookings < 10) return 'Building performance record';
  if (rate <= STANDARD_RATE) return 'Excellent';
  if (rate <= 2) return 'Above standard';
  if (rate <= 5) return 'At risk';
  return 'High';
}

const CANCELLED_STATUSES = ['CANCELLED', 'REFUNDED'];

function isCancelledBooking(booking) {
  return CANCELLED_STATUSES.includes(booking.status);
}

/**
 * When did the cancellation happen? GetYourGuide counts supplier
 * cancellations by date of cancellation, not travel date. Rows written
 * before `cancelledAt` existed fall back to the travel date so historical
 * rates do not silently drop out of the window.
 */
function cancellationDate(booking) {
  return booking.cancelledAt || booking.travelDate;
}

function withinWindow(date, start, end) {
  return date >= start && date <= end;
}

// A supplier only hears about a threshold breach once a day (checked against
// their notification bell before enqueueing).
const BREACH_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function alertRateBreachIfDue(supplierId, status, rate, windowDays = 90) {
  if (!supplierId) return;
  if (status !== 'Above standard' && status !== 'At risk' && status !== 'High') return;

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
      title: status === 'High' ? 'High cancellation rate' : 'Cancellation rate above the 1% standard',
      message:
        status === 'High'
          ? `Your ${windowDays}-day cancellation rate is ${rate}%. That is above 5% — please review why bookings are being cancelled.`
          : `Your ${windowDays}-day cancellation rate is ${rate}%. The standard is 1% or lower — please review why bookings are being cancelled.`,
      data: { rate, status, windowDays },
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
        upcomingConfirmed: 0,
        cancelled: 0,
        supplierCausedCount: 0,
        excludedCancellations: 0,
        completed: 0,
        noShow: 0,
        noShowRate: 0,
        eligibleBookings: 0,
        completionRate: 0,
        bookingValueLost: 0,
        mostCommonReason: null,
        days: 90,
        windowStart: null,
        windowEnd: null,
      },
    });
  }

  const { productId, days = 90 } = req.query;
  const windowDays = Math.max(1, parseInt(days, 10) || 90);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // The rate measures the last N days, so:
  //   * a booking that travelled in the window is at risk in this window;
  //   * a cancellation that happened in the window is at risk in this window,
  //     even if its travel date is later (customer/supplier cancelled ahead).
  // Future travel dates are fetched only when the booking was already
  // cancelled — otherwise they would dilute today's rate.
  const bookingWhere = {
    tour: { supplierId },
    status: { in: ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'NO_SHOW'] },
    OR: [
      { travelDate: { gte: windowStart, lte: windowEnd } },
      { cancelledAt: { gte: windowStart, lte: windowEnd } },
    ],
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
      cancelledAt: true,
      grossAmount: true,
      travelDate: true,
    },
  });

  // Operational context: confirmed bookings for future travel. They are not
  // part of the rate denominator (that was the bug), but the card still shows
  // how much upcoming business the supplier has.
  const upcomingWhere = {
    tour: { supplierId },
    status: 'CONFIRMED',
    travelDate: { gt: windowEnd },
  };
  if (productId) upcomingWhere.tourId = productId;
  const upcomingConfirmed = await prisma.booking.count({ where: upcomingWhere });

  // Numerator: supplier-caused cancellations *by date of cancellation*.
  const cancellationCohort = bookings.filter(
    (b) => isCancelledBooking(b) && withinWindow(cancellationDate(b), windowStart, windowEnd),
  );
  const supplierCancelled = cancellationCohort.filter(isSupplierCaused);
  const supplierCausedCount = supplierCancelled.length;

  // Denominator: bookings that travelled in the window plus cancellations
  // made in the window, deduplicated. A supplier cancellation can therefore
  // never account for more than 100% of the eligible bookings.
  const travelled = bookings.filter((b) => {
    if (!withinWindow(b.travelDate, windowStart, windowEnd)) return false;
    // A cancellation made before this window was reported in that window;
    // counting it again here would inflate today's denominator.
    if (isCancelledBooking(b) && cancellationDate(b) < windowStart) return false;
    return true;
  });

  const eligibleById = new Map();
  [...travelled, ...cancellationCohort].forEach((b) => eligibleById.set(b.id, b));
  const totalEligible = eligibleById.size;

  const confirmedCount = travelled.filter((b) => b.status === 'CONFIRMED').length;
  const completedCount = travelled.filter((b) => b.status === 'COMPLETED').length;

  // `NO_SHOW` means the traveller did not turn up — the supplier is still
  // paid. It is NOT GetYourGuide's supplier no-show (customer refunded
  // because the supplier missed pickup), so it is reported separately and
  // never graded against GYG's 0.2% target.
  const noShowCount = travelled.filter((b) => b.status === 'NO_SHOW').length;

  const cancellationRate = totalEligible > 0 ? (supplierCausedCount / totalEligible) * 100 : 0;
  const noShowRate = totalEligible > 0 ? (noShowCount / totalEligible) * 100 : 0;

  const completionRate = travelled.length > 0
    ? (completedCount / travelled.length) * 100
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
    alertRateBreachIfDue(supplierId, status, roundedRate, windowDays);
  }

  res.status(200).json({
    status: 'success',
    data: {
      cancellationRate: roundedRate,
      status,
      confirmed: confirmedCount,
      upcomingConfirmed,
      cancelled: cancellationCohort.length,
      supplierCausedCount,
      excludedCancellations: cancellationCohort.length - supplierCausedCount,
      completed: completedCount,
      noShow: noShowCount,
      noShowRate: Math.round(noShowRate * 100) / 100,
      eligibleBookings: totalEligible,
      completionRate: Math.round(completionRate * 10) / 10,
      bookingValueLost: Math.round(bookingValueLost * 100) / 100,
      mostCommonReason,
      days: windowDays,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
  });
});

/**
 * GET /suppliers/cancellation/records
 * Every cancellation made in the window — whether initiated by the supplier,
 * the customer, or an external event. Customer-caused cancellations appear
 * here too; they don't count toward the supplier's rate, but the supplier
 * still needs to see that a booking was cancelled and why.
 *
 * Filtering and ordering use the cancellation date (falling back to travel
 * date for legacy rows) so this table always lists exactly the cancellations
 * the summary counted.
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
  const pageSize = Math.max(1, parseInt(limit, 10) || 25);
  const windowDays = Math.max(1, parseInt(days, 10) || 90);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const where = {
    tour: { supplierId },
    status: { in: ['CANCELLED', 'REFUNDED'] },
    OR: [
      { cancelledAt: { gte: windowStart, lte: windowEnd } },
      // Legacy rows have no cancellation timestamp — use the travel date,
      // exactly as the summary does when it windows the numerator.
      { cancelledAt: null, travelDate: { gte: windowStart, lte: windowEnd } },
    ],
  };
  if (productId) where.tourId = productId;

  const allCancelled = await prisma.booking.findMany({
    where,
    include: { tour: { select: { id: true, title: true } } },
  });

  // Prisma cannot order by a fallback column, so sort on the same effective
  // date the filter used. Newest cancellation first.
  allCancelled.sort((a, b) => cancellationDate(b) - cancellationDate(a));

  const totalCount = allCancelled.length;
  const totalPages = Math.ceil(totalCount / pageSize);
  const currentPage = Math.min(Math.max(1, parseInt(page, 10) || 1), Math.max(totalPages, 1));
  const skip = (currentPage - 1) * pageSize;
  const paged = allCancelled.slice(skip, skip + pageSize);

  res.status(200).json({
    status: 'success',
    data: {
      records: paged.map((r) => ({
        id: r.id,
        travelDate: r.travelDate.toISOString().split('T')[0],
        cancelledOn: cancellationDate(r).toISOString().split('T')[0],
        reason:
          (r.cancellationCode && getReason(r.cancellationCode)?.label) ||
          r.cancellationReason ||
          'Unknown',
        note: r.cancellationNote || null,
        category: r.cancellationCategory || null,
        origin: r.cancellationOrigin || null,
        // Resolved through the same predicate as the summary so the badge in
        // this table can never contradict the headline rate.
        countsTowardRate: isSupplierCaused(r),
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
exports.cancellationDate = cancellationDate;
