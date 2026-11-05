/**
 * Supplier-initiated refunds on a delivered trip.
 *
 * The supplier asks, an admin decides, and the supplier's own balance pays for
 * it. Viator's model: the platform is merchant of record, so it refunds the
 * traveller and adjusts what it owes the supplier.
 *
 * ── Where the money comes from ────────────────────────────────────────────
 *
 * Execution writes ONE `SupplierCharge` row with reason `SUPPLIER_REFUND`.
 * That table already has an OPEN -> SETTLED lifecycle and is netted off payout
 * requests and invoices by `payoutRuns` / `invoiceService`, so this service
 * never edits a balance itself — it only raises the debit.
 *
 * The amount depends on one economic fact: was the supplier already paid for
 * this booking?
 *
 *   partial refund   charge = supplierPayout × refund / gross   (always)
 *   full refund      charge = supplierPayout when the payout was already
 *                    INVOICED / REQUESTED / PAID, otherwise 0
 *
 * That asymmetry is not arbitrary. A full refund takes the booking out of
 * payout eligibility (`paymentStatus` becomes REFUNDED), so an unpaid supplier
 * already loses their whole share — charging them again would be a double
 * penalty. A partial refund leaves the booking payable, so the supplier still
 * receives their share and the proportional charge is what claws back the
 * refunded slice. When the payout has already left, no eligibility change can
 * recover it, and the charge is the only mechanism that can.
 *
 * ── Why the Stripe webhook is told to skip ────────────────────────────────
 *
 * `charge.refunded` sets `payoutStatus = CANCELLED` for EVERY refund, partial
 * included. Left alone, a 10% refund would cost the supplier 100% of their
 * payout on top of the proportional charge. `isLatestRefundSupplierRequest()`
 * in stripeHelpers skips refunds whose newest refund carries
 * `metadata.reason = 'supplier_refund_request'`, exactly as the existing
 * booking-modify refunds are skipped, so this service owns the booking state
 * and the ledger is internally consistent.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const { logActivity } = require('./auditLogger');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Post-activity states where the cancellation flow no longer applies. */
const ELIGIBLE_STATUSES = Object.freeze(['COMPLETED', 'NO_SHOW']);

/** Payout states that mean the supplier was already credited for this booking. */
const SETTLED_PAYOUT_STATES = Object.freeze(['INVOICED', 'REQUESTED', 'PAID']);

/**
 * Every booking field the refund decision reads — `eligibilityError` and
 * `computePreview` must both run against exactly these.
 *
 * This is a shared constant because the approve path used a hand-written
 * `select` and lost `status`: Prisma returned the row without it, every
 * check saw `undefined` instead of COMPLETED, and approving any supplier
 * refund answered 409 "Only a completed or no-show trip can be refunded."
 * Unit tests missed it because their booking mock ignored `select` and
 * returned the full row. Keep the select here, always, so the two call sites
 * cannot drift from the checks they feed.
 */
const REFUND_BOOKING_SELECT = Object.freeze({
  id: true,
  bookingNumber: true,
  status: true,
  origin: true,
  grossAmount: true,
  refundAmount: true,
  supplierPayout: true,
  currency: true,
  paymentStatus: true,
  payoutStatus: true,
  refundedAt: true,
  travelDate: true,
  stripePaymentIntentId: true,
  paypalCaptureId: true,
  paymentProvider: true,
});

/**
 * A request in one of these states means the booking is already in the refund
 * queue or mid-execution. A supplier must not file a second one while it is
 * unresolved. The database partial unique index enforces the two live states;
 * FAILED is checked here as well so an admin retry is not duplicated.
 */
const ACTIVE_REQUEST_STATUSES = Object.freeze(['PENDING_APPROVAL', 'EXECUTING', 'FAILED']);

const CHARGE_REASON = 'SUPPLIER_REFUND';
const REFUND_TYPES = Object.freeze(['PERCENT', 'AMOUNT']);

