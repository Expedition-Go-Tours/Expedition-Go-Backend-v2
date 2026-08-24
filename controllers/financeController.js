const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { getRequestWindow, getCurrentCycle, getClearanceBufferDays } = require('../utils/payoutCycles');
const { logActivity } = require('../utils/auditLogger');
const { enqueueNotification, enqueueEmail } = require('../utils/queue');

// ── Finance v2 — supplier-facing payout cycle endpoints ──
// Mounted at /finance (see routes/financeRoutes.js). All routes resolve the
// acting supplier via resolveSupplier + requireTeamPermission in the router.

function toNumber(v) {
  return v == null ? 0 : parseFloat(v);
}

function serializeRequest(request) {
  return {
    ...request,
    amount: toNumber(request.amount),
    items: (request.items || []).map((it) => ({
      ...it,
      grossAmount: toNumber(it.grossAmount),
      platformCommission: toNumber(it.platformCommission),
      supplierPayout: toNumber(it.supplierPayout),
    })),
  };
}

/**
 * GET /finance/summary
 * KPI cards + current cycle / withdrawal window state for the Finance page.
 */
exports.getFinanceSummary = catchAsync(async (req, res) => {
  const supplierId = req.supplierId;

  const [eligible, pendingClearance, activeRequests, paidOut, window, cycle, bufferDays] = await Promise.all([
    prisma.booking.aggregate({
      where: { tour: { supplierId }, payoutStatus: 'ELIGIBLE', paymentStatus: 'SUCCEEDED', status: { in: ['CONFIRMED', 'COMPLETED'] } },
      _sum: { supplierPayout: true },
      _count: true,
    }),
    prisma.booking.aggregate({
      where: { tour: { supplierId }, payoutStatus: 'PENDING', paymentStatus: 'SUCCEEDED', status: { in: ['CONFIRMED', 'COMPLETED'] } },
      _sum: { supplierPayout: true },
      _count: true,
    }),
    prisma.payoutRequest.findMany({
      where: { supplierId, status: { in: ['PROCESSING', 'APPROVED'] } },
      select: { amount: true, currency: true, status: true, bookingCount: true },
    }),
    prisma.payout.aggregate({
      where: { supplierId, status: 'PAID' },
      _sum: { amount: true },
    }),
    getRequestWindow(),
    getCurrentCycle(),
    getClearanceBufferDays(),
  ]);

  // Group active request totals by currency
  const inReview = {};
  for (const r of activeRequests) {
    inReview[r.currency] = (inReview[r.currency] || 0) + toNumber(r.amount);
  }

  res.status(200).json({
    status: 'success',
    data: {
      availableBalance: {
        amount: toNumber(eligible._sum.supplierPayout),
        bookingCount: eligible._count,
        currency: 'USD',
      },
      pendingClearance: {
        amount: toNumber(pendingClearance._sum.supplierPayout),
        bookingCount: pendingClearance._count,
        clearanceBufferDays: bufferDays,
      },
      inReview: {
        total: activeRequests.reduce((s, r) => s + toNumber(r.amount), 0),
        byCurrency: inReview,
        requestCount: activeRequests.length,
        bookingCount: activeRequests.reduce((s, r) => s + r.bookingCount, 0),
      },
      paidOut: {
        total: toNumber(paidOut._sum.amount),
      },
      currentCycle: { start: cycle.start, end: cycle.end, label: cycle.label },
      withdrawalWindow: {
        open: window.open,
        opensAt: window.start,
        closesAt: window.end,
        cycleLabel: window.label,
      },
    },
  });
});

/**
 * GET /finance/earnings?payoutStatus=ELIGIBLE&page=1&limit=20
 * Booking-level earnings list with payout lifecycle filter.
 */
