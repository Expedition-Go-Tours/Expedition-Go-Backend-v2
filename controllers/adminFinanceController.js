const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { logActivity } = require('../utils/auditLogger');
const { enqueueNotification, enqueueEmail } = require('../utils/queue');
const { detachBookingFromActiveRequests, unfreezeBookingAfterDispute } = require('../utils/financeHelpers');
const { notifyDiscord } = require('../utils/discordNotifier');

// ── Finance v2 — admin processing of supplier payout requests + disputes ──
// Mounted at /admin/finance (see routes/adminFinanceRoutes.js).

function toNumber(v) {
  return v == null ? 0 : parseFloat(v);
}

const METHOD_SELECT = { id: true, type: true, isDefault: true, bankName: true, paypalEmail: true, accountName: true, accountNumber: true, swiftCode: true, iban: true };

// Requests migrated from pre finance-v2 data were backfilled without a payout
// method snapshot (payoutMethodId: null). Fall back to the supplier's current
// default verified method so admins see a real destination instead of
// "no method on file".
async function attachFallbackMethods(requests) {
  const missing = requests.filter((r) => !r.payoutMethod && r.supplierId);
  if (missing.length === 0) return;
  const supplierIds = [...new Set(missing.map((r) => r.supplierId))];
  const methods = await prisma.payoutMethod.findMany({
    where: { supplierId: { in: supplierIds }, verified: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { ...METHOD_SELECT, supplierId: true },
  });
  const bySupplier = {};
  for (const m of methods) {
    if (!bySupplier[m.supplierId]) bySupplier[m.supplierId] = m;
  }
  for (const r of missing) {
    r.payoutMethod = bySupplier[r.supplierId] || null;
  }
}

const REFERENCE_PLACEHOLDERS = new Set(['n/a', 'na', 'none', 'null', 'test', 'tbd', 'xxx', '-', 'pending']);

// Validate the transaction reference captured when marking a payout as sent.
// Light hygiene only: block placeholders and nonsense lengths without
// enforcing a single format — bank references vary by country/institution.
function normalizeReference(raw) {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!value) return { error: 'A payment reference is required to complete a payout' };
  if (REFERENCE_PLACEHOLDERS.has(value.toLowerCase())) {
    return { error: 'Reference looks like a placeholder. Enter the actual bank/PayPal transaction reference' };
  }
  if (value.length < 4) return { error: 'Reference is too short to be a valid transaction reference (min 4 characters)' };
  if (value.length > 100) return { error: 'Reference is too long (max 100 characters)' };
  return { value };
}

// Soft format hints — never blocking, just surfaced so the admin can double-check.
function referenceWarning(value, methodType) {
  const t = String(methodType || '').toUpperCase();
  if (t === 'PAYPAL' && !/^[A-Z0-9]{17}$/i.test(value)) {
    return "Reference doesn't match a typical PayPal transaction ID (17 letters/digits). Double-check before recording";
  }
  if (t === 'STRIPE' && !/^tr_/i.test(value)) {
    return "Reference doesn't match a typical Stripe transfer ID (tr_...). Double-check before recording";
  }
  return null;
}

/**
 * GET /admin/finance/payout-requests?status=&page=&limit=&search=
 * `summary.statusCounts` reflects the search filter (without status) so tabs
 * can show live counts per stage.
 */
