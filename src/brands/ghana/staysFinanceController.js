/**
 * Stays finance — parallel ledger for stay bookings.
 *
 * The tour finance tables (PayoutRequest, Invoice, Dispute, RefundClaim) are
 * bound to tour Booking; this module owns the stay equivalents. PayoutMethod
 * and the supplier payout cycle are shared because they describe the supplier,
 * not the product vertical.
 *
 * Until an admin stay-payout workflow exists, requests can be created and
 * cancelled by the supplier; they sit in PROCESSING exactly like a manual tour
 * request waiting for finance to release it.
 */

const crypto = require('crypto');
const prisma = require('../../core/services/prismaClient');
const AppError = require('../../core/services/appError');
const catchAsync = require('../../core/services/catchAsync');
const { getSupplierPayoutPlan } = require('../../core/services/payoutRuns');
const {
  supplierIdFor,
  objectOrEmpty,
  dateKey,
  displayBookingStatus,
} = require('./staysShared');

const NON_CANCELLED = { notIn: ['CANCELLED', 'NO_SHOW'] };

function reference(prefix) {
  return `${prefix}-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function money(value) {
  return Number(value || 0);
}

function serializeEarning(row) {
  const openDispute = (row.disputes || []).find(
    (dispute) => dispute.status === 'OPEN' || dispute.status === 'UNDER_REVIEW',
  );
  return {
    id: row.id,
    bookingId: row.id,
    bookingNumber: row.bookingNumber,
    travelDate: dateKey(row.checkIn),
    stayDate: dateKey(row.checkIn),
    paidAt: row.payoutStatus === 'PAID' ? row.updatedAt : null,
    grossAmount: money(row.amount),
    supplierPayout: money(row.supplierPayout),
    platformCommission: money(row.platformCommission),
    commissionRate: Number(row.commissionRate || 0),
    currency: row.currency || 'USD',
    payoutStatus: row.payoutStatus,
    status: displayBookingStatus(row.status),
    property: { name: row.property?.name || 'Property' },
    room: row.roomName || '—',
    customer: { name: row.guestName || row.customer?.name || 'Guest' },
    payoutRequest: row.payoutRequestItem?.payoutRequest
      ? {
        requestNumber: row.payoutRequestItem.payoutRequest.requestNumber,
        status: row.payoutRequestItem.payoutRequest.status,
      }
      : null,
    openDispute: openDispute
      ? { id: openDispute.id, status: openDispute.status }
      : null,
  };
}

const earningInclude = {
  property: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true } },
  payoutRequestItem: {
    include: { payoutRequest: { select: { requestNumber: true, status: true } } },
  },
  disputes: { select: { id: true, status: true } },
};

async function bookingsForSummary(supplierId) {
  return prisma.stayBooking.findMany({
    where: { supplierId, status: NON_CANCELLED },
    select: {
      status: true,
      payoutStatus: true,
      supplierPayout: true,
      amount: true,
      currency: true,
    },
  });
}

exports.getSummary = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const [plan, bookings, requests] = await Promise.all([
    getSupplierPayoutPlan(supplierId),
    bookingsForSummary(supplierId),
    prisma.stayPayoutRequest.findMany({
      where: { supplierId, status: { in: ['PROCESSING', 'APPROVED'] } },
      select: { amount: true, currency: true },
    }),
  ]);

  const inPayoutStatuses = new Set(['PENDING', 'ELIGIBLE']);
  const available = bookings.filter(
    (booking) => booking.status === 'COMPLETED' && inPayoutStatuses.has(booking.payoutStatus),
  );
  const pending = bookings.filter(
    (booking) => ['CONFIRMED', 'CHECKED_IN'].includes(booking.status)
      && inPayoutStatuses.has(booking.payoutStatus),
  );
  const paid = bookings.filter((booking) => booking.payoutStatus === 'PAID');
  const sum = (rows) => rows.reduce((total, row) => total + money(row.supplierPayout), 0);
  const currency = bookings.find((booking) => booking.currency)?.currency || 'USD';
  const now = new Date();
  const closesAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const payoutPlan = {
    ...plan,
    autoManaged: true,
    autoRunsEnabled: plan.autoRunsEnabled !== false,
    scheduleShortLabel: plan.scheduleLabel,
  };

  res.status(200).json({
    status: 'success',
    data: {
      availableBalance: { amount: sum(available), bookingCount: available.length },
      pendingClearance: {
        amount: sum(pending),
        bookingCount: pending.length,
        clearanceBufferDays: 0,
        currency,
      },
      inReview: {
        total: requests.reduce((total, request) => total + money(request.amount), 0),
        count: requests.length,
        requestCount: requests.length,
      },
      paidOut: { total: sum(paid), count: paid.length },
      withdrawalWindow: {
        open: available.length > 0 && Boolean(plan.hasVerifiedPayoutMethod),
        opensAt: now,
        closesAt,
      },
      currentCycle: { label: plan.scheduleLabel || '' },
      payoutPlan,
      currency,
    },
  });
});

exports.getEarnings = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 25));
  const statusFilter = req.query?.payoutStatus
    ? String(req.query.payoutStatus).split(',').map((value) => value.trim()).filter(Boolean)
    : null;

  const where = { supplierId, status: NON_CANCELLED };
  if (statusFilter?.length) where.payoutStatus = { in: statusFilter };

  const [rows, totalCount, allRows] = await Promise.all([
    prisma.stayBooking.findMany({
      where,
      include: earningInclude,
      orderBy: { checkIn: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stayBooking.count({ where }),
    prisma.stayBooking.findMany({
      where: { supplierId, status: NON_CANCELLED },
      select: { supplierPayout: true, payoutStatus: true },
    }),
  ]);

  const summary = {
    total: allRows.reduce((total, row) => total + money(row.supplierPayout), 0),
    eligible: allRows
      .filter((row) => row.payoutStatus === 'ELIGIBLE' || row.payoutStatus === 'PENDING')
      .reduce((total, row) => total + money(row.supplierPayout), 0),
    paid: allRows
      .filter((row) => row.payoutStatus === 'PAID')
      .reduce((total, row) => total + money(row.supplierPayout), 0),
  };

  res.status(200).json({
    status: 'success',
    data: {
      earnings: rows.map(serializeEarning),
      summary,
      pagination: {
        currentPage: page,
        limit,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
    },
  });
});

function serializePayoutRequest(request) {
  return {
    id: request.id,
    requestNumber: request.requestNumber,
    amount: money(request.amount),
    currency: request.currency,
    bookingCount: request.bookingCount,
    status: request.status,
    cycleLabel: request.cycleLabel || '',
    reference: request.reference || '',
    createdAt: request.createdAt,
    completedAt: request.status === 'COMPLETED' ? request.updatedAt : null,
    rejectedReason: request.status === 'REJECTED' ? request.notes || '' : '',
    autoGenerated: Boolean(request.autoGenerated),
    payoutMethod: request.payoutMethod
      ? { type: request.payoutMethod.type }
      : null,
  };
}

exports.getPayoutRequests = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 25));

  const [rows, totalCount] = await Promise.all([
    prisma.stayPayoutRequest.findMany({
      where: { supplierId },
      include: { payoutMethod: { select: { type: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stayPayoutRequest.count({ where: { supplierId } }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      requests: rows.map(serializePayoutRequest),
      pagination: {
        currentPage: page,
        limit,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
      summary: {},
    },
  });
});

exports.createPayoutRequest = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const plan = await getSupplierPayoutPlan(supplierId);

  const eligible = await prisma.stayBooking.findMany({
    where: {
      supplierId,
      status: 'COMPLETED',
      payoutStatus: { in: ['PENDING', 'ELIGIBLE'] },
      payoutRequestItem: null,
    },
    orderBy: { checkIn: 'asc' },
  });

  if (eligible.length === 0) {
    throw new AppError('No completed bookings are eligible for a payout yet', 400);
  }

  const currencies = [...new Set(eligible.map((booking) => booking.currency))];
  if (currencies.length > 1) {
    throw new AppError('Eligible bookings span multiple currencies; request each currency separately', 400);
  }

  const currency = currencies[0] || 'USD';
  const amount = eligible.reduce((total, booking) => total + money(booking.supplierPayout), 0);
  if (!(amount > 0)) throw new AppError('There is no payable balance to request', 400);

  let payoutMethodId = null;
  if (req.body?.payoutMethodId) {
    const method = await prisma.payoutMethod.findFirst({
      where: { id: req.body.payoutMethodId, supplierId },
      select: { id: true },
    });
    if (!method) throw new AppError('Payout method not found', 404);
    payoutMethodId = method.id;
  }

  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.stayPayoutRequest.create({
      data: {
        requestNumber: reference('SPR'),
        supplierId,
        amount,
        currency,
        bookingCount: eligible.length,
        status: 'PROCESSING',
        cycleLabel: plan.scheduleLabel || null,
        payoutMethodId,
        notes: typeof req.body?.notes === 'string' ? req.body.notes.trim() || null : null,
      },
    });

    await tx.stayPayoutRequestItem.createMany({
      data: eligible.map((booking) => ({
        payoutRequestId: created.id,
        stayBookingId: booking.id,
        grossAmount: booking.amount,
        platformCommission: booking.platformCommission,
        supplierPayout: booking.supplierPayout,
        currency: booking.currency,
      })),
    });

    await tx.stayBooking.updateMany({
      where: { id: { in: eligible.map((booking) => booking.id) } },
      data: { payoutStatus: 'REQUESTED' },
    });

    return created;
  });

  res.status(201).json({
    status: 'success',
    data: { request: serializePayoutRequest(request) },
  });
});

exports.cancelPayoutRequest = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const request = await prisma.stayPayoutRequest.findFirst({
    where: { id: req.params.id, supplierId },
    include: { items: { select: { stayBookingId: true } } },
  });
  if (!request) throw new AppError('Payout request not found', 404);
  if (!['PROCESSING', 'APPROVED'].includes(request.status)) {
    throw new AppError('This payout request can no longer be cancelled', 400);
  }

  await prisma.$transaction(async (tx) => {
    await tx.stayPayoutRequest.update({
      where: { id: request.id },
      data: { status: 'CANCELLED' },
    });
    await tx.stayBooking.updateMany({
      where: { id: { in: request.items.map((item) => item.stayBookingId) } },
      data: { payoutStatus: 'ELIGIBLE' },
    });
  });

  res.status(200).json({ status: 'success', data: { ok: true } });
});

exports.getCharges = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const rows = await prisma.staySupplierCharge.findMany({
    where: { supplierId },
    include: {
      stayBooking: { select: { bookingNumber: true, currency: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const openTotals = new Map();
  for (const row of rows) {
    if (row.status !== 'OPEN') continue;
    const currency = row.currency || 'USD';
    openTotals.set(currency, (openTotals.get(currency) || 0) + money(row.amount));
  }

  res.status(200).json({
    status: 'success',
    data: {
      charges: rows.map((row) => ({
        id: row.id,
        amount: money(row.amount),
        currency: row.currency,
        reason: row.reason,
        status: row.status,
        notes: row.notes || '',
        createdAt: row.createdAt,
        settledAt: row.settledAt,
        bookingId: row.stayBookingId,
        bookingNumber: row.stayBooking?.bookingNumber || '—',
        payoutRequestId: null,
        payoutRequestNumber: null,
      })),
      openTotals: [...openTotals.entries()].map(([currency, amount]) => ({ currency, amount })),
    },
  });
});

function serializeDispute(dispute) {
  return {
    id: dispute.id,
    disputeNumber: dispute.disputeNumber,
    reason: dispute.reason,
    description: dispute.description || '',
    status: dispute.status,
    resolution: dispute.resolution || '',
    refundAmount: dispute.refundAmount == null ? null : money(dispute.refundAmount),
    createdAt: dispute.createdAt,
    resolvedAt: dispute.resolvedAt,
    booking: {
      bookingNumber: dispute.stayBooking?.bookingNumber || '—',
      property: { name: dispute.stayBooking?.property?.name || 'Property' },
      travelDate: dateKey(dispute.stayBooking?.checkIn),
      grossAmount: money(dispute.stayBooking?.amount),
      currency: dispute.stayBooking?.currency || 'USD',
    },
  };
}

exports.getDisputes = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 25));
  const where = { supplierId };
  if (req.query?.status) {
    where.status = { in: String(req.query.status).split(',').map((value) => value.trim()) };
  }

  const [rows, totalCount] = await Promise.all([
    prisma.stayDispute.findMany({
      where,
      include: { stayBooking: { include: { property: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stayDispute.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      disputes: rows.map(serializeDispute),
      pagination: {
        currentPage: page,
        limit,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
    },
  });
});

exports.createDispute = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const body = objectOrEmpty(req.body);
  // The dashboard's refund form calls this `bookingId`; accept the older
  // `stayBookingId` spelling too so the API is not client-shape dependent.
  const bookingId = body.stayBookingId || body.bookingId;
  if (!bookingId) throw new AppError('Booking is required', 400);
  if (!body.reason) throw new AppError('A reason is required', 400);

  const booking = await prisma.stayBooking.findFirst({
    where: { id: bookingId, supplierId },
    select: { id: true, amount: true, currency: true },
  });
  if (!booking) throw new AppError('Booking not found', 404);

  const dispute = await prisma.stayDispute.create({
    data: {
      disputeNumber: reference('SDS'),
      stayBookingId: booking.id,
      openedById: req.user.id,
      supplierId,
      reason: String(body.reason),
      description: typeof body.description === 'string' ? body.description.trim() || null : null,
      status: 'OPEN',
      refundAmount: body.refundAmount != null ? Number(body.refundAmount) : money(booking.amount),
    },
    include: { stayBooking: { include: { property: { select: { name: true } } } } },
  });

  res.status(201).json({
    status: 'success',
    data: { dispute: serializeDispute(dispute) },
  });
});

exports.withdrawDispute = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await prisma.stayDispute.findFirst({
    where: { id: req.params.id, supplierId },
    select: { id: true, status: true },
  });
  if (!existing) throw new AppError('Dispute not found', 404);
  if (!['OPEN', 'UNDER_REVIEW'].includes(existing.status)) {
    throw new AppError('This dispute can no longer be withdrawn', 400);
  }

  const dispute = await prisma.stayDispute.update({
    where: { id: existing.id },
    data: { status: 'WITHDRAWN' },
    include: { stayBooking: { include: { property: { select: { name: true } } } } },
  });

  res.status(200).json({
    status: 'success',
    data: { dispute: serializeDispute(dispute) },
  });
});

function serializeClaim(claim) {
  return {
    id: claim.id,
    claimNumber: claim.claimNumber,
    reason: claim.reason,
    details: claim.details || '',
    type: claim.type,
    requestedAmount: claim.requestedAmount == null ? 0 : money(claim.requestedAmount),
    status: claim.status,
    createdAt: claim.createdAt,
    reviewNote: claim.reviewNote || null,
    releasedAmount: claim.releasedAmount == null ? 0 : money(claim.releasedAmount),
    booking: {
      bookingNumber: claim.stayBooking?.bookingNumber || '',
      grossAmount: money(claim.stayBooking?.amount),
      currency: claim.stayBooking?.currency || 'USD',
      customerName: claim.stayBooking?.guestName || claim.stayBooking?.customer?.name || 'Guest',
      customerEmail: claim.stayBooking?.guestEmail || claim.stayBooking?.customer?.email || '',
      propertyTitle: claim.stayBooking?.property?.name || 'Property',
    },
  };
}

exports.getRefundClaims = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const where = { supplierId };
  if (req.query?.status && req.query.status !== 'ALL') where.status = req.query.status;

  const rows = await prisma.stayRefundClaim.findMany({
    where,
    include: {
      stayBooking: {
        include: {
          property: { select: { name: true } },
          customer: { select: { name: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.status(200).json({
    status: 'success',
    data: { claims: rows.map(serializeClaim) },
  });
});

async function decideClaim(req, status, note = null) {
  const supplierId = supplierIdFor(req);
  const existing = await prisma.stayRefundClaim.findFirst({
    where: { id: req.params.id, supplierId },
    select: { id: true, status: true },
  });
  if (!existing) throw new AppError('Refund claim not found', 404);
  if (existing.status !== 'SUBMITTED') {
    throw new AppError('This claim has already been reviewed', 400);
  }

  return prisma.stayRefundClaim.update({
    where: { id: existing.id },
    data: {
      status,
      reviewedById: req.user.id,
      reviewedAt: new Date(),
      reviewNote: note,
    },
    include: {
      stayBooking: {
        include: {
          property: { select: { name: true } },
          customer: { select: { name: true, email: true } },
        },
      },
    },
  });
}

exports.approveRefundClaim = catchAsync(async (req, res) => {
  const claim = await decideClaim(req, 'SUPPLIER_APPROVED');
  res.status(200).json({ status: 'success', data: { claim: serializeClaim(claim) } });
});

exports.declineRefundClaim = catchAsync(async (req, res) => {
  const claim = await decideClaim(
    req,
    'SUPPLIER_DECLINED',
    typeof req.body?.note === 'string' ? req.body.note.trim() || null : null,
  );
  res.status(200).json({ status: 'success', data: { claim: serializeClaim(claim) } });
});