exports.getEarnings = catchAsync(async (req, res) => {
  const supplierId = req.supplierId;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const where = { tour: { supplierId } };
  if (req.query.payoutStatus) {
    const statuses = String(req.query.payoutStatus).split(',').map((s) => s.trim()).filter(Boolean);
    where.payoutStatus = { in: statuses };
  }
  if (req.query.currency) where.currency = req.query.currency;

  const [bookings, totalCount, aggregates] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        tour: { select: { id: true, title: true, coverPhoto: true } },
        customer: { select: { id: true, name: true, email: true } },
        payoutRequestItems: { include: { payoutRequest: { select: { id: true, requestNumber: true, status: true } } } },
        disputes: { where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } }, select: { id: true, disputeNumber: true, status: true } },
      },
      orderBy: { travelDate: 'desc' },
      skip,
      take: limit,
    }),
    prisma.booking.count({ where }),
    prisma.booking.aggregate({
      where,
      _sum: { grossAmount: true, supplierPayout: true, platformCommission: true },
    }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      earnings: bookings.map((b) => ({
        id: b.id,
        bookingNumber: b.bookingNumber,
        travelDate: b.travelDate,
        paidAt: b.paidAt,
        grossAmount: toNumber(b.grossAmount),
        supplierPayout: toNumber(b.supplierPayout),
        platformCommission: toNumber(b.platformCommission),
        commissionRate: toNumber(b.commissionRate),
        currency: b.currency,
        payoutStatus: b.payoutStatus,
        status: b.status,
        tour: b.tour,
        customer: b.customer,
        payoutRequest: b.payoutRequestItems?.[0]
          ? { id: b.payoutRequestItems[0].payoutRequest.id, requestNumber: b.payoutRequestItems[0].payoutRequest.requestNumber, status: b.payoutRequestItems[0].payoutRequest.status }
          : null,
        openDispute: b.disputes?.[0] || null,
      })),
      summary: {
        grossAmount: toNumber(aggregates._sum.grossAmount),
        supplierPayout: toNumber(aggregates._sum.supplierPayout),
        platformCommission: toNumber(aggregates._sum.platformCommission),
      },
      pagination: {
        currentPage: page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    },
  });
});

/**
 * POST /finance/payout/request
 * Body: { bookingIds?: string[], payoutMethodId?: string, notes?: string }
 * - Omitting bookingIds selects ALL eligible bookings.
 * - Mixed currencies are split into one request per currency.
 */
exports.createPayoutRequest = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  const { bookingIds, payoutMethodId, notes } = req.body || {};

  const window = await getRequestWindow();
  if (!window.open) {
    return next(new AppError(
      `The withdrawal window is closed. It opens ${window.start.toISOString().slice(0, 10)} for the "${window.label}" cycle.`,
      400
    ));
  }

  // Validate payout method ownership + verification when provided
  let method = null;
  if (payoutMethodId) {
    method = await prisma.payoutMethod.findFirst({ where: { id: payoutMethodId, supplierId } });
    if (!method) return next(new AppError('Payout method not found', 404));
    if (!method.verified) return next(new AppError('The selected payout method is not verified yet', 400));
  } else {
    method = await prisma.payoutMethod.findFirst({
      where: { supplierId, verified: true },
      orderBy: { isDefault: 'desc' },
    });
    if (!method) {
      return next(new AppError('Add and verify a payout method before requesting a payout', 400));
    }
  }

  // Resolve candidate bookings
  const where = {
    tour: { supplierId },
    payoutStatus: 'ELIGIBLE',
    paymentStatus: 'SUCCEEDED',
    status: { in: ['CONFIRMED', 'COMPLETED'] },
  };
  if (Array.isArray(bookingIds) && bookingIds.length > 0) {
    where.id = { in: bookingIds };
  }

  const candidates = await prisma.booking.findMany({ where });

  if (candidates.length === 0) {
    return next(new AppError('No eligible bookings found for a payout request', 400));
  }
  if (Array.isArray(bookingIds) && bookingIds.length > candidates.length) {
    return next(new AppError('Some selected bookings are not eligible (already requested, disputed, or still clearing)', 400));
  }

  // Group by currency — one request per currency
  const byCurrency = {};
  for (const b of candidates) {
    (byCurrency[b.currency] = byCurrency[b.currency] || []).push(b);
  }

  const requests = await prisma.$transaction(async (tx) => {
    const created = [];
    for (const [currency, group] of Object.entries(byCurrency)) {
      const amount = group.reduce((s, b) => s + toNumber(b.supplierPayout), 0);
      const ts = Date.now().toString().slice(-6);
      const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
      const request = await tx.payoutRequest.create({
        data: {
          requestNumber: `PR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${ts}${rand}`,
          supplierId,
          amount,
          currency,
          bookingCount: group.length,
          status: 'PROCESSING',
          cycleStartDate: window.cycle.start,
          cycleEndDate: window.cycle.end,
          cycleLabel: window.cycle.label,
          payoutMethodId: method.id,
          notes: notes || null,
          items: {
            create: group.map((b) => ({
              bookingId: b.id,
              grossAmount: b.grossAmount,
              platformCommission: b.platformCommission,
              supplierPayout: b.supplierPayout,
              currency: b.currency,
            })),
          },
        },
        include: { items: true },
      });

      await tx.booking.updateMany({
        where: { id: { in: group.map((b) => b.id) } },
        data: { payoutStatus: 'REQUESTED' },
      });

      created.push(request);
    }
    return created;
  });

  await logActivity({
    userId: req.user.id,
    action: 'payout_request.created',
    resource: 'PayoutRequest',
    resourceId: requests[0].id,
    metadata: { requests: requests.map((r) => ({ id: r.id, currency: r.currency, amount: toNumber(r.amount), bookings: r.bookingCount })) },
  });

  enqueueNotification({
    userId: supplierId,
    type: 'PAYOUT_REQUEST_SUBMITTED',
    title: 'Payout Request Submitted',
    message: `Your payout request for ${requests.reduce((s, r) => s + toNumber(r.amount), 0).toFixed(2)} ${requests[0].currency} (${requests.reduce((s, r) => s + r.bookingCount, 0)} bookings) is being processed.`,
    data: { payoutRequestId: requests[0].id },
  }).catch(() => {});

  enqueueEmail({ type: 'payout-request-submitted', payoutRequestId: requests[0].id }).catch((err) =>
    console.error('[Finance] Payout request email failed:', err.message)
  );

  res.status(201).json({
    status: 'success',
    data: { requests: requests.map(serializeRequest) },
  });
});