/**
 * Allow-listed reasons. Deliberately structured rather than free text: an
 * approval queue full of prose cannot be reviewed at a glance, and the reason
 * is the only signal the admin has for judging the request.
 */
const REFUND_REASONS = Object.freeze([
  { code: 'TOUR_NOT_AS_DESCRIBED', label: 'Experience was not as described' },
  { code: 'SERVICE_QUALITY', label: 'Service quality fell short' },
  { code: 'ITINERARY_CHANGED', label: 'Itinerary or inclusions changed' },
  { code: 'GUIDE_ISSUE', label: 'Guide or staff issue' },
  { code: 'WEATHER_DISRUPTION', label: 'Weather disrupted the experience' },
  { code: 'CUSTOMER_COMPLAINT', label: 'Customer complaint resolved as goodwill' },
  { code: 'DUPLICATE_OR_PRICING_ERROR', label: 'Duplicate booking or pricing error' },
  { code: 'OTHER', label: 'Other (explain in the note)' },
]);

const REASON_CODES = new Set(REFUND_REASONS.map((r) => r.code));

function requestNumber() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const suffix = require('crypto').randomBytes(2).toString('hex').toUpperCase();
  return `SR-${y}${m}${d}-${suffix}`;
}

function toNumber(v) {
  return v == null ? 0 : Number(v);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Everything the supplier can refund on this booking right now.
 * Used by both the quote endpoint and the approval-time recompute.
 */
function refundableOf(booking) {
  return round2(Math.max(0, toNumber(booking.grossAmount) - toNumber(booking.refundAmount)));
}

/**
 * Why this booking cannot take a refund request, or null when it can.
 * Money and time, not status labels: statuses drift (a partial refund can
 * leave a booking COMPLETED or REFUNDED depending on the path taken) but the
 * cash facts do not.
 */
function eligibilityError(booking) {
  if (!booking) return 'Booking not found';
  if (booking.origin === 'SUPPLIER_CREATED') {
    // The platform never held this money — refunding it here would be fiction.
    // Offline collection refunds go through the collections ledger instead.
    return 'This booking was collected outside the platform. Refund it from the collections panel instead.';
  }
  if (!ELIGIBLE_STATUSES.includes(booking.status)) {
    // Date alone is not completion. A past PENDING/CONFIRMED booking can still
    // be waiting on a supplier action, and a cancelled booking belongs in the
    // cancellation flow rather than this post-trip refund queue.
    return 'Only a completed or no-show trip can be refunded. Cancel the booking instead.';
  }
  if (booking.paymentStatus !== 'SUCCEEDED' && booking.paymentStatus !== 'REFUNDED') {
    return 'Only a fully paid booking can be refunded';
  }
  if (!booking.stripePaymentIntentId && !booking.paypalCaptureId) {
    return 'This booking has no platform payment to refund';
  }
  if (new Date(booking.travelDate) >= startOfToday()) {
    return 'Only a completed trip can be refunded. Cancel the booking instead.';
  }
  if (refundableOf(booking) <= 0) {
    return 'This booking has already been fully refunded';
  }
  if (booking.refundedAt && toNumber(booking.refundAmount) > 0 && !ELIGIBLE_STATUSES.includes(booking.status)) {
    // Partial refund already on a terminal status: still allowed, the ceiling
    // above is the real guard. Kept explicit so a future status addition does
    // not silently widen eligibility.
    return null;
  }
  return null;
}

/**
 * Validate a supplier's request and compute the server-side truth.
 *
 * Never trusts an amount from the client beyond the two allowed shapes: a
 * percentage of the booking, or a specific sum. Both are clamped to the live
 * refundable ceiling.
 */
function computePreview(booking, payload) {
  const currency = booking.currency || 'USD';
  const gross = round2(toNumber(booking.grossAmount));
  const refundedSoFar = round2(toNumber(booking.refundAmount));
  const refundable = refundableOf(booking);
  const supplierPayout = round2(toNumber(booking.supplierPayout));

  const type = String(payload?.refundType || '').toUpperCase();
  if (!REFUND_TYPES.includes(type)) {
    throw new AppError('Choose a refund type', 400);
  }

  const rawValue = toNumber(payload?.value);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    throw new AppError('Enter a refund amount greater than zero', 400);
  }

  let proposed;
  if (type === 'PERCENT') {
    if (rawValue > 100) throw new AppError('A percentage cannot exceed 100', 400);
    proposed = round2((gross * rawValue) / 100);
    // A percentage is relative to the booking, so on a part-refunded booking
    // it is clamped to what is left rather than rejected — the supplier asked
    // for "the rest", and the ceiling is the server's job to enforce.
    if (proposed > refundable) proposed = refundable;
  } else {
    proposed = round2(rawValue);
    if (proposed > refundable + 0.005) {
      throw new AppError(
        `The refund cannot exceed the refundable balance of ${currency} ${refundable.toFixed(2)}`,
        400,
      );
    }
  }

  proposed = Math.min(proposed, refundable);
  if (proposed <= 0) throw new AppError('The refund amount is too small', 400);

  const isFull = proposed >= refundable - 0.005 && refundedSoFar === 0;
  const alreadySettled = SETTLED_PAYOUT_STATES.includes(String(booking.payoutStatus || ''));

  // See the file header: full refunds only charge when the payout already left.
  const charge = isFull
    ? (alreadySettled ? supplierPayout : 0)
    : round2((supplierPayout * proposed) / (gross || proposed));

  return {
    currency,
    gross,
    refundedSoFar,
    refundable,
    proposed,
    isFull,
    payoutSettled: alreadySettled,
    supplierPayout,
    charge: Math.max(0, round2(charge)),
    refundType: type,
    value: rawValue,
  };
}

