const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const { getRequestWindow, getCurrentCycle, getClearanceBufferDays } = require('../services/payoutCycles');
const {
  getSupplierPayoutPlan,
  updateSupplierPayoutPlan,
  selectEligibleBookings,
  resolvePayoutMethod,
  createRequestsForBookings,
  notifyPayoutRequestsCreated,
  cyclePeriodFor,
  lastRunAt,
  withLabel,
} = require('../services/payoutRuns');
const { logActivity } = require('../services/auditLogger');

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

  const [eligible, pendingClearance, activeRequests, paidOut, window, cycle, bufferDays, payoutPlan] = await Promise.all([
    prisma.booking.aggregate({
      where: { tour: { supplierId }, isSimulated: false, payoutStatus: 'ELIGIBLE', paymentStatus: 'SUCCEEDED', status: { in: ['CONFIRMED', 'COMPLETED'] } },
      _sum: { supplierPayout: true },
      _count: true,
    }),
    prisma.booking.aggregate({
      where: { tour: { supplierId }, isSimulated: false, payoutStatus: 'PENDING', paymentStatus: 'SUCCEEDED', status: { in: ['CONFIRMED', 'COMPLETED'] } },
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
    getSupplierPayoutPlan(supplierId),
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
      // The supplier's payout schedule (auto-generated runs). `autoManaged`
      // false means the legacy window-based manual flow below still applies.
      payoutPlan,
      withdrawalWindow: payoutPlan.autoManaged
        ? null
        : {
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

  const where = { tour: { supplierId }, isSimulated: false };
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
 * GET /finance/charges
 * The supplier's cancellation-fee ledger (open fees will be netted off their
 * next payout request; settled ones show which request collected them).
 */
exports.getSupplierCharges = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  if (!supplierId) return next(new AppError('Not authorized', 401));

  const charges = await prisma.supplierCharge.findMany({
    where: { supplierId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      booking: { select: { id: true, bookingNumber: true, travelDate: true, status: true } },
      payoutRequest: { select: { id: true, requestNumber: true, status: true } },
    },
  });

  const openTotals = {};
  for (const c of charges) {
    if (c.status !== 'OPEN') continue;
    openTotals[c.currency] = Math.round(((openTotals[c.currency] || 0) + toNumber(c.amount)) * 100) / 100;
  }

  res.status(200).json({
    status: 'success',
    data: {
      openTotals,
      charges: charges.map((c) => ({
        id: c.id,
        amount: toNumber(c.amount),
        currency: c.currency,
        reason: c.reason,
        status: c.status,
        notes: c.notes,
        createdAt: c.createdAt,
        settledAt: c.settledAt,
        bookingId: c.bookingId,
        bookingNumber: c.booking?.bookingNumber || null,
        travelDate: c.booking?.travelDate || null,
        payoutRequestId: c.payoutRequestId,
        payoutRequestNumber: c.payoutRequest?.requestNumber || null,
      })),
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

  // Enrolled suppliers are paid automatically — they never request manually.
  // (If the scheduler is switched off they can fall back to a manual request so
  // funds are never stranded.)
  const plan = await getSupplierPayoutPlan(supplierId);
  if (plan.autoManaged && plan.autoRunsEnabled) {
    const next = plan.nextRunAt ? plan.nextRunAt.toISOString().slice(0, 10) : null;
    return next(new AppError(
      `Payouts on your account are generated automatically (${plan.scheduleLabel}).${next ? ` Your next payout is scheduled for ${next}.` : ''}`,
      409
    ));
  }

  let cycleWindow;
  if (plan.autoManaged) {
    // Emergency manual request while the scheduler is paused — label it with
    // the run period the funds were accumulating in.
    cycleWindow = withLabel(cyclePeriodFor(plan.cycle, lastRunAt(plan.cycle, new Date()) || new Date()));
  } else {
    const window = await getRequestWindow();
    if (!window.open) {
      return next(new AppError(
        `The withdrawal window is closed. It opens ${window.start.toISOString().slice(0, 10)} for the "${window.label}" cycle.`,
        400
      ));
    }
    cycleWindow = { start: window.cycle.start, end: window.cycle.end, label: window.cycle.label };
  }

  // Validate payout method ownership + verification when provided
  let method;
  try {
    method = await resolvePayoutMethod({ supplierId, payoutMethodId });
  } catch (err) {
    return next(err);
  }
  if (!method) {
    return next(new AppError('Add and verify a payout method before requesting a payout', 400));
  }

  // Resolve candidate bookings
  const candidates = await selectEligibleBookings({ supplierId, bookingIds });

  if (candidates.length === 0) {
    return next(new AppError('No eligible bookings found for a payout request', 400));
  }
  if (Array.isArray(bookingIds) && bookingIds.length > candidates.length) {
    return next(new AppError('Some selected bookings are not eligible (already requested, disputed, or still clearing)', 400));
  }

  let requests;
  let totalFeesDeducted;
  try {
    const result = await createRequestsForBookings({
      supplierId,
      bookings: candidates,
      method,
      cycleWindow,
      notes: notes || null,
      autoGenerated: false,
    });
    requests = result.requests;
    totalFeesDeducted = result.feesDeducted;
  } catch (err) {
    return next(err);
  }

  await logActivity({
    userId: req.user.id,
    action: 'payout_request.created',
    resource: 'PayoutRequest',
    resourceId: requests[0].id,
    metadata: {
      requests: requests.map((r) => ({ id: r.id, currency: r.currency, amount: toNumber(r.amount), bookings: r.bookingCount })),
      feesDeducted: Math.round(totalFeesDeducted * 100) / 100,
    },
  });

  await notifyPayoutRequestsCreated({ requests, supplierId, autoGenerated: false }).catch((err) =>
    console.error('[Finance] Payout notification failed:', err.message)
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
        payoutMethod: { select: { id: true, type: true, bankName: true, paypalEmail: true, accountName: true, mobileProvider: true, mobileNumber: true } },
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

/**
 * GET /finance/payout-settings
 * The supplier's automated payout schedule: current cadence, next run date,
 * and any change scheduled for the 1st of next month.
 */
exports.getPayoutSettings = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  if (!supplierId) return next(new AppError('Not authorized', 401));

  const plan = await getSupplierPayoutPlan(supplierId);
  res.status(200).json({ status: 'success', data: plan });
});

/**
 * PATCH /finance/payout-settings
 * Body: { cycle: 'WEEKLY' | 'TWICE_MONTHLY' | 'MONTHLY' }
 *
 * Changes take effect on the 1st of the following month (GetYourGuide rule) so
 * a supplier can never switch mid-cycle; a first enrolment applies immediately
 * so they are never left unmanaged.
 */
exports.updatePayoutSettings = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  if (!supplierId) return next(new AppError('Not authorized', 401));

  const { cycle } = req.body || {};
  if (!cycle) return next(new AppError('A payout cycle is required', 400));

  const plan = await updateSupplierPayoutPlan({
    supplierId,
    cycle: String(cycle).toUpperCase(),
    actorUserId: req.user?.id || null,
    actorEmail: req.user?.email || null,
  });

  const { enqueueNotification } = require('../services/queue');
  const labelFor = (value) => (plan.options.find((o) => o.value === value) || {}).label || value;

  enqueueNotification({
    userId: supplierId,
    type: 'PAYOUT_SCHEDULE_UPDATED',
    title: 'Payout schedule updated',
    message: plan.pendingCycle
      ? `Your payout schedule will switch to "${labelFor(plan.pendingCycle)}" on ${new Date(plan.pendingEffectiveAt).toISOString().slice(0, 10)}.`
      : `Your payout schedule is now "${labelFor(plan.cycle)}".${plan.nextRunAt ? ` Your next payout is ${new Date(plan.nextRunAt).toISOString().slice(0, 10)}.` : ''}`,
    data: { cycle: plan.cycle, pendingCycle: plan.pendingCycle, nextRunAt: plan.nextRunAt },
  }).catch(() => {});

  res.status(200).json({ status: 'success', data: plan });
});
