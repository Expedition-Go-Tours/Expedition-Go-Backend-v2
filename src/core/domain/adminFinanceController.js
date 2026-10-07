const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const { logActivity } = require('../services/auditLogger');
const { enqueueNotification, enqueueEmail } = require('../services/queue');
const { detachBookingFromActiveRequests, unfreezeBookingAfterDispute, payoutBookingsWhere, eligibleBookingsWhere } = require('../services/financeHelpers');
const { markInvoicePaid, detachBookingFromInvoices } = require('../services/invoiceService');
const { notifyDiscord } = require('../services/discordNotifier');
const {
  buildPayoutPlan,
  getDefaultCycle,
  autoRunsEnabled,
  updateSupplierPayoutPlan,
  resolveEffectiveCycle,
  nextRunAt,
  compareSchedulesForTriage,
  VALID_CYCLES,
  CYCLE_META,
  getMinThreshold,
  cyclePeriodFor,
  withLabel,
} = require('../services/payoutRuns');

// ── Finance v2 — admin processing of supplier payout requests + disputes ──
// Mounted at /admin/finance (see routes/adminFinanceRoutes.js).

function toNumber(v) {
  return v == null ? 0 : parseFloat(v);
}

const METHOD_SELECT = { id: true, type: true, isDefault: true, bankName: true, paypalEmail: true, accountName: true, accountNumber: true, swiftCode: true, iban: true, mobileProvider: true, mobileNumber: true };

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

  // Whitelisted column sort for the ops table. Without a server-side sort a
  // clickable "Amount" header can only reshuffle the 20 rows already loaded,
  // which reads as "sorted" while silently ignoring the rest of the queue.
  // Only scalar columns on PayoutRequest are sortable -- `bookingCount` is a
  // relation count and would need a groupBy, so it is deliberately absent.
  // A Map, not an object literal: an object literal inherits from
  // Object.prototype, so `__proto__` / `constructor` / `toString` look up to a
  // truthy value and would pass the whitelist straight into `orderBy`.
  const SORTABLE = new Map([
    ['amount', 'amount'],
    ['createdAt', 'createdAt'],
    ['status', 'status'],
    ['requestNumber', 'requestNumber'],
  ]);
  const sortKey = SORTABLE.get(String(req.query.sortBy || '').trim());
  const sortDir = String(req.query.sortOrder || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
  // Always append a deterministic tie-break, otherwise rows sharing the sorted
  // value can drift between pages and appear twice or not at all.
  const orderBy = sortKey
    ? [{ [sortKey]: sortDir }, { createdAt: 'desc' }, { id: 'desc' }]
    : [{ createdAt: 'desc' }, { id: 'desc' }];

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
      orderBy,
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
      // `bookingCount` is declared on the client type but was never emitted, so
      // every row rendered a blank Bookings cell and the reject/complete
      // confirmation dialogs read "all undefined bookings". `items` is always
      // included by the query above and is not touched by
      // attachFallbackMethods, so its length is authoritative here.
      requests: requests.map((r) => ({
        ...r,
        amount: toNumber(r.amount),
        bookingCount: r.items?.length ?? 0,
      })),
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

  const { approvalPayoutResult } = require('../services/channelEmbeds');
  const approvedEmbed = approvalPayoutResult({
    requestNumber: request.requestNumber,
    amount: toNumber(request.amount),
    currency: request.currency,
    action: 'approved',
  });
  notifyDiscord('approvals', approvedEmbed.content, approvedEmbed.opts);

  // Optional auto-complete (provider integrations land here later)
  const getConfig = require('../services/getConfig');
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

  notifyDiscord(
    'approvals',
    `Payout request ${request.requestNumber} completed — funds sent.`,
    {
      title: 'Payout Completed',
      color: 0x00c853,
      fields: [
        { name: 'Request #', value: request.requestNumber, inline: true },
        { name: 'Amount', value: `${request.currency} ${toNumber(request.amount).toFixed(2)}`, inline: true },
        { name: 'Reference', value: referenceValue || 'N/A', inline: true },
      ],
      cooldownKey: request.id,
    }
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

// ── Finance v3 — invoices (automatic GetYourGuide-style billing) ──
// Money movement stays manual: an admin records the real bank reference and
// the invoice leaves the supplier's balance; there is no provider API.

/**
 * GET /admin/finance/invoices?status=&page=&limit=&search=&sortBy=&sortOrder=
 */
exports.getInvoices = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  const where = {};
  if (req.query.status) {
    where.status = { in: String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean) };
  }

  // Whitelisted scalar-column sort (mirrors getPayoutRequests; avoids
  // prototype-key injection via an object literal).
  const SORTABLE = new Map([
    ['invoiceNumber', 'invoiceNumber'],
    ['netTotal', 'netTotal'],
    ['status', 'status'],
    ['invoicedAt', 'invoicedAt'],
    ['createdAt', 'createdAt'],
  ]);
  const sortKey = SORTABLE.get(String(req.query.sortBy || '').trim());
  const sortDir = String(req.query.sortOrder || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const orderBy = sortKey
    ? [{ [sortKey]: sortDir }, { createdAt: 'desc' }, { id: 'desc' }]
    : [{ createdAt: 'desc' }, { id: 'desc' }];

  const searchWhere = {};
  const term = String(req.query.search || '').trim();
  if (term) {
    searchWhere.OR = [
      { invoiceNumber: { contains: term, mode: 'insensitive' } },
      { reference: { contains: term, mode: 'insensitive' } },
      { supplier: { name: { contains: term, mode: 'insensitive' } } },
      { supplier: { email: { contains: term, mode: 'insensitive' } } },
    ];
  }

  const [invoices, totalCount, statusGroups] = await Promise.all([
    prisma.invoice.findMany({
      where: { ...searchWhere, ...where },
      include: {
        supplier: { select: { id: true, name: true, email: true, logoUrl: true } },
        payoutMethod: { select: METHOD_SELECT },
        items: { include: { booking: { select: { bookingNumber: true, travelDate: true, tour: { select: { title: true } } } } } },
      },
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.invoice.count({ where: { ...searchWhere, ...where } }),
    prisma.invoice.groupBy({
      by: ['status'],
      where: searchWhere,
      _count: { _all: true },
      _sum: { netTotal: true },
    }),
  ]);

  const statusCounts = {};
  let grandTotal = 0;
  let grandAmount = 0;
  for (const g of statusGroups) {
    statusCounts[g.status] = g._count._all;
    grandTotal += g._count._all;
    grandAmount += parseFloat(g._sum.netTotal || 0);
  }

  res.status(200).json({
    status: 'success',
    data: {
      invoices: invoices.map((inv) => ({
        ...inv,
        grossTotal: toNumber(inv.grossTotal),
        commissionTotal: toNumber(inv.commissionTotal),
        netTotal: toNumber(inv.netTotal),
        bookingCount: inv.items?.length ?? inv.bookingCount,
      })),
      pagination: { currentPage: page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
      summary: { statusCounts, totalCount: grandTotal, totalAmount: grandAmount },
    },
  });
});

/**
 * GET /admin/finance/invoices/:id — full invoice with booking line items
 */
exports.getInvoiceById = catchAsync(async (req, res, next) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: {
      supplier: { select: { id: true, name: true, email: true } },
      payoutMethod: { select: METHOD_SELECT },
      items: {
        orderBy: { createdAt: 'asc' },
        include: {
          booking: {
            select: {
              id: true,
              bookingNumber: true,
              travelDate: true,
              selectedTime: true,
              status: true,
              paymentStatus: true,
              payoutStatus: true,
              grossAmount: true,
              supplierPayout: true,
              platformCommission: true,
              customer: { select: { id: true, name: true, email: true } },
              tour: { select: { id: true, title: true, imageCover: true } },
            },
          },
        },
      },
    },
  });
  if (!invoice) return next(new AppError('Invoice not found', 404));

  res.status(200).json({
    status: 'success',
    data: {
      invoice: {
        ...invoice,
        grossTotal: toNumber(invoice.grossTotal),
        commissionTotal: toNumber(invoice.commissionTotal),
        netTotal: toNumber(invoice.netTotal),
        items: invoice.items.map((i) => ({
          ...i,
          grossAmount: toNumber(i.grossAmount),
          platformCommission: toNumber(i.platformCommission),
          supplierPayout: toNumber(i.supplierPayout),
        })),
      },
    },
  });
});