exports.getPayoutRequests = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  const where = {};
  if (req.query.status) {
    where.status = { in: String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean) };
  }

  // Search scope (request number or supplier identity) — shared by the list
  // and the per-status counts so tab badges stay consistent with results.
  const searchWhere = {};
  const term = String(req.query.search || '').trim();
  if (term) {
    searchWhere.OR = [
      { requestNumber: { contains: term, mode: 'insensitive' } },
      { supplier: { name: { contains: term, mode: 'insensitive' } } },
      { supplier: { email: { contains: term, mode: 'insensitive' } } },
    ];
  }

  const [requests, totalCount, statusGroups] = await Promise.all([
    prisma.payoutRequest.findMany({
      where: { ...searchWhere, ...where },
      include: {
        supplier: { select: { id: true, name: true, email: true } },
        payoutMethod: { select: METHOD_SELECT },
        items: { include: { booking: { select: { bookingNumber: true, travelDate: true, tour: { select: { title: true } } } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.payoutRequest.count({ where: { ...searchWhere, ...where } }),
    prisma.payoutRequest.groupBy({
      by: ['status'],
      where: searchWhere,
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  const statusCounts = {};
  let grandTotal = 0;
  let grandAmount = 0;
  for (const g of statusGroups) {
    statusCounts[g.status] = g._count._all;
    grandTotal += g._count._all;
    grandAmount += parseFloat(g._sum.amount || 0);
  }

  await attachFallbackMethods(requests);

  res.status(200).json({
    status: 'success',
    data: {
      requests: requests.map((r) => ({ ...r, amount: toNumber(r.amount) })),
      pagination: { currentPage: page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
      summary: { statusCounts, totalCount: grandTotal, totalAmount: grandAmount },
    },
  });
});

/**
 * GET /admin/finance/payout-requests/:id
 */
exports.getPayoutRequestById = catchAsync(async (req, res, next) => {
  const request = await prisma.payoutRequest.findUnique({
    where: { id: req.params.id },
    include: {
      supplier: { select: { id: true, name: true, email: true } },
      payoutMethod: true,
      items: {
        include: {
          booking: {
            select: { bookingNumber: true, travelDate: true, grossAmount: true, currency: true, status: true, tour: { select: { title: true } } },
          },
        },
      },
    },
  });
  if (!request) return next(new AppError('Payout request not found', 404));
  await attachFallbackMethods([request]);

  res.status(200).json({
    status: 'success',
    data: {
      request: {
        ...request,
        amount: toNumber(request.amount),
        items: request.items.map((it) => ({
          ...it,
          grossAmount: toNumber(it.grossAmount),
          platformCommission: toNumber(it.platformCommission),
          supplierPayout: toNumber(it.supplierPayout),
        })),
      },
    },
  });
});

/**
 * PATCH /admin/finance/payout-requests/:id/approve
 * Authorizes the request for payment. Optional auto-complete via config
 * `payout.auto_complete_on_approve` ("true") — useful when a provider API
 * is wired in later.
 */
exports.approvePayoutRequest = catchAsync(async (req, res, next) => {
  const request = await prisma.payoutRequest.findFirst({
    where: { id: req.params.id, status: 'PROCESSING' },
    include: { supplier: { select: { id: true, name: true, email: true } }, items: true },
  });
  if (!request) return next(new AppError('Payout request not found or already processed', 404));

  const updated = await prisma.payoutRequest.update({
    where: { id: request.id },
    data: { status: 'APPROVED', approvedBy: req.user.id, approvedAt: new Date() },
  });

  await logActivity({
    userId: req.user.id,
    action: 'payout_request.approved',
    resource: 'PayoutRequest',
    resourceId: request.id,
    metadata: { requestNumber: request.requestNumber, amount: toNumber(request.amount), currency: request.currency },
  });

  enqueueNotification({
    userId: request.supplierId,
    type: 'PAYOUT_REQUEST_APPROVED',
    title: 'Payout Approved',
    message: `Your payout request ${request.requestNumber} has been approved and is being processed.`,
    data: { payoutRequestId: request.id },
  }).catch(() => {});

  enqueueEmail({ type: 'payout-request-approved', payoutRequestId: request.id }).catch((err) =>
    console.error('[Finance] Approval email failed:', err.message)
  );

  notifyDiscord(
    'approvals',
    `Payout request ${request.requestNumber} approved — ${toNumber(request.amount).toFixed(2)} ${request.currency}`,
    { title: 'Payout approved', cooldownKey: request.id }
  );

  // Optional auto-complete (provider integrations land here later)
  const getConfig = require('../utils/getConfig');
  const autoComplete = await getConfig('payout.auto_complete_on_approve', false);
  if (autoComplete === true || autoComplete === 'true') {
    req.params.id = request.id;
    req.body = { ...(req.body || {}), reference: req.body?.reference || `AUTO-${request.requestNumber}` };
    return exports.completePayoutRequest(req, res, next);
  }

  res.status(200).json({ status: 'success', data: { request: { ...updated, amount: toNumber(updated.amount) } } });
});

/**
 * PATCH /admin/finance/payout-requests/:id/reject
 * Body: { reason }
 * Returns all bookings to ELIGIBLE so the supplier can re-request.
 */
exports.rejectPayoutRequest = catchAsync(async (req, res, next) => {
  const { reason } = req.body || {};
  if (!reason) return next(new AppError('A rejection reason is required', 400));

  const request = await prisma.payoutRequest.findFirst({
    where: { id: req.params.id, status: 'PROCESSING' },
    include: { items: true },
  });
  if (!request) return next(new AppError('Payout request not found or already processed', 404));

  await prisma.$transaction(async (tx) => {
    await tx.payoutRequest.update({
      where: { id: request.id },
      data: { status: 'REJECTED', rejectedBy: req.user.id, rejectedAt: new Date(), rejectedReason: reason },
    });
    await tx.booking.updateMany({
      where: { id: { in: request.items.map((i) => i.bookingId) }, payoutStatus: 'REQUESTED' },
      data: { payoutStatus: 'ELIGIBLE' },
    });
  });

  await logActivity({
    userId: req.user.id,
    action: 'payout_request.rejected',
    resource: 'PayoutRequest',
    resourceId: request.id,
    metadata: { requestNumber: request.requestNumber, reason },
  });

  enqueueNotification({
    userId: request.supplierId,
    type: 'PAYOUT_REQUEST_REJECTED',
    title: 'Payout Request Rejected',
    message: `Your payout request ${request.requestNumber} was rejected: ${reason}`,
    data: { payoutRequestId: request.id },
  }).catch(() => {});

  res.status(200).json({ status: 'success', data: { request: { id: request.id, status: 'REJECTED' } } });
});

/**
 * PATCH /admin/finance/payout-requests/:id/complete
 * Body: { reference, notes? }
 * Marks funds as sent. Cascades:
 *  - immutable ledger Payout row per booking item
 *  - Booking.payoutStatus → PAID
 *  - PayoutRequest → COMPLETED
 * Blocked while any included booking has an open dispute.
 */
exports.completePayoutRequest = catchAsync(async (req, res, next) => {
  const { reference, notes } = req.body || {};

  const request = await prisma.payoutRequest.findFirst({
    where: { id: req.params.id, status: { in: ['PROCESSING', 'APPROVED'] } },
    include: {
      items: { include: { booking: { select: { id: true, bookingNumber: true, payoutStatus: true, disputes: { where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } }, select: { disputeNumber: true } } } } } },
      supplier: { select: { name: true, email: true } },
      payoutMethod: { select: { type: true } },
    },
  });
  if (!request) return next(new AppError('Payout request not found or already completed', 404));

  const refCheck = normalizeReference(reference);
  if (refCheck.error) return next(new AppError(refCheck.error, 400));
  const referenceValue = refCheck.value;

  const disputed = request.items.filter((it) => it.booking.disputes.length > 0);
  if (disputed.length > 0) {
    return next(new AppError(
      `Cannot complete — ${disputed.length} booking(s) have open disputes (${disputed.map((d) => d.booking.disputes[0].disputeNumber).join(', ')}). Resolve them first.`,
      409
    ));
  }

  await prisma.$transaction(async (tx) => {
    for (const item of request.items) {
      await tx.payout.create({
        data: {
          supplierId: request.supplierId,
          bookingId: item.bookingId,
          amount: item.supplierPayout,
          currency: item.currency,
          commissionAmount: item.platformCommission,
          status: 'PAID',
          payoutMethodId: request.payoutMethodId,
          processedAt: new Date(),
          paidAt: new Date(),
          reference: referenceValue,
        },
      });
    }

    await tx.booking.updateMany({
      where: { id: { in: request.items.map((i) => i.bookingId) } },
      data: { payoutStatus: 'PAID' },
    });

    await tx.payoutRequest.update({
      where: { id: request.id },
      data: { status: 'COMPLETED', completedBy: req.user.id, completedAt: new Date(), reference: referenceValue, notes: notes || request.notes },
    });
  });

  await logActivity({
    userId: req.user.id,
    action: 'payout_request.completed',
    resource: 'PayoutRequest',
    resourceId: request.id,
    metadata: { requestNumber: request.requestNumber, reference: referenceValue, bookings: request.bookingCount },
  });

  enqueueNotification({
    userId: request.supplierId,
    type: 'PAYOUT_COMPLETED',
    title: 'Payout Sent',
    message: `Your payout of ${toNumber(request.amount).toFixed(2)} ${request.currency} (${request.requestNumber}) has been sent. Reference: ${referenceValue}`,
    data: { payoutRequestId: request.id },
  }).catch(() => {});

  enqueueEmail({ type: 'payout-completed', payoutRequestId: request.id }).catch((err) =>
    console.error('[Finance] Completion email failed:', err.message)
  );

  const methodWarning = referenceWarning(referenceValue, request.payoutMethod?.type);
  res.status(200).json({
    status: 'success',
    data: {
      request: { id: request.id, status: 'COMPLETED', reference: referenceValue },
      ...(methodWarning ? { warning: methodWarning } : {}),
    },
  });
});

/**
 * GET /admin/disputes?status=&page=&limit=
 */
exports.getDisputes = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  const where = {};
  if (req.query.status) {
    where.status = { in: String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean) };
  }

  const [disputes, totalCount] = await Promise.all([
    prisma.dispute.findMany({
      where,
      include: {
        booking: {
          select: {
            bookingNumber: true, travelDate: true, grossAmount: true, currency: true, status: true, refundAmount: true,
            tour: { select: { title: true } },
            customer: { select: { name: true, email: true } },
          },
        },
        opener: { select: { name: true, email: true } },
        supplier: { select: { name: true, email: true } },
        resolvedBy: { select: { name: true } },
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
 * GET /admin/disputes/:id
 */
exports.getDisputeById = catchAsync(async (req, res, next) => {
  const dispute = await prisma.dispute.findUnique({
    where: { id: req.params.id },
    include: {
      booking: {
        include: {
          tour: { select: { title: true, slug: true } },
          customer: { select: { name: true, email: true } },
        },
      },
      opener: { select: { name: true, email: true } },
      supplier: { select: { name: true, email: true } },
      resolvedBy: { select: { name: true } },
    },
  });
  if (!dispute) return next(new AppError('Dispute not found', 404));

  res.status(200).json({
    status: 'success',
    data: { dispute: { ...dispute, refundAmount: dispute.refundAmount == null ? null : toNumber(dispute.refundAmount) } },
  });
});

/**
 * PATCH /admin/disputes/:id/resolve
 * Body: { outcome: 'CUSTOMER'|'SUPPLIER'|'WITHDRAWN', resolution, refundAmount? }
 *
 * Supplier-initiated refund requests. The supplier files; the admin decides:
 * CUSTOMER  → refund approved. Stripe-refund the customer, cancel the
 *             booking's funds, detach from active payout requests. The booking
 *             itself is only cancelled when the tour is still upcoming — a
 *             tour that already ran keeps its status and is just marked
 *             refunded.
 * SUPPLIER  → refund denied. Unfreeze funds back to ELIGIBLE.
 * WITHDRAWN → supplier pulled their request; same as SUPPLIER financially.
 */
exports.resolveDispute = catchAsync(async (req, res, next) => {
  const { outcome, resolution, refundAmount } = req.body || {};
  if (!['CUSTOMER', 'SUPPLIER', 'WITHDRAWN'].includes(outcome)) {
    return next(new AppError('outcome must be CUSTOMER, SUPPLIER, or WITHDRAWN', 400));
  }
  if (!resolution) return next(new AppError('A resolution note is required', 400));

  const dispute = await prisma.dispute.findFirst({
    where: { id: req.params.id, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
    include: {
      booking: true,
      opener: { select: { name: true, email: true } },
    },
  });
  if (!dispute) return next(new AppError('Refund request not found or already resolved', 404));

  const statusMap = { CUSTOMER: 'RESOLVED_CUSTOMER', SUPPLIER: 'RESOLVED_SUPPLIER', WITHDRAWN: 'WITHDRAWN' };
  const outcomeLabel = { CUSTOMER: 'approved', SUPPLIER: 'denied', WITHDRAWN: 'withdrawn' }[outcome];

  let stripeRefundId = null;
  let refundedAmount = null;
  if (outcome === 'CUSTOMER') {
    const amount = refundAmount != null ? refundAmount : dispute.booking.refundAmount != null ? toNumber(dispute.booking.refundAmount) : toNumber(dispute.booking.grossAmount);
    refundedAmount = amount;
    if (dispute.booking.stripePaymentIntentId && dispute.booking.paymentStatus === 'SUCCEEDED') {
      try {
        const { createRefund } = require('../utils/stripeHelpers');
        const refund = await createRefund(dispute.booking.stripePaymentIntentId, Math.round(amount * 100));
        stripeRefundId = refund?.id || null;
      } catch (err) {
        console.error(`[Dispute] Stripe refund failed for booking ${dispute.booking.id}:`, err.message);
        return next(new AppError(`Stripe refund failed: ${err.message}. Resolve manually once refunded.`, 502));
      }
    }

    // A tour that hasn't happened yet should disappear from the customer's
    // itinerary; one that already ran keeps its historical status.
    const tourUpcoming = new Date(dispute.booking.travelDate).getTime() > Date.now();

    await prisma.$transaction(async (tx) => {
      await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: statusMap[outcome],
          resolution,
          resolvedById: req.user.id,
          resolvedAt: new Date(),
          refundAmount: amount,
        },
      });
      await tx.booking.update({
        where: { id: dispute.booking.id },
        data: {
          ...(tourUpcoming ? { status: 'CANCELLED', cancelledAt: dispute.booking.cancelledAt || new Date() } : {}),
          cancellationReason: `Refund request ${dispute.disputeNumber}: ${resolution}`,
          paymentStatus: 'REFUNDED',
          refundAmount: amount,
          refundedAt: new Date(),
          payoutStatus: 'CANCELLED',
        },
      });
      await detachBookingFromActiveRequests(tx, dispute.booking.id);
    });
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: statusMap[outcome],
          resolution,
          resolvedById: req.user.id,
          resolvedAt: new Date(),
          refundAmount: outcome === 'SUPPLIER' ? (refundAmount != null ? refundAmount : null) : null,
        },
      });
      await unfreezeBookingAfterDispute(tx, dispute.booking.id);
    });
  }

  await logActivity({
    userId: req.user.id,
    action: 'dispute.resolved',
    resource: 'Dispute',
    resourceId: dispute.id,
    metadata: { disputeNumber: dispute.disputeNumber, outcome, refundAmount: refundedAmount, stripeRefundId },
  });

  enqueueNotification({
    userId: dispute.supplierId,
    type: 'DISPUTE_RESOLVED',
    title: outcome === 'CUSTOMER' ? 'Refund Request Approved' : outcome === 'SUPPLIER' ? 'Refund Request Denied' : 'Refund Request Withdrawn',
    message: `Refund request ${dispute.disputeNumber} was ${outcomeLabel}.${outcome === 'CUSTOMER' ? ' The customer has been refunded.' : ' The funds are back in your eligible balance.'}`,
    data: { disputeId: dispute.id },
  }).catch(() => {});

  if (outcome === 'CUSTOMER' && dispute.booking.customerId) {
    enqueueNotification({
      userId: dispute.booking.customerId,
      type: 'REFUND_ISSUED',
      title: 'Refund Issued',
      message: `A refund for your booking (${dispute.booking.bookingNumber}) has been processed. It should appear on your original payment method within 5-10 business days.`,
      data: { bookingId: dispute.booking.id },
    }).catch(() => {});
  }

  res.status(200).json({ status: 'success', data: { dispute: { id: dispute.id, status: statusMap[outcome], stripeRefundId } } });
});