/** Reject anything the allow-list does not name. */
function normalizePayload(payload, actor) {
  if (!payload || typeof payload !== 'object') throw new AppError('A refund request body is required', 400);

  const operated = payload.operated;
  if (typeof operated !== 'boolean') {
    throw new AppError('Answer whether the tour operated', 400);
  }

  // A tour that did not operate cannot have been attended, so the second
  // question is not asked (and cannot be answered "yes" by a hand-crafted
  // request). Recorded rather than overwritten silently: the reviewer sees
  // that the value was inferred, not reported.
  let attended;
  let attendedInferred = false;
  if (operated === false) {
    attended = false;
    attendedInferred = true;
  } else {
    if (typeof payload.attended !== 'boolean') {
      throw new AppError('Answer whether the customer went on this tour', 400);
    }
    attended = payload.attended;
  }

  const reasonCode = String(payload.reasonCode || '').trim().toUpperCase();
  if (!REASON_CODES.has(reasonCode)) throw new AppError('Choose a reason for the refund', 400);

  const note = payload.note == null ? null : String(payload.note).trim().slice(0, 1000);
  if (reasonCode === 'OTHER' && !note) {
    throw new AppError('Explain the “Other” reason in the note', 400);
  }

  return {
    operated,
    attended,
    attendedInferred,
    reasonCode,
    refundType: String(payload.refundType || '').toUpperCase(),
    value: toNumber(payload.value),
    note: note || null,
    requestedByEmail: (actor && actor.email) || null,
    requestedById: (actor && actor.id) || null,
  };
}

function serialize(request) {
  const booking = request.booking || {};
  const tour = booking.tour || {};
  return {
    id: request.id,
    requestNumber: request.requestNumber,
    status: request.status,
    payload: request.payload,
    preview: request.preview,
    decisionNote: request.decisionNote,
    decidedAt: request.decidedAt,
    executedAt: request.executedAt,
    refundReference: request.refundReference,
    refundedAmount: request.refundedAmount == null ? null : toNumber(request.refundedAmount),
    chargeId: request.chargeId,
    failureReason: request.failureReason,
    createdAt: request.createdAt,
    booking: {
      id: booking.id,
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      travelDate: booking.travelDate,
      currency: booking.currency,
      grossAmount: booking.grossAmount == null ? null : toNumber(booking.grossAmount),
      refundAmount: booking.refundAmount == null ? null : toNumber(booking.refundAmount),
      customerName: booking.customer ? booking.customer.name : null,
      tourTitle: tour.title || null,
      tourSlug: tour.slug || null,
    },
    supplier: request.supplier
      ? { id: request.supplier.id, name: request.supplier.name, email: request.supplier.email }
      : null,
  };
}