/**
 * PATCH /admin/finance/invoices/:id/mark-paid
 * Records the real bank/transaction reference; invoice → PAID and its
 * bookings' payoutStatus → PAID. Only INVOICED invoices can be marked paid.
 */
exports.markInvoicePaid = catchAsync(async (req, res, next) => {
  const { reference } = req.body || {};
  if (!reference || !String(reference).trim()) {
    return next(new AppError('Please provide the bank/transaction reference', 400));
  }

  const paid = await markInvoicePaid({
    invoiceId: req.params.id,
    reference,
    adminUserId: req.user.id,
    adminEmail: req.user.email,
  });

  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    select: {
      invoiceNumber: true,
      supplierId: true,
      currency: true,
      netTotal: true,
      reference: true,
      paidAt: true,
    },
  });

  if (invoice) {
    enqueueNotification({
      userId: invoice.supplierId,
      type: 'INVOICE_PAID',
      title: 'Invoice Paid',
      message: `Your invoice ${invoice.invoiceNumber} of ${toNumber(invoice.netTotal).toFixed(2)} ${invoice.currency} has been paid. Reference: ${invoice.reference || 'N/A'}`,
      data: { invoiceId: req.params.id, invoiceNumber: invoice.invoiceNumber },
    }).catch(() => {});

    notifyDiscord(
      'approvals',
      `Invoice ${invoice.invoiceNumber} marked as paid.`,
      {
        title: 'Invoice Paid',
        color: 0x00c853,
        fields: [
          { name: 'Invoice #', value: invoice.invoiceNumber, inline: true },
          { name: 'Amount', value: `${invoice.currency} ${toNumber(invoice.netTotal).toFixed(2)}`, inline: true },
          { name: 'Reference', value: invoice.reference || 'N/A', inline: true },
        ],
        cooldownKey: req.params.id,
      }
    ).catch(() => {});
  }

  res.status(200).json({
    status: 'success',
    data: { invoice: paid },
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
    const grossAmount = toNumber(dispute.booking.grossAmount);
    const amount = refundAmount != null ? refundAmount : dispute.booking.refundAmount != null ? toNumber(dispute.booking.refundAmount) : grossAmount;
    // Hard upper bound: never refund more than was actually charged.
    if (!Number.isFinite(amount) || amount < 0 || amount > grossAmount) {
      return next(new AppError(`refundAmount must be between 0 and ${grossAmount.toFixed(2)} (the booking gross amount)`, 400));
    }
    refundedAmount = amount;
    if (dispute.booking.stripePaymentIntentId && dispute.booking.paymentStatus === 'SUCCEEDED') {
      try {
        const { createRefund } = require('../services/stripeHelpers');
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
      // Finance v3: a refunded booking must leave any unpaid invoice too.
      await detachBookingFromInvoices(tx, dispute.booking.id);
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

  notifyDiscord(
    'approvals',
    `Refund request ${dispute.disputeNumber} ${outcome === 'CUSTOMER' ? 'approved — customer refunded' : outcome === 'SUPPLIER' ? 'denied — funds unfrozen' : 'withdrawn'}.`,
    {
      title: `Refund Request ${outcomeLabel.charAt(0).toUpperCase() + outcomeLabel.slice(1)}`,
      color: outcome === 'CUSTOMER' ? 0x00c853 : 0xff4444,
      fields: [
        { name: 'Request #', value: dispute.disputeNumber, inline: true },
        { name: 'Outcome', value: outcome, inline: true },
        { name: 'Amount', value: refundedAmount != null ? `${dispute.booking.currency || 'USD'} ${refundedAmount.toFixed(2)}` : '—', inline: true },
        { name: 'Resolution', value: resolution.slice(0, 1024), inline: false },
      ],
      cooldownKey: dispute.id,
    }
  ).catch(() => {});

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

// ── Payout schedules (automated runs) ──────────────────────────────────────
// Admin visibility + override for the GetYourGuide-style supplier payout
// cadences. A supplier with a payoutCycle is enrolled and paid automatically on
// their run dates; these endpoints let finance see who is enrolled, when their
// next run lands, and force a plan change when support needs to.

const PROFILE_PLAN_SELECT = {
  id: true,
  userId: true,
  status: true,
  payoutCycle: true,
  payoutCycleEffectiveAt: true,
  payoutCyclePending: true,
  payoutCyclePendingAt: true,
  user: { select: { id: true, name: true, email: true } },
};

/**
 * Eligible totals for a whole page of suppliers in two queries, instead of
 * one aggregate awaited per row — the loop this replaced did 20 sequential
 * round trips on a default page.
 *
 * Grouped by tour because `supplierId` lives on the tour relation, so the
 * aggregation stays in the database and only an id map comes back.
 *
 * @param {string[]} supplierIds
 * @returns {Promise<Map<string, {amount: number, count: number}>>} keyed by supplierId
 */
async function eligibleTotalsFor(supplierIds) {
  const totals = new Map();
  if (!supplierIds || supplierIds.length === 0) return totals;

  const byTour = await prisma.booking.groupBy({
    by: ['tourId'],
    where: payoutBookingsWhere({ supplierIds }),
    _sum: { supplierPayout: true },
    _count: { _all: true },
  });
  if (byTour.length === 0) return totals;

  const tours = await prisma.tour.findMany({
    where: { id: { in: byTour.map((r) => r.tourId) } },
    select: { id: true, supplierId: true },
  });
  const owner = new Map(tours.map((t) => [t.id, t.supplierId]));

  for (const row of byTour) {
    const supplierId = owner.get(row.tourId);
    if (!supplierId) continue;
    const current = totals.get(supplierId) || { amount: 0, count: 0 };
    current.amount += toNumber(row._sum?.supplierPayout);
    current.count += row._count?._all ?? 0;
    totals.set(supplierId, current);
  }
  return totals;
}

/**
 * Whether a supplier's automated run would actually fire, phrased the way
 * finance reads the queue.
 *
 * The order is the scheduler's own (generateDuePayoutRuns: destination, then
 * funds, then the minimum threshold — each of which causes a skip), so the
 * reason shown is the first thing that would make the run skip that
 * supplier. The global pause is checked last on purpose: it is already
 * bannered across the top of the tab, and leading with it would bury "this
 * supplier has no verified payout method" behind a switch that is wrong for
 * everyone.
 *
 * @returns {{code: string, label: string, detail: string, kind: 'ready'|'blocked'|'idle'}}
 */
function buildPayoutReadiness({ hasVerifiedMethod, amount, bookingCount, autoRuns, minThreshold }) {
  if (!hasVerifiedMethod) {
    return {
      code: 'NO_METHOD',
      label: 'No verified payout method',
      detail: 'The run skips suppliers with no verified destination for the money.',
      kind: 'blocked',
    };
  }
  if (!bookingCount) {
    return {
      code: 'NOTHING_ELIGIBLE',
      label: 'Nothing eligible yet',
      detail: 'No booking has cleared the payment window for this supplier, so the run has nothing to pay.',
      kind: 'idle',
    };
  }
  if (minThreshold > 0 && amount < minThreshold) {
    return {
      code: 'BELOW_MINIMUM',
      label: `Below the ${minThreshold.toFixed(2)} USD minimum`,
      detail: `The scheduler only fires at or above ${minThreshold.toFixed(2)} USD. This amount rolls into the next cadence.`,
      kind: 'blocked',
    };
  }
  if (autoRuns === false) {
    return {
      code: 'SCHEDULER_PAUSED',
      label: 'Runs are paused',
      detail: 'Automatic payout runs are switched off platform-wide, so nothing is released until they are switched back on.',
      kind: 'blocked',
    };
  }
  return {
    code: 'READY',
    label: 'Ready to run',
    detail: 'Funds cleared, a verified destination, and above the minimum — this supplier pays on their next run.',
    kind: 'ready',
  };
}

/**
 * GET /admin/finance/payout-schedules?page=&limit=&search=&cycle=
 * Every enrolled supplier with their cadence, next run date and eligible
 * balance (so finance can see what each upcoming run will pay).
 */
exports.getPayoutSchedules = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

  const where = { payoutCycle: { not: null } };
  const cycleFilter = String(req.query.cycle || '').toUpperCase();
  if (VALID_CYCLES.includes(cycleFilter)) where.payoutCycle = cycleFilter;

  const term = String(req.query.search || '').trim();
  const searchWhere = term
    ? {
        OR: [
          { user: { name: { contains: term, mode: 'insensitive' } } },
          { user: { email: { contains: term, mode: 'insensitive' } } },
        ],
      }
    : {};

  const [defaultCycle, autoRuns, profiles, byCycleRaw, pendingCount, missingMethodCount, planRows] = await Promise.all([
    getDefaultCycle(),
    autoRunsEnabled(),
    // No orderBy/skip/take: the triage order is derived (next run date), so we
    // project every match and page in memory below.
    prisma.supplierProfile.findMany({
      where: { ...where, ...searchWhere },
      select: PROFILE_PLAN_SELECT,
    }),
    prisma.supplierProfile.groupBy({
      by: ['payoutCycle'],
      where: { payoutCycle: { not: null } },
      _count: { _all: true },
    }),
    prisma.supplierProfile.count({ where: { payoutCyclePending: { not: null } } }),
    prisma.supplierProfile.count({
      where: { payoutCycle: { not: null }, user: { payoutMethods: { none: { verified: true } } } },
    }),
    prisma.supplierProfile.findMany({
      where: { payoutCycle: { not: null } },
      select: { payoutCycle: true, payoutCycleEffectiveAt: true, payoutCyclePending: true, payoutCyclePendingAt: true },
    }),
  ]);

  const now = new Date();
  const byCycle = {};
  for (const g of byCycleRaw) byCycle[g.payoutCycle] = g._count._all;

  // How many runs land in the next 7 days (so finance can staff the queue).
  const horizon = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  let runsNext7Days = 0;
  for (const p of planRows) {
    const cycle = resolveEffectiveCycle(p, now);
    if (!cycle) continue;
    const next = nextRunAt(cycle, now);
    if (next && next <= horizon) runsNext7Days += 1;
  }

  // Triage order — whoever's run is due soonest first (see
  // compareSchedulesForTriage). Project every match, sort, then page, so the
  // ordering holds across pages instead of only within one.
  const projected = profiles
    .map((p) => ({ profile: p, plan: buildPayoutPlan(p, { now, defaultCycle, autoRuns }) }))
    .sort(compareSchedulesForTriage);

  const paged = projected.slice((page - 1) * limit, (page - 1) * limit + limit);

  const supplierIds = paged.map(({ profile }) => profile.userId);
  const [verifiedMethods, minThreshold, eligibleBySupplier] = await Promise.all([
    supplierIds.length
      ? prisma.payoutMethod.findMany({
          where: { supplierId: { in: supplierIds }, verified: true },
          select: { supplierId: true },
        })
      : [],
    getMinThreshold(),
    eligibleTotalsFor(supplierIds),
  ]);
  const hasMethod = new Set(verifiedMethods.map((m) => m.supplierId));

  const schedules = [];
  for (const { profile: p, plan } of paged) {
    const eligible = eligibleBySupplier.get(p.userId) || { amount: 0, count: 0 };
    const method = hasMethod.has(p.userId);

    schedules.push({
      supplierId: p.userId,
      name: p.user?.name || null,
      email: p.user?.email || null,
      status: p.status,
      plan,
      eligibleBalance: {
        amount: eligible.amount,
        bookingCount: eligible.count,
        currency: 'USD',
      },
      hasVerifiedMethod: method,
      // Why the figure is what it is — a zero on its own is unactionable, and
      // 38 of these suppliers currently show one.
      readiness: buildPayoutReadiness({
        hasVerifiedMethod: method,
        amount: eligible.amount,
        bookingCount: eligible.count,
        autoRuns,
        minThreshold,
      }),
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      schedules,
      pagination: { currentPage: page, limit, totalCount: projected.length, totalPages: Math.ceil(projected.length / limit) },
      cycles: VALID_CYCLES.map((c) => ({ value: c, ...CYCLE_META[c] })),
      summary: {
        enrolled: Object.values(byCycle).reduce((s, n) => s + n, 0),
        byCycle,
        pendingChanges: pendingCount,
        missingVerifiedMethod: missingMethodCount,
        runsNext7Days,
      },
      autoRunsEnabled: autoRuns,
      defaultCycle,
    },
  });
});

/**
 * GET /admin/finance/payout-schedules/:supplierId
 */
exports.getSupplierPayoutSchedule = catchAsync(async (req, res, next) => {
  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.params.supplierId },
    select: PROFILE_PLAN_SELECT,
  });
  if (!profile) return next(new AppError('Supplier not found', 404));

  const [defaultCycle, autoRuns, minThreshold, eligible, verifiedMethodCount] = await Promise.all([
    getDefaultCycle(),
    autoRunsEnabled(),
    getMinThreshold(),
    prisma.booking.aggregate({
      where: eligibleBookingsWhere(profile.userId),
      _sum: { supplierPayout: true },
      _count: true,
    }),
    prisma.payoutMethod.count({ where: { supplierId: profile.userId, verified: true } }),
  ]);

  const amount = toNumber(eligible._sum.supplierPayout);
  const bookingCount = eligible._count;
  const hasVerifiedMethod = verifiedMethodCount > 0;

  res.status(200).json({
    status: 'success',
    data: {
      supplierId: profile.userId,
      name: profile.user?.name || null,
      email: profile.user?.email || null,
      status: profile.status,
      plan: buildPayoutPlan(profile, { defaultCycle, autoRuns }),
      eligibleBalance: { amount, bookingCount, currency: 'USD' },
      hasVerifiedMethod,
      readiness: buildPayoutReadiness({ hasVerifiedMethod, amount, bookingCount, autoRuns, minThreshold }),
      cycles: VALID_CYCLES.map((c) => ({ value: c, ...CYCLE_META[c] })),
      autoRunsEnabled: autoRuns,
      defaultCycle,
    },
  });
});