/**
 * GET /finance/payouts/requests?page=&limit=&status=
 */
exports.getPayoutRequests = catchAsync(async (req, res) => {
  const supplierId = req.supplierId;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  const where = { supplierId };
  if (req.query.status) {
    where.status = { in: String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean) };
  }

  const [requests, totalCount] = await Promise.all([
    prisma.payoutRequest.findMany({
      where,
      include: {
        items: { include: { booking: { select: { bookingNumber: true, travelDate: true, tour: { select: { title: true } } } } } },
        payoutMethod: { select: { id: true, type: true, bankName: true, paypalEmail: true, accountName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.payoutRequest.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      requests: requests.map(serializeRequest),
      pagination: { currentPage: page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
    },
  });
});

/**
 * GET /finance/payouts/requests/:id
 */
exports.getPayoutRequestById = catchAsync(async (req, res, next) => {
  const request = await prisma.payoutRequest.findFirst({
    where: { id: req.params.id, supplierId: req.supplierId },
    include: {
      items: { include: { booking: { select: { bookingNumber: true, travelDate: true, grossAmount: true, currency: true, tour: { select: { title: true } } } } } },
      payoutMethod: true,
    },
  });
  if (!request) return next(new AppError('Payout request not found', 404));

  res.status(200).json({ status: 'success', data: { request: serializeRequest(request) } });
});

/**
 * PATCH /finance/payouts/requests/:id/cancel
 * Supplier can cancel their own request while it is still PROCESSING.
 */
exports.cancelPayoutRequest = catchAsync(async (req, res, next) => {
  const request = await prisma.payoutRequest.findFirst({
    where: { id: req.params.id, supplierId: req.supplierId, status: 'PROCESSING' },
    include: { items: true },
  });
  if (!request) return next(new AppError('Payout request not found or can no longer be cancelled', 404));

  await prisma.$transaction(async (tx) => {
    await tx.payoutRequest.update({
      where: { id: request.id },
      data: { status: 'CANCELLED', notes: 'Cancelled by supplier' },
    });
    await tx.booking.updateMany({
      where: { id: { in: request.items.map((i) => i.bookingId) }, payoutStatus: 'REQUESTED' },
      data: { payoutStatus: 'ELIGIBLE' },
    });
  });

  await logActivity({
    userId: req.user.id,
    action: 'payout_request.cancelled',
    resource: 'PayoutRequest',
    resourceId: request.id,
    metadata: { requestNumber: request.requestNumber },
  });

  res.status(200).json({ status: 'success', data: { request: { id: request.id, status: 'CANCELLED' } } });
});

/**
 * GET /finance/disputes
 * Disputes opened against this supplier's bookings.
 */
exports.getDisputes = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const where = { supplierId: req.supplierId };
  if (req.query.status) {
    where.status = { in: String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean) };
  }

  const [disputes, totalCount] = await Promise.all([
    prisma.dispute.findMany({
      where,
      include: {
        booking: { select: { bookingNumber: true, travelDate: true, grossAmount: true, currency: true, tour: { select: { title: true } } } },
        opener: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.dispute.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      disputes: disputes.map((d) => ({
        ...d,
        refundAmount: d.refundAmount == null ? null : toNumber(d.refundAmount),
        booking: d.booking ? { ...d.booking, grossAmount: toNumber(d.booking.grossAmount) } : null,
      })),
      pagination: { currentPage: page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
    },
  });
});