const BOOKING_INCLUDE = {
  booking: {
    include: {
      tour: { select: { id: true, title: true, slug: true, supplierId: true } },
      customer: { select: { id: true, name: true, email: true } },
    },
  },
  supplier: { select: { id: true, name: true, email: true } },
};

/** The supplier's booking, or 404 — never leak another supplier's row. */
async function loadSupplierBooking(bookingId, supplierId) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, tour: { supplierId }, isSimulated: false },
    include: {
      tour: { select: { id: true, title: true, slug: true, supplierId: true } },
      customer: { select: { id: true, name: true, email: true } },
    },
  });
  if (!booking) throw new AppError('Booking not found', 404);
  return booking;
}

/**
 * What the modal needs before the supplier types anything: the refundable
 * ceiling, the server-computed share, the reason list, and any open request.
 */
async function quoteRefund({ bookingId, supplierId, requesterEmail = null }) {
  const booking = await loadSupplierBooking(bookingId, supplierId);
  const currency = booking.currency || 'USD';
  const blocked = eligibilityError(booking);

  const [open, supplierBalance] = await Promise.all([
    prisma.supplierRefundRequest.findFirst({
      where: { bookingId: booking.id, status: { in: [...ACTIVE_REQUEST_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, requestNumber: true, status: true, createdAt: true },
    }),
    openBalance(supplierId, currency),
  ]);

  const reason = blocked || (open ? 'A refund request is already in progress for this booking.' : null);
  const gross = round2(toNumber(booking.grossAmount));
  const refundable = refundableOf(booking);
  const supplierPayout = round2(toNumber(booking.supplierPayout));

  return {
    booking: {
      id: booking.id,
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      travelDate: booking.travelDate,
      currency,
      tourTitle: booking.tour?.title || null,
      customerName: booking.customer?.name || null,
      grossAmount: gross,
      refundAmount: round2(toNumber(booking.refundAmount)),
      supplierPayout,
    },
    eligible: !reason,
    reason,
    refundable,
    supplierShareRaw: supplierPayout,
    payoutStatus: booking.payoutStatus,
    openRequest: open || null,
    supplierBalance,
    // Who the request will be attributed to. Returned here so the modal does
    // not have to reach into client auth state for a display value.
    requestedByEmail: requesterEmail || null,
    reasons: REFUND_REASONS,
  };
}

/**
 * Request numbers are date + 4 random hex. Retry a collision instead of
 * misreporting it as a duplicate request for the booking.
 */
async function createRequestRow(data, attempts = 2) {
  try {
    return await prisma.supplierRefundRequest.create({
      data: { ...data, requestNumber: requestNumber() },
    });
  } catch (err) {
    const target = Array.isArray(err?.meta?.target) ? err.meta.target.join(',') : String(err?.meta?.target || '');
    if (err?.code === 'P2002' && target.includes('requestNumber') && attempts > 1) {
      return createRequestRow(data, attempts - 1);
    }
    throw err;
  }
}

/** Create a PENDING_APPROVAL request. One active request per booking. */
async function createRefundRequest({
  bookingId,
  supplierId,
  supplier,
  payload,
  actor,
  req,
  idempotencyKey = null,
}) {
  const key = idempotencyKey ? String(idempotencyKey).trim().slice(0, 120) : null;

  // A retry after a lost response must return the first request, not create a
  // second one or tell the supplier their successful attempt failed.
  if (key) {
    const replay = await prisma.supplierRefundRequest.findUnique({
      where: { idempotencyKey: key },
      include: BOOKING_INCLUDE,
    });
    if (replay) {
      if (replay.supplierId !== supplierId) {
        throw new AppError('This idempotency key belongs to another supplier', 409);
      }
      if (replay.bookingId && replay.bookingId !== bookingId) {
        throw new AppError('This idempotency key was used for another booking', 409);
      }
      return serialize(replay);
    }
  }

  const booking = await loadSupplierBooking(bookingId, supplierId);
  const blocked = eligibilityError(booking);
  if (blocked) throw new AppError(blocked, 400);

  const active = await prisma.supplierRefundRequest.findFirst({
    where: { bookingId: booking.id, status: { in: [...ACTIVE_REQUEST_STATUSES] } },
    select: { id: true, requestNumber: true, status: true },
  });
  if (active) {
    throw new AppError('This booking already has a refund request in progress', 409);
  }

  const normalized = normalizePayload(payload, actor || supplier);
  const preview = computePreview(booking, normalized);

  let request;
  try {
    request = await createRequestRow({
      bookingId: booking.id,
      supplierId,
      payload: normalized,
      preview,
      idempotencyKey: key,
    });
  } catch (err) {
    if (err && err.code === 'P2002') {
      // A concurrent retry with the same key is a success, not a failure.
      if (key) {
        const replay = await prisma.supplierRefundRequest.findUnique({
          where: { idempotencyKey: key },
          include: BOOKING_INCLUDE,
        });
        if (replay && replay.supplierId === supplierId && (!replay.bookingId || replay.bookingId === bookingId)) {
          return serialize(replay);
        }
      }
      throw new AppError('This booking already has a refund request in progress', 409);
    }
    throw err;
  }

  await logActivity({
    userId: actor?.id || null,
    action: 'booking.refund_requested',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: {
      requestId: request.id,
      requestNumber: request.requestNumber,
      proposed: preview.proposed,
      charge: preview.charge,
      currency: preview.currency,
    },
    req,
  }).catch(() => {});

  // Ops alert + supplier confirmation. Best-effort: a mail failure must never
  // undo a filed request.
  try {
    const { sendSupplierRefundRequestedEmail } = require('./emailService');
    await sendSupplierRefundRequestedEmail(request.id);
  } catch (err) {
    console.error('[SupplierRefund] request email failed:', err.message);
  }

  const full = await prisma.supplierRefundRequest.findUnique({
    where: { id: request.id },
    include: BOOKING_INCLUDE,
  });
  return serialize(full || request);
}

async function listSupplierRefundRequests({ supplierId, status = '', page = 1, limit = 20 }) {
  const where = { supplierId };
  if (status && status !== 'ALL') where.status = status;
  const take = Math.min(parseInt(limit, 10) || 20, 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

  const [rows, total] = await Promise.all([
    prisma.supplierRefundRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: BOOKING_INCLUDE,
    }),
    prisma.supplierRefundRequest.count({ where }),
  ]);

  return { requests: rows.map(serialize), total, page: Math.floor(skip / take) + 1, limit: take };
}

async function withdrawRefundRequest({ requestId, supplierId, actor, req }) {
  const request = await prisma.supplierRefundRequest.findFirst({
    where: { id: requestId, supplierId },
  });
  if (!request) throw new AppError('Refund request not found', 404);

  const updated = await prisma.supplierRefundRequest.updateMany({
    where: { id: requestId, supplierId, status: 'PENDING_APPROVAL' },
    data: { status: 'WITHDRAWN' },
  });
  if (updated.count === 0) {
    throw new AppError('This request can no longer be withdrawn', 409);
  }

  await logActivity({
    userId: actor?.id || null,
    action: 'booking.refund_request_withdrawn',
    resource: 'Booking',
    resourceId: request.bookingId,
    metadata: { requestId },
    req,
  }).catch(() => {});

  return { id: requestId, status: 'WITHDRAWN' };
}

// ── Admin ────────────────────────────────────────────────────────────────

async function listAdminRefundRequests({ status = 'PENDING_APPROVAL', page = 1, limit = 20, search = '' }) {
  const where = {};
  if (status && status !== 'ALL') where.status = status;
  const term = String(search || '').trim();
  if (term) {
    where.OR = [
      { requestNumber: { contains: term, mode: 'insensitive' } },
      { booking: { bookingNumber: { contains: term, mode: 'insensitive' } } },
    ];
  }

  const take = Math.min(parseInt(limit, 10) || 20, 100);
  const current = Math.max(parseInt(page, 10) || 1, 1);
  const skip = (current - 1) * take;

  const [rows, total] = await Promise.all([
    prisma.supplierRefundRequest.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip,
      take,
      include: BOOKING_INCLUDE,
    }),
    prisma.supplierRefundRequest.count({ where }),
  ]);

  return { requests: rows.map(serialize), total, page: current, limit: take };
}