/**
 * GET /admin/finance/payout-schedules/:supplierId/eligible-bookings
 *
 * The line items behind the "Eligible now" figure — every booking the next
 * run would claim, so a row expanded underneath the total can never show a
 * different total than the cell above it. Both sides come from
 * `eligibleBookingsWhere`, the same clause that decides what gets paid.
 *
 * Fetched lazily, one supplier at a time: the list response covers 40
 * suppliers and joining their line items into it would multiply the payload
 * for rows nobody has opened.
 *
 * Also reports whether each booking's travel date actually falls inside the
 * cadence window the row is labelled with. The label describes the *run*
 * ("covering Sep 28 – Oct 4") while the figure is "everything cleared so
 * far" — with a clearance buffer those are genuinely different sets, and an
 * outside-window booking is normal, not an error. Flagging it means the
 * mismatch is visible rather than implied.
 */
exports.getSupplierEligibleBookings = catchAsync(async (req, res, next) => {
  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.params.supplierId },
    select: PROFILE_PLAN_SELECT,
  });
  if (!profile) return next(new AppError('Supplier not found', 404));

  const [defaultCycle, autoRuns, minThreshold, bookings, verifiedMethodCount] = await Promise.all([
    getDefaultCycle(),
    autoRunsEnabled(),
    getMinThreshold(),
    prisma.booking.findMany({
      where: eligibleBookingsWhere(profile.userId),
      // Oldest first: this is money that has been waiting longest, which is
      // the order a finance officer reads it in.
      orderBy: [{ travelDate: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        bookingNumber: true,
        travelDate: true,
        supplierPayout: true,
        currency: true,
        status: true,
        paymentStatus: true,
        createdAt: true,
        tour: { select: { title: true } },
      },
    }),
    prisma.payoutMethod.count({ where: { supplierId: profile.userId, verified: true } }),
  ]);

  const plan = buildPayoutPlan(profile, { defaultCycle, autoRuns });

  // The window the row is labelled with, so each booking can be compared
  // against it. Null when the supplier has no cadence yet.
  const period = plan.cycle && plan.nextRunAt
    ? withLabel(cyclePeriodFor(plan.cycle, plan.nextRunAt))
    : null;

  const amount = bookings.reduce((sum, b) => sum + toNumber(b.supplierPayout), 0);
  const bookingCount = bookings.length;
  const hasVerifiedMethod = verifiedMethodCount > 0;

  const items = bookings.map((b) => {
    const travel = b.travelDate ? new Date(b.travelDate) : null;
    const inPeriod = period && travel
      ? travel >= new Date(period.start) && travel <= new Date(period.end)
      : null;
    return {
      id: b.id,
      bookingNumber: b.bookingNumber,
      tourTitle: b.tour?.title || null,
      travelDate: travel,
      supplierPayout: toNumber(b.supplierPayout),
      currency: b.currency || 'USD',
      status: b.status,
      paymentStatus: b.paymentStatus,
      clearedAt: b.createdAt,
      inPeriod,
    };
  });

  res.status(200).json({
    status: 'success',
    data: {
      supplierId: profile.userId,
      name: profile.user?.name || null,
      email: profile.user?.email || null,
      plan,
      // The cadence window this pot is attributed to, if there is one.
      period: period ? { start: period.start, end: period.end, label: period.label } : null,
      eligibleBalance: { amount, bookingCount, currency: 'USD' },
      hasVerifiedMethod,
      readiness: buildPayoutReadiness({ hasVerifiedMethod, amount, bookingCount, autoRuns, minThreshold }),
      // True when at least one booking travelled outside the labelled window.
      straddlesPeriod: items.some((i) => i.inPeriod === false),
      bookings: items,
      autoRunsEnabled: autoRuns,
      defaultCycle,
    },
  });
});

/**
 * PATCH /admin/finance/payout-schedules/:supplierId
 * Body: { cycle, immediate?, note? }
 * `immediate: false` (default) honours the 1st-of-next-month rule; passing
 * `immediate: true` forces the change onto the next run date regardless.
 */
exports.updateSupplierPayoutSchedule = catchAsync(async (req, res, next) => {
  const { cycle, immediate = false, note } = req.body || {};
  if (!cycle) return next(new AppError('A payout cycle is required', 400));

  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.params.supplierId },
    select: { id: true },
  });
  if (!profile) return next(new AppError('Supplier not found', 404));

  const plan = await updateSupplierPayoutPlan({
    supplierId: req.params.supplierId,
    cycle: String(cycle).toUpperCase(),
    immediate: immediate === true || immediate === 'true',
    actorUserId: req.user?.id || null,
    actorEmail: req.user?.email || null,
    note: note || null,
  });

  res.status(200).json({ status: 'success', data: plan });
});