async function getAdminRefundRequest(id) {
  const row = await prisma.supplierRefundRequest.findUnique({ where: { id }, include: BOOKING_INCLUDE });
  if (!row) throw new AppError('Refund request not found', 404);

  // Live figures for the decision: the stored preview is a snapshot, and the
  // booking may have been refunded elsewhere since it was filed.
  const booking = await prisma.booking.findUnique({
    where: { id: row.bookingId },
    select: REFUND_BOOKING_SELECT,
  });
  const [charges, balance] = await Promise.all([
    prisma.supplierCharge.aggregate({
      where: { bookingId: row.bookingId, reason: CHARGE_REASON, status: { not: 'REVERSED' } },
      _sum: { amount: true },
    }),
    openBalance(row.supplierId, row.booking?.currency),
  ]);

  let live = null;
  let blocked = null;
  try {
    live = computePreview(booking, row.payload);
  } catch (err) {
    blocked = err.message;
  }

  // A request that can still be decided carries the same eligibility answer
  // the approve endpoint would give. The drawer disables "Approve & refund"
  // and shows why, instead of letting the admin click and collect a 409.
  if (row.status === 'PENDING_APPROVAL' || row.status === 'FAILED') {
    blocked = eligibilityError(booking) || blocked;
  }

  return {
    ...serialize(row),
    live,
    blocked,
    chargedToDate: toNumber(charges._sum.amount),
    supplierBalance: balance,
  };
}

/**
 * Available balance in the booking's currency: eligible unpaid earnings minus
 * every OPEN platform charge. Same predicate the commission ledger uses, so
 * the two can never disagree about what a supplier actually has.
 */
async function openBalance(supplierId, currency = null) {
  try {
    const { eligibleBookingsWhere } = require('./financeHelpers');
    const where = eligibleBookingsWhere(supplierId);
    if (currency) where.currency = currency;
    const chargeWhere = { supplierId, status: 'OPEN' };
    if (currency) chargeWhere.currency = currency;
    const [earnings, charges] = await Promise.all([
      prisma.booking.aggregate({ where, _sum: { supplierPayout: true } }),
      prisma.supplierCharge.aggregate({
        where: chargeWhere,
        _sum: { amount: true },
      }),
    ]);
    return {
      earnings: round2(toNumber(earnings._sum.supplierPayout)),
      openCharges: round2(toNumber(charges._sum.amount)),
      available: round2(toNumber(earnings._sum.supplierPayout) - toNumber(charges._sum.amount)),
    };
  } catch (err) {
    console.error('[SupplierRefund] open balance failed:', err.message);
    return null;
  }
}

/**
 * Approve and execute. One transaction owns every state change, mirroring
 * `refundClaimController.adminRelease`:
 *
 *   lock the request -> revalidate against the LIVE booking -> EXECUTING
 *   -> provider refund (idempotent) -> SupplierCharge -> booking totals
 *   -> COMPLETED
 *
 * If anything throws, the transaction rolls back to PENDING_APPROVAL and the
 * admin can retry. The provider idempotency key is derived from the request id,
 * so a retry after a partially-observed success replays the same refund rather
 * than issuing a second one.
 */
async function approveRefundRequest({ requestId, adminUser, note = null, req }) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT id FROM "SupplierRefundRequest" WHERE id = $1 FOR UPDATE',
      requestId,
    );

    const request = await tx.supplierRefundRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppError('Refund request not found', 404);
    if (request.status !== 'PENDING_APPROVAL' && request.status !== 'FAILED') {
      throw new AppError(`This request is not awaiting a decision (${request.status})`, 409);
    }

    const booking = await tx.booking.findUnique({
      where: { id: request.bookingId },
      select: REFUND_BOOKING_SELECT,
    });
    if (!booking) throw new AppError('Booking not found', 404);

    // Revalidate against the live row BEFORE recomputing: an amount that was
    // valid when the supplier filed the request may not be valid now, and the
    // eligibility answer is the more useful error to surface.
    const blocked = eligibilityError(booking);
    if (blocked) throw new AppError(blocked, 409);
    const preview = computePreview(booking, request.payload);

    await tx.supplierRefundRequest.update({
      where: { id: requestId },
      data: {
        status: 'EXECUTING',
        decidedBy: adminUser?.id || null,
        decidedAt: new Date(),
        decisionNote: note || null,
      },
    });

    const { refundBookingPayment } = require('./payments');
    const cents = Math.round(preview.proposed * 100);
    let refund;
    try {
      refund = await refundBookingPayment(booking, cents, {
        metadata: {
          reason: 'supplier_refund_request',
          requestId,
          bookingId: booking.id,
        },
        // A retry must replay the same refund, never issue a second one.
        idempotencyKey: `supplier-refund-${requestId}`,
      });
    } catch (err) {
      console.error('[SupplierRefund] provider refund failed:', err.message);
      throw new AppError(`Could not process the refund: ${err.message}`, 502);
    }

    // Ledger: one OPEN debit. Netted off the next payout/invoice by the
    // existing machinery — never applied to a balance directly here.
    let charge = null;
    if (preview.charge > 0) {
      charge = await tx.supplierCharge.create({
        data: {
          supplierId: request.supplierId,
          bookingId: booking.id,
          amount: preview.charge,
          currency: preview.currency,
          reason: CHARGE_REASON,
          status: 'OPEN',
          notes: `Supplier refund request ${request.requestNumber}: ${preview.proposed.toFixed(2)} ${preview.currency} refunded to the traveller`,
        },
      });
    }

    const newRefunded = round2(toNumber(booking.refundAmount) + preview.proposed);
    const full = newRefunded >= round2(toNumber(booking.grossAmount)) - 0.005;
    const providerStatus = String(refund?.status || '').toUpperCase();

    await tx.booking.update({
      where: { id: booking.id },
      data: {
        refundAmount: newRefunded,
        refundedAt: new Date(),
        refundStatus: providerStatus === 'PENDING' ? 'PENDING' : 'SUCCEEDED',
        // A full refund is terminal and must leave both revenue reporting and
        // payout eligibility. A partial one leaves the booking payable, which
        // is exactly what makes the proportional charge the right recovery.
        ...(full
          ? { status: 'REFUNDED', paymentStatus: 'REFUNDED' }
          : {}),
      },
    });

    const updated = await tx.supplierRefundRequest.update({
      where: { id: requestId },
      data: {
        status: 'COMPLETED',
        executedBy: adminUser?.id || null,
        executedAt: new Date(),
        refundReference: refund?.id || refund?.refundId || null,
        refundedAmount: preview.proposed,
        chargeId: charge ? charge.id : null,
        failureReason: null,
      },
      include: BOOKING_INCLUDE,
    });

    return { request: updated, preview, booking, refund };
  }, { timeout: 30000 });

  const serialized = serialize(result.request);

  await logActivity({
    userId: adminUser?.id || null,
    action: 'booking.refund_request_approved',
    resource: 'Booking',
    resourceId: result.booking.id,
    metadata: {
      requestId,
      refunded: result.preview.proposed,
      charge: result.preview.charge,
      currency: result.preview.currency,
      reference: serialized.refundReference,
      admin: adminUser?.email || null,
    },
    req,
  }).catch(() => {});

  // Post-commit fan-out: customer receipt, supplier decision, GA4 refund.
  try {
    const { sendSupplierRefundDecisionEmail } = require('./emailService');
    await sendSupplierRefundDecisionEmail(requestId);
  } catch (err) {
    console.error('[SupplierRefund] supplier decision email failed:', err.message);
  }
  try {
    const { sendRefundCompletedEmail } = require('./emailService');
    await sendRefundCompletedEmail(result.booking.id, {
      refundReference: serialized.refundReference,
      refundedAt: new Date(),
    });
  } catch (err) {
    console.error('[SupplierRefund] customer refund email failed:', err.message);
  }
  try {
    // The Stripe webhook skips these refunds (see the file header), so the
    // refund event is reported here — and only here — for both providers.
    // `markRefundReported` accumulates, so repeat partials stay accurate.
    // Re-read the scalar attribution fields buildRefundEvent needs; the
    // in-transaction select was deliberately narrow.
    const { sendRefund } = require('./ga4Measurement');
    const attributable = await prisma.booking.findUnique({
      where: { id: result.booking.id },
      select: {
        id: true,
        bookingNumber: true,
        currency: true,
        grossAmount: true,
        gaClientId: true,
        analyticsConsent: true,
      },
    });
    if (attributable) await sendRefund(attributable, { value: result.preview.proposed });
  } catch (err) {
    console.warn('[SupplierRefund] GA4 refund report failed:', err.message);
  }

  return serialized;
}

async function rejectRefundRequest({ requestId, adminUser, note, req }) {
  const reason = note == null ? '' : String(note).trim().slice(0, 1000);
  if (!reason) throw new AppError('A reason is required when rejecting a refund request', 400);

  // Conditional update + row check: an approval may be executing or may have
  // just committed. Never overwrite COMPLETED with REJECTED because the read
  // happened before the other admin's transaction committed.
  const result = await prisma.supplierRefundRequest.updateMany({
    where: { id: requestId, status: 'PENDING_APPROVAL' },
    data: {
      status: 'REJECTED',
      decidedBy: adminUser?.id || null,
      decidedAt: new Date(),
      decisionNote: reason,
    },
  });
  if (!result || result.count === 0) {
    const current = await prisma.supplierRefundRequest.findUnique({
      where: { id: requestId },
      select: { status: true },
    });
    if (!current) throw new AppError('Refund request not found', 404);
    throw new AppError(`This request is not awaiting a decision (${current.status})`, 409);
  }

  const updated = await prisma.supplierRefundRequest.findUnique({
    where: { id: requestId },
    include: BOOKING_INCLUDE,
  });
  if (!updated) throw new AppError('Refund request not found', 404);

  await logActivity({
    userId: adminUser?.id || null,
    action: 'booking.refund_request_rejected',
    resource: 'Booking',
    resourceId: updated.bookingId,
    metadata: { requestId, note: reason, admin: adminUser?.email || null },
    req,
  }).catch(() => {});

  try {
    const { sendSupplierRefundDecisionEmail } = require('./emailService');
    await sendSupplierRefundDecisionEmail(requestId);
  } catch (err) {
    console.error('[SupplierRefund] rejection email failed:', err.message);
  }

  return serialize(updated);
}

module.exports = {
  ELIGIBLE_STATUSES,
  SETTLED_PAYOUT_STATES,
  ACTIVE_REQUEST_STATUSES,
  REFUND_REASONS,
  CHARGE_REASON,
  quoteRefund,
  createRefundRequest,
  listSupplierRefundRequests,
  withdrawRefundRequest,
  listAdminRefundRequests,
  getAdminRefundRequest,
  approveRefundRequest,
  rejectRefundRequest,
  computePreview,
  eligibilityError,
  refundableOf,
  openBalance,
  serialize,
};
