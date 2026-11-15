/**
 * Completed-trip refund claims (customer-initiated).
 *
 * Flow: customer submits a claim on a paid, completed booking (within 30 days)
 *  -> supplier reviews (approve or decline)
 *  -> on supplier approval an admin releases the money (Stripe refund executed).
 *
 * Production hardening:
 *  - Submission serializes on the booking row (SELECT … FOR UPDATE) so two
 *    simultaneous submits can never create duplicate claims.
 *  - Submission freezes the supplier's payout portion (DISPUTED), so the
 *    supplier cannot be paid while a refund is pending. A decline restores it.
 *  - Admin release runs inside a transaction that locks the claim row and uses
 *    a PROCESSING checkpoint; a crash rolls back cleanly to SUPPLIER_APPROVED
 *    and duplicate/concurrent releases are impossible.
 *  - Every status change is guarded (updateMany/row-lock against the expected
 *    status) so approve/decline/release never double-apply.
 *  - Release re-checks open disputes and refunded-to-date immediately before
 *    moving money, and debits the supplier for a payout that already left, so
 *    a customer + supplier cannot both be paid for the same trip.
 *  - The provider refund carries a deterministic idempotency key derived from
 *    the claim id: a retry replays it instead of issuing a second refund.
 *  - A supplier cannot review a claim on their own booking (or as a member of
 *    the customer's own supplier team).
 *  - Eligibility blocks any booking that has already received money back via
 *    any path (supplier dispute RESOLVED_CUSTOMER, earlier RELEASED claim, or
 *    refundedAt/REFUNDED), preventing double refunds.
 */

const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const { enqueueNotification } = require('../services/queue');
const { notifyAdmin } = require('../services/adminNotificationService');
const { refundBookingPayment } = require('../services/payments');
const { findExistingRefund } = require('../services/stripeHelpers');
const { sendEmail, resolveEmailBrand } = require('../services/emailService');
const { logActivity } = require('../services/auditLogger');
const getConfig = require('../services/getConfig');
const {
  freezeBookingForDispute,
  unfreezeBookingAfterDispute,
  cancelBookingFunds,
} = require('../services/financeHelpers');
const { detachBookingFromInvoices } = require('../services/invoiceService');
const {
  supplierChargeForRefund,
  CUSTOMER_CLAIM_CHARGE_REASON,
  round2,
} = require('../services/supplierRefundCharge');
const emailUrls = require('../../../config/emailUrls');

const CLAIM_WINDOW_DAYS = 30;
const CLAIM_WINDOW_MS = CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Default value above which one admin's release needs a second admin.
 *
 * A number is applied to every currency; a JSON object can set
 * `{ "USD": 500, "GBP": 400, "GHS": 6000 }` and, optionally, `default`.
 * `0` turns the control off. Overridable at runtime via SystemConfig
 * `refunds.second_approval_threshold` — no deploy required.
 */
const DEFAULT_SECOND_APPROVAL_THRESHOLD = 500;

/** Allow-listed customer-facing reasons (UI shows friendly labels for these). */
const CLAIM_REASONS = [
  'NOT_AS_DESCRIBED',
  'SERVICE_NOT_PROVIDED',
  'GUIDE_ISSUE',
  'TRANSPORT_ISSUE',
  'SCHEDULE_CHANGE',
  'HEALTH_SAFETY',
  'OTHER',
];

const OPEN_CLAIM_STATUSES = ['SUBMITTED', 'SUPPLIER_APPROVED', 'PROCESSING'];
const PAID_BACK_CLAIM_STATUSES = ['RELEASED'];
const OPEN_DISPUTE_STATUSES = ['OPEN', 'UNDER_REVIEW'];
const PAID_BACK_DISPUTE_STATUSES = ['RESOLVED_CUSTOMER'];

function claimNumber() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RC-${stamp}-${rand}`;
}

async function createClaimWithRetry(model, data, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await model.refundClaim.create({ data: { ...data, claimNumber: claimNumber() } });
    } catch (err) {
      const collision = err && (err.code === 'P2002' || /Unique constraint/.test(err.message || ''));
      if (!collision || i === attempts - 1) throw err;
    }
  }
  throw new Error('Could not allocate a claim number');
}

async function sendClaimEmail({ to, subject, heading, message, buttonText, buttonUrl, brandKey = null }) {
  try {
    await sendEmail({
      to,
      subject,
      template: 'generic-notification',
      opts: { brandKey },
      data: {
        header: heading,
        message,
        buttonText: buttonText || 'View details',
        buttonUrl: buttonUrl || `${emailUrls.dashboardBaseForBrand(brandKey)}/dashboard`,
        userName: '',
      },
    });
  } catch (err) {
    console.error(`[RefundClaim] email failed (${subject}):`, err.message);
  }
}

async function userEmail(id) {
  if (!id) return '';
  const u = await prisma.user.findUnique({ where: { id }, select: { email: true } }).catch(() => null);
  return u?.email || '';
}

/** Customer storefront link to the booking, resolved from the booking's origin. */
function customerBookingUrl(booking) {
  const origin = emailUrls.bookingClientOrigin(booking);
  return `${origin}/dashboard/bookings?booking=${encodeURIComponent(booking.id)}`;
}

/**
 * Independent-review guard. A supplier must never decide a refund claim on a
 * booking where the customer is the supplier themselves, or an active member
 * of that supplier's team. Without this, the same person could approve their
 * own claim and leave the admin release as the only gate.
 *
 * Team members are identified by email (`TeamMember` has no userId: a login
 * and a team seat are separate records), so the customer's account email is
 * what gets matched.
 */
async function assertIndependentReview(claim, supplierId, client = prisma) {
  const customerId = claim?.booking?.customerId;
  if (!customerId) return;
  if (customerId === supplierId) {
    throw new AppError('You cannot review a refund claim on your own booking', 403);
  }
  const customer = await client.user
    .findUnique({ where: { id: customerId }, select: { email: true } })
    .catch(() => null);
  if (!customer?.email) return;
  const member = await client.teamMember.findFirst({
    where: { supplierId, email: { equals: customer.email, mode: 'insensitive' } },
    select: { id: true },
  });
  if (member) {
    throw new AppError('You cannot review a refund claim raised by a member of your own team', 403);
  }
}

/** One audit action per claim transition, so a dispute can be reconstructed. */
function claimAudit(action, claim, req, metadata = {}) {
  logActivity({
    userId: req.user?.id || null,
    userEmail: req.user?.email || null,
    action,
    resource: 'RefundClaim',
    resourceId: claim.id,
    metadata: { claimNumber: claim.claimNumber, bookingId: claim.bookingId, ...metadata },
  }).catch((err) => console.error('[RefundClaim] audit failed:', err && err.message));
}

/**
 * Has this claim already been refunded at the provider?
 *
 * Stripe retains idempotency keys for about 24 hours. A claim left PROCESSING
 * for longer (a crash, a maintenance window) would otherwise issue a second
 * refund on retry, because the key no longer resolves to the first one. Every
 * refund carries `metadata.claimId`, so the provider itself is the durable
 * record and the retry can reuse it.
 */
function findExistingClaimRefund(paymentIntentId, claimId) {
  return findExistingRefund(paymentIntentId, (r) => r?.metadata?.claimId === claimId);
}

/** Read the configured release threshold for a currency; null = unparseable. */
function releaseThreshold(raw, currency) {
  if (raw == null || raw === '') return 0;
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = Number(raw);
    }
  }
  if (parsed && typeof parsed === 'object') {
    const key = String(currency || 'USD').toUpperCase();
    const value = parsed[key] ?? parsed.default;
    if (value == null) return 0;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const n = Number(parsed);
  // An explicit 0 disables the control; anything unparseable falls back to the
  // built-in default so a typo cannot silently switch a money control off.
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Value-based two-person control for a release.
 *
 * Above the configured threshold, the first admin's click only records their
 * approval — no money moves. A different admin then releases it, at the same
 * amount: an approval for 100 must not authorise a release of 1,000. Every
 * transition is recorded on the claim (`firstApprovedById/At/Amount`) so the
 * second approver can see who approved what, and in the audit log.
 *
 * Two deliberate escape hatches:
 *  - `0` (or a threshold above the amount) disables the control.
 *  - when the account has no OTHER active admin, the control is skipped
 *    (`skipped: true`) instead of blocking every release. A single-admin
 *    deployment would otherwise be unable to refund anyone.
 *
 * The first approval is claimed with a conditional `updateMany` so two admins
 * clicking simultaneously cannot both be recorded as the first approver.
 *
 * @returns {Promise<{proceed:boolean, reason?:string, threshold?:number,
 *   firstApprovedById?:string, firstApprovedAmount?:number,
 *   secondApprover?:string, skipped?:boolean}>}
 */
async function applyTwoPersonRule(claim, amount, currency, user) {
  const raw = await getConfig(
    'refunds.second_approval_threshold',
    String(DEFAULT_SECOND_APPROVAL_THRESHOLD),
  );
  const configured = releaseThreshold(raw, currency);
  const threshold = configured == null ? DEFAULT_SECOND_APPROVAL_THRESHOLD : configured;
  if (!threshold || amount < threshold) return { proceed: true };

  const otherAdmins = await prisma.user
    .count({ where: { id: { not: user.id }, active: true, roles: { has: 'admin' } } })
    .catch(() => 0);
  if (otherAdmins === 0) return { proceed: true, skipped: true, threshold };

  if (claim.firstApprovedById) {
    if (claim.firstApprovedById === user.id) {
      return { proceed: false, reason: 'same_admin', threshold, firstApprovedById: claim.firstApprovedById };
    }
    const approvedAmount = Number(claim.firstApprovedAmount);
    if (Number.isFinite(approvedAmount) && Math.abs(approvedAmount - amount) > 0.005) {
      return {
        proceed: false,
        reason: 'amount_changed',
        threshold,
        firstApprovedById: claim.firstApprovedById,
        firstApprovedAmount: approvedAmount,
      };
    }
    return { proceed: true, threshold, firstApprovedById: claim.firstApprovedById };
  }

  const registered = await prisma.refundClaim.updateMany({
    where: {
      id: claim.id,
      firstApprovedById: null,
      status: { in: ['SUPPLIER_APPROVED', 'PROCESSING'] },
    },
    data: { firstApprovedById: user.id, firstApprovedAt: new Date(), firstApprovedAmount: amount },
  });
  if (registered.count === 1) return { proceed: false, reason: 'registered', threshold };

  // Lost the race: another admin registered the first approval a moment ago,
  // so this request is the one that completes the pair.
  const fresh = await prisma.refundClaim
    .findUnique({
      where: { id: claim.id },
      select: { firstApprovedById: true, firstApprovedAmount: true },
    })
    .catch(() => null);
  if (!fresh?.firstApprovedById || fresh.firstApprovedById === user.id) {
    return { proceed: false, reason: 'same_admin', threshold };
  }
  return { proceed: true, threshold, firstApprovedById: fresh.firstApprovedById };
}

/** Throw when this booking already has money in flight or money already back. */
function rejectLifecycleConflicts(booking) {
  const disputes = Array.isArray(booking?.disputes) ? booking.disputes : [];
  const claims = Array.isArray(booking?.refundClaims) ? booking.refundClaims : [];

  if (disputes.some((d) => OPEN_DISPUTE_STATUSES.includes(d?.status))) {
    throw new AppError('A refund is already being processed for this booking', 409);
  }
  if (disputes.some((d) => PAID_BACK_DISPUTE_STATUSES.includes(d?.status))) {
    throw new AppError('This booking has already been refunded', 409);
  }
  if (claims.some((c) => OPEN_CLAIM_STATUSES.includes(c?.status))) {
    throw new AppError('You already have a refund request in progress for this booking', 409);
  }
  if (claims.some((c) => PAID_BACK_CLAIM_STATUSES.includes(c?.status))) {
    throw new AppError('This booking has already been refunded', 409);
  }
}

/** Shared guard: can this booking accept a new customer refund claim? */
function assertClaimable(booking, _req) {
  if (!booking) throw new AppError('Booking not found', 404);
  if (booking.status !== 'COMPLETED') {
    throw new AppError('Refund requests are only available once your trip is completed', 400);
  }
  if (booking.paymentStatus !== 'SUCCEEDED') {
    throw new AppError('This booking was not paid, so there is nothing to refund', 400);
  }
  if (booking.refundedAt || booking.paymentStatus === 'REFUNDED' || booking.status === 'REFUNDED') {
    throw new AppError('This booking has already been refunded', 400);
  }
  // Cumulative guard: another path (supplier refund, dispute, modification)
  // may have returned part of the money without setting refundedAt on a
  // booking that is still COMPLETED/SUCCEEDED.
  const gross = Number(booking.grossAmount) || 0;
  const refundedSoFar = Number(booking.refundAmount) || 0;
  if (gross > 0 && refundedSoFar >= gross - 0.005) {
    throw new AppError('This booking has already been refunded in full', 400);
  }
  rejectLifecycleConflicts(booking);
  const travelMs = booking.travelDate ? new Date(booking.travelDate).getTime() : NaN;
  if (!Number.isFinite(travelMs)) throw new AppError('This booking has no travel date', 400);
  if (Date.now() - travelMs > CLAIM_WINDOW_MS) {
    throw new AppError(`Refund requests must be made within ${CLAIM_WINDOW_DAYS} days of your trip`, 400);
  }
  return booking;
}

exports.submitRefundClaim = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const { id } = req.params;
  const { reason, details, type, requestedAmount } = req.body || {};

  if (!reason || !CLAIM_REASONS.includes(reason)) {
    return next(new AppError('Please choose a valid reason for your refund request', 400));
  }
  const claimType = type === 'PARTIAL' ? 'PARTIAL' : 'FULL';
  let partialAmount = null;
  if (claimType === 'PARTIAL') {
    const amount = Number(requestedAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return next(new AppError('Please enter how much you would like refunded', 400));
    }
    partialAmount = amount;
  }

  const CLAIM_INCLUDE = {
    tour: { select: { supplierId: true, title: true } },
    disputes: { select: { status: true } },
    refundClaims: { select: { status: true } },
  };

  const claim = await prisma.$transaction(async (tx) => {
    // Serialize claim creation per booking — prevents the double-submit race.
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${id} FOR UPDATE`;

    const booking = await tx.booking.findFirst({
      where: { id, customerId },
      include: CLAIM_INCLUDE,
    });
    assertClaimable(booking, req);

    const grossAmount = Number(booking.grossAmount) || 0;
    let amountToRequest = null;
    if (claimType === 'PARTIAL') {
      if (partialAmount > grossAmount) {
        throw new AppError(`The refund amount cannot exceed ${grossAmount.toFixed(2)} ${booking.currency || 'USD'}`, 400);
      }
      amountToRequest = partialAmount;
    }

    const supplierId = booking.tour?.supplierId;
    if (!supplierId) throw new AppError('Unable to route this refund request', 500);

    const created = await createClaimWithRetry(tx, {
      bookingId: booking.id,
      customerId,
      supplierId,
      reason,
      details: typeof details === 'string' && details.trim() ? details.trim().slice(0, 2000) : null,
      type: claimType,
      requestedAmount: amountToRequest,
    });

    // Freeze the supplier's share for as long as the claim is open. Without
    // this the supplier could be paid before an admin releases the refund,
    // leaving the platform to fund the customer refund on its own.
    await freezeBookingForDispute(tx, booking.id);
    return created;
  });

  claimAudit('booking.refund_claim_submitted', claim, req, {
    type: claimType,
    requestedAmount: claim.requestedAmount ?? null,
  });

  const [supplierUser, customerUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: claim.supplierId }, select: { email: true, name: true, roles: true } }),
    prisma.user.findUnique({ where: { id: customerId }, select: { email: true } }),
  ]);
  const tourTitle = claim.booking?.tour?.title || (await prisma.booking.findUnique({ where: { id: claim.bookingId }, select: { tour: { select: { title: true } } } }))?.tour?.title || 'your tour';

  enqueueNotification({
    userId: claim.supplierId,
    type: 'REFUND_CLAIM',
    title: 'Refund request received',
    message: `A customer requested a ${claimType.toLowerCase()} refund for "${tourTitle}".`,
    data: { bookingId: claim.bookingId, claimId: claim.id, source: 'expedition' },
  }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));

  notifyAdmin({
    type: 'REFUND_CLAIM',
    title: 'Customer refund request',
    message: `${supplierUser?.name ? 'A customer' : 'A customer'} requested a refund (claim ${claim.claimNumber})`,
    data: { bookingId: claim.bookingId, claimId: claim.id },
  }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));

  if (supplierUser?.email) {
    sendClaimEmail({
      to: supplierUser.email,
      subject: `Refund request for "${tourTitle}"`,
      heading: 'A customer requested a refund',
      message: `A customer has requested a ${claimType.toLowerCase()} refund for "${tourTitle}" (${claim.claimNumber}). Review it and approve so our team can release the money, or decline with a note.`,
      buttonText: 'Review request',
      buttonUrl: `${emailUrls.supplierDashboardForUser(supplierUser)}/finance?tab=claims&claimId=${claim.id}`,
      brandKey: resolveEmailBrand({ user: supplierUser }),
    }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
  }

  if (customerUser?.email) {
    const booking = await prisma.booking.findUnique({
      where: { id: claim.bookingId },
      select: { id: true, clientOrigin: true, source: true },
    });
    sendClaimEmail({
      to: customerUser.email,
      subject: 'We received your refund request',
      heading: 'Refund request received',
      message: `Your ${claimType.toLowerCase()} refund request for "${tourTitle}" has been submitted. The provider will review it, and if approved our team will release the refund to your original payment method.`,
      buttonText: 'View booking',
      buttonUrl: customerBookingUrl({ id: booking?.id || claim.bookingId, clientOrigin: booking?.clientOrigin }),
      brandKey: resolveEmailBrand({ booking }),
    }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
  }

  res.status(201).json({ status: 'success', data: { claim } });
});

/** Customers: list my claims (used by the workspace to show request status). */
exports.getMyClaims = catchAsync(async (req, res, next) => {
  const claims = await prisma.refundClaim.findMany({
    where: { customerId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { booking: { select: { bookingNumber: true, tour: { select: { title: true } } } } },
  });
  res.status(200).json({ status: 'success', data: { claims } });
});

function supplierContext(req) {
  return req.supplierId || req.user.id;
}

/** Suppliers: list claims against their tours. */
exports.getSupplierClaims = catchAsync(async (req, res, next) => {
  const supplierId = supplierContext(req);
  const { status } = req.query;
  const where = { supplierId };
  if (status && status !== 'ALL') where.status = status;
  const claims = await prisma.refundClaim.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      booking: {
        select: {
          bookingNumber: true,
          grossAmount: true,
          currency: true,
          customer: { select: { id: true, name: true, email: true } },
          tour: { select: { title: true } },
        },
      },
    },
  });
  res.status(200).json({ status: 'success', data: { claims } });
});

async function loadOwnedClaim(id, supplierId) {
  const claim = await prisma.refundClaim.findFirst({
    where: { id, supplierId },
    include: {
      booking: {
        select: { id: true, customerId: true, clientOrigin: true, source: true, bookingNumber: true, grossAmount: true, currency: true, tour: { select: { title: true } } },
      },
    },
  });
  return claim;
}

async function atomicSupplierTransition(id, supplierId, expected, nextStatus, setter, client = prisma) {
  const updated = await client.refundClaim.updateMany({
    where: { id, supplierId, status: expected },
    data: { status: nextStatus, ...setter },
  });
  return updated.count;
}

async function claimCurrentStatus(id) {
  const c = await prisma.refundClaim.findUnique({ where: { id }, select: { status: true } });
  return c?.status;
}

exports.supplierApprove = catchAsync(async (req, res, next) => {
  const supplierId = supplierContext(req);
  const claim = await loadOwnedClaim(req.params.id, supplierId);
  if (!claim) return next(new AppError('Claim not found or you cannot review it', 404));

  await assertIndependentReview(claim, supplierId);

  const changed = await atomicSupplierTransition(claim.id, supplierId, 'SUBMITTED', 'SUPPLIER_APPROVED', {
    reviewedById: req.user.id,
    reviewedAt: new Date(),
  });
  if (changed === 0) {
    return next(new AppError(`This claim is no longer awaiting your review (${await claimCurrentStatus(claim.id)})`, 409));
  }

  claimAudit('booking.refund_claim_approved', claim, req, { supplierId });

  notifyAdmin({
    type: 'REFUND_CLAIM',
    title: 'Refund request approved by provider',
    message: `Claim ${claim.claimNumber} was approved and is ready to release`,
    data: { bookingId: claim.bookingId, claimId: claim.id },
  }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));

  const tourTitle = claim.booking?.tour?.title || '';
  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Refund approved by the provider (${tourTitle})`,
      heading: 'Your refund request was approved',
      message: 'The provider approved your refund request. Our team will now release the refund to your original payment method — this usually takes a few business days.',
      buttonText: 'View booking',
      buttonUrl: customerBookingUrl(claim.booking),
      brandKey: resolveEmailBrand({ booking: claim.booking }),
    }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'SUPPLIER_APPROVED' } } });
});

exports.supplierDecline = catchAsync(async (req, res, next) => {
  const supplierId = supplierContext(req);
  const claim = await loadOwnedClaim(req.params.id, supplierId);
  if (!claim) return next(new AppError('Claim not found or you cannot review it', 404));

  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!note) return next(new AppError('Please add a note explaining the decision', 400));

  const changed = await prisma.$transaction(async (tx) => {
    const count = await atomicSupplierTransition(claim.id, supplierId, 'SUBMITTED', 'SUPPLIER_DECLINED', {
      reviewNote: note,
      reviewedById: req.user.id,
      reviewedAt: new Date(),
    }, tx);
    // No money moved and none will: put the supplier's share back in play.
    if (count > 0) await unfreezeBookingAfterDispute(tx, claim.bookingId);
    return count;
  });
  if (changed === 0) {
    return next(new AppError(`This claim is no longer awaiting your review (${await claimCurrentStatus(claim.id)})`, 409));
  }

  claimAudit('booking.refund_claim_declined', claim, req, { supplierId, note });

  const tourTitle = claim.booking?.tour?.title || '';
  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Update on your refund request (${tourTitle})`,
      heading: 'Your refund request was not approved',
      message: `The provider declined your refund request with this note: "${note}"`,
      buttonText: 'View booking',
      buttonUrl: customerBookingUrl(claim.booking),
      brandKey: resolveEmailBrand({ booking: claim.booking }),
    }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'SUPPLIER_DECLINED' } } });
});

/** Admins: claims across the lifecycle (defaults handled by the UI tabs). */
exports.getAdminClaims = catchAsync(async (req, res, next) => {
  const { status } = req.query;
  const where = {};
  if (status && status !== 'ALL') where.status = status;
  const claims = await prisma.refundClaim.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      booking: {
        select: {
          id: true,
          bookingNumber: true,
          grossAmount: true,
          currency: true,
          refundedAt: true,
          paymentStatus: true,
          customer: { select: { id: true, name: true, email: true } },
          tour: { select: { title: true, supplierId: true, supplier: { select: { name: true, email: true } } } },
        },
      },
    },
  });
  res.status(200).json({ status: 'success', data: { claims } });
});

async function loadClaimForAdmin(id) {
  const claim = await prisma.refundClaim.findFirst({
    where: { id },
    include: {
      booking: {
        select: {
          id: true,
          customerId: true,
          clientOrigin: true,
          source: true,
          status: true,
          grossAmount: true,
          currency: true,
          refundAmount: true,
          supplierPayout: true,
          payoutStatus: true,
          refundedAt: true,
          paymentStatus: true,
          paymentProvider: true,
          stripePaymentIntentId: true,
          paypalCaptureId: true,
          tour: { select: { title: true, supplierId: true, supplier: { select: { name: true } } } },
        },
      },
    },
  });
  return claim;
}

/**
 * Admin release — the only place money moves.
 * Runs inside a transaction that locks the claim row and bookends the Stripe
 * call with a PROCESSING checkpoint. If the Stripe call fails (or the process
 * dies), the transaction rolls back and the claim stays SUPPLIER_APPROVED, so
 * it can simply be released again — and concurrent releases can never double.
 */
exports.adminRelease = catchAsync(async (req, res, next) => {
  const claim = await loadClaimForAdmin(req.params.id);
  if (!claim) return next(new AppError('Claim not found', 404));

  const releasedAmount = Number(req.body?.releasedAmount ?? claim.booking?.grossAmount);
  if (!Number.isFinite(releasedAmount) || releasedAmount <= 0) {
    return next(new AppError('Release amount must be a positive number', 400));
  }

  // Nobody may release a refund on a booking they took themselves. With one
  // admin account this endpoint is the only way money leaves the platform, and
  // self-dealing is exactly the case a second pair of eyes exists to catch.
  if (claim.booking?.customerId && claim.booking.customerId === req.user?.id) {
    return next(new AppError('You cannot release a refund on your own booking', 403));
  }
  // An admin who is also the supplier is audited rather than blocked: on a
  // single-admin deployment this is the same person, and blocking would make
  // every release impossible. The flag makes the conflict visible in the trail.
  const adminIsSupplier =
    claim.supplierId === req.user?.id || claim.booking?.tour?.supplierId === req.user?.id;

  const twoPerson = await applyTwoPersonRule(
    claim,
    releasedAmount,
    claim.booking?.currency,
    req.user,
  );
  if (!twoPerson.proceed) {
    if (twoPerson.reason === 'registered') {
      claimAudit('booking.refund_claim_first_approved', claim, req, {
        releasedAmount,
        threshold: twoPerson.threshold,
        awaitingSecondAdmin: true,
      });
      notifyAdmin({
        type: 'REFUND_CLAIM',
        title: 'Refund needs a second admin',
        message: `Claim ${claim.claimNumber} (${claim.booking?.currency || 'USD'} ${releasedAmount.toFixed(2)}) was approved by one admin and is waiting for a second admin to release it.`,
        data: { bookingId: claim.bookingId, claimId: claim.id },
      }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
      return res.status(202).json({
        status: 'pending_approval',
        message:
          'This refund is above the two-admin threshold. Your approval is recorded; a different admin must release it.',
        data: {
          requiresSecondApproval: true,
          threshold: twoPerson.threshold,
          claim: { id: claim.id, status: claim.status },
        },
      });
    }
    if (twoPerson.reason === 'amount_changed') {
      return next(new AppError(
        `This release was already approved for ${twoPerson.firstApprovedAmount.toFixed(2)} ${claim.booking?.currency || 'USD'} — a second admin must approve this different amount`,
        409,
      ));
    }
    return next(new AppError('This refund already has your approval — a different admin must release it', 409));
  }

  let releaseResult = null;
  try {
    releaseResult = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RefundClaim" WHERE id = ${claim.id} FOR UPDATE`;
      const cur = await tx.refundClaim.findUnique({ where: { id: claim.id }, select: { status: true } });
      if (cur?.status !== 'SUPPLIER_APPROVED' && cur?.status !== 'PROCESSING') {
        throw new AppError(`This claim is not awaiting release (${cur?.status || 'unknown'})`, 409);
      }

      const booking = await tx.booking.findUnique({
        where: { id: claim.bookingId },
        // Both provider references are selected: the guard below has to ask the
        // processor that actually took the money, not Stripe by default.
        select: {
          id: true,
          bookingNumber: true,
          status: true,
          grossAmount: true,
          refundAmount: true,
          supplierPayout: true,
          payoutStatus: true,
          currency: true,
          refundedAt: true,
          paymentStatus: true,
          paymentProvider: true,
          stripePaymentIntentId: true,
          paypalCaptureId: true,
          tour: { select: { supplierId: true } },
        },
      });
      if (!booking || booking.refundedAt || booking.paymentStatus === 'REFUNDED') {
        throw new AppError('This booking has already been refunded', 409);
      }

      // A dispute can be opened AFTER the claim was submitted. Releasing here
      // would then refund the same trip twice — once from this claim, once from
      // the dispute decision — so refuse until the dispute is resolved.
      const openDispute = await tx.dispute.findFirst({
        where: { bookingId: booking.id, status: { in: OPEN_DISPUTE_STATUSES } },
        select: { id: true, disputeNumber: true },
      });
      if (openDispute) {
        throw new AppError(
          `Refund request ${openDispute.disputeNumber || openDispute.id} is still open for this booking — resolve it before releasing this claim`,
          409,
        );
      }

      const gross = Number(booking.grossAmount) || 0;
      const alreadyRefunded = round2(Number(booking.refundAmount) || 0);
      const remaining = Math.max(0, round2(gross - alreadyRefunded));
      if (releasedAmount > remaining + 0.005) {
        throw new AppError(
          `Release amount cannot exceed the refundable balance of ${remaining.toFixed(2)} ${booking.currency || 'USD'}`,
          400,
        );
      }
      const paidWithPaypal = booking.paymentProvider === 'PAYPAL';
      const hasRefundablePayment = paidWithPaypal ? booking.paypalCaptureId : booking.stripePaymentIntentId;
      if (!hasRefundablePayment) {
        throw new AppError('No payment method available to refund this booking', 502);
      }

      // PROCESSING checkpoint (only from SUPPLIER_APPROVED; a stuck PROCESSING
      // is a crash leftover and is re-runnable because nothing committed).
      if (cur.status === 'SUPPLIER_APPROVED') {
        await tx.refundClaim.update({
          where: { id: claim.id },
          data: { status: 'PROCESSING', releasedById: req.user.id, releasedAt: new Date() },
        });
      }

      const cents = Math.round(releasedAmount * 100);
      let refund = await findExistingClaimRefund(booking.stripePaymentIntentId, claim.id);
      if (refund && Number(refund.amount) !== cents) {
        throw new AppError(
          'A different refund amount was already issued for this claim — reconcile it manually before releasing',
          409,
        );
      }
      if (!refund) {
        try {
          refund = await refundBookingPayment(booking, cents, {
            metadata: {
              reason: 'customer_refund_claim',
              claimId: claim.id,
              bookingId: booking.id,
              // Lets the sales-channel refund alert name the admin who released it.
              adminId: req.user?.id || null,
            },
            // Deterministic key derived from the claim: a retry replays the SAME
            // refund instead of issuing a second one. Partial refunds are not
            // capped by Stripe the way a second full refund would be, so this is
            // the only thing standing between a crash-and-retry and paying twice.
            idempotencyKey: `refund_claim_${claim.id}`,
          });
        } catch (refundErr) {
          console.error('[RefundClaim] Stripe refund failed:', refundErr.message);
          throw new AppError(`Could not process the refund: ${refundErr.message}`, 502);
        }
      }

      // Who pays for the refund? If the supplier's share already left the
      // platform, the refund cannot remove it from payout eligibility any more,
      // so the supplier is debited. Otherwise the refund itself takes the
      // booking out of the payout.
      const economics = supplierChargeForRefund({
        grossAmount: gross,
        supplierPayout: booking.supplierPayout,
        refundAmount: releasedAmount,
        refundedSoFar: alreadyRefunded,
        payoutStatus: booking.payoutStatus,
      });

      let charge = null;
      if (economics.charge > 0) {
        charge = await tx.supplierCharge.create({
          data: {
            // The tour's current supplier, falling back to the one recorded on
            // the claim if the tour was reassigned after submission.
            supplierId: booking.tour?.supplierId || claim.supplierId,
            bookingId: booking.id,
            amount: economics.charge,
            currency: booking.currency || 'USD',
            reason: CUSTOMER_CLAIM_CHARGE_REASON,
            status: 'OPEN',
            notes: `Customer refund claim ${claim.claimNumber}: ${releasedAmount.toFixed(2)} ${booking.currency || 'USD'} refunded to the traveller after the payout`,
          },
        });
      }

      const newRefunded = round2(alreadyRefunded + releasedAmount);
      const full = newRefunded >= gross - 0.005;
      const providerStatus = String(refund?.status || '').toUpperCase();
      const refundState = {
        refundAmount: newRefunded,
        refundedAt: new Date(),
        refundStatus: providerStatus === 'PENDING' ? 'PENDING' : 'SUCCEEDED',
      };

      if (full) {
        if (!economics.payoutPaid) {
          // Not paid yet. Drop the payout and, when the booking sits on an
          // unpaid invoice or payout request, detach it from that document.
          // Removing the payment is the recovery; charging the supplier for
          // money they have not received would be a debt they never owed.
          await cancelBookingFunds(tx, booking.id);
          await detachBookingFromInvoices(tx, booking.id);
        }
        // A paid-out booking keeps its payout document and history; the
        // SupplierCharge above is the recovery. Either way the booking is
        // terminal.
        await tx.booking.update({
          where: { id: booking.id },
          data: { ...refundState, status: 'REFUNDED', paymentStatus: 'REFUNDED' },
        });
      } else {
        // A partial refund leaves the rest of the trip payable, so put the
        // supplier's share back in play (it was frozen when the claim opened).
        await tx.booking.update({ where: { id: booking.id }, data: refundState });
        await unfreezeBookingAfterDispute(tx, booking.id);
      }

      await tx.refundClaim.update({
        where: { id: claim.id },
        data: { status: 'RELEASED', releasedAmount },
      });

      return {
        refundId: refund?.id || refund?.refundId || null,
        chargeId: charge?.id || null,
        chargeAmount: economics.charge,
        full,
      };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`Could not release the refund: ${err.message}`, 502);
  }

  claimAudit('booking.refund_claim_released', claim, req, {
    releasedAmount,
    refundId: releaseResult?.refundId || null,
    supplierChargeId: releaseResult?.chargeId || null,
    supplierChargeAmount: releaseResult?.chargeAmount || 0,
    full: !!releaseResult?.full,
    threshold: twoPerson.threshold || null,
    firstApprovedById: twoPerson.firstApprovedById || null,
    secondPersonSkipped: !!twoPerson.skipped,
    adminIsSupplier,
  });

  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Refund released — ${claim.booking?.currency || 'USD'} ${releasedAmount.toFixed(2)}`,
      heading: 'Your refund has been released',
      message: `The refund of ${claim.booking?.currency || 'USD'} ${releasedAmount.toFixed(2)} for your trip "${claim.booking?.tour?.title || ''}" is on its way to your original payment method.`,
      buttonText: 'View booking',
      buttonUrl: customerBookingUrl(claim.booking),
      brandKey: resolveEmailBrand({ booking: claim.booking }),
    }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
  }

  // The Stripe webhook is told to skip claim refunds (their state is owned
  // here), so GA4 would otherwise never hear about the money that went back.
  try {
    const { sendRefund } = require('../services/ga4Measurement');
    const attributable = await prisma.booking.findUnique({
      where: { id: claim.bookingId },
      select: {
        id: true,
        bookingNumber: true,
        currency: true,
        grossAmount: true,
        gaClientId: true,
        analyticsConsent: true,
      },
    });
    if (attributable) await sendRefund(attributable, { value: releasedAmount });
  } catch (err) {
    console.warn('[RefundClaim] GA4 refund report failed:', err.message);
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'RELEASED', releasedAmount } } });
});

exports.adminDecline = catchAsync(async (req, res, next) => {
  const claim = await loadClaimForAdmin(req.params.id);
  if (!claim) return next(new AppError('Claim not found', 404));
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!note) return next(new AppError('Please add a note explaining the decision', 400));

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.refundClaim.updateMany({
      where: { id: claim.id, status: { in: ['SUBMITTED', 'SUPPLIER_APPROVED'] } },
      data: { status: 'ADMIN_DECLINED', reviewNote: note, releasedById: req.user.id, releasedAt: new Date() },
    });
    // Nothing will be refunded, so the supplier's frozen share goes back into
    // the payout pool.
    if (result.count > 0) await unfreezeBookingAfterDispute(tx, claim.bookingId);
    return result;
  });
  if (updated.count === 0) {
    return next(new AppError(`This claim is not awaiting a decision (${await claimCurrentStatus(claim.id)})`, 409));
  }

  claimAudit('booking.refund_claim_admin_declined', claim, req, { note });

  const tourTitle = claim.booking?.tour?.title || '';
  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Update on your refund request (${tourTitle})`,
      heading: 'Your refund request was not approved',
      message: `We could not release your refund: "${note}". If you have questions, contact support.`,
      buttonText: 'View booking',
      buttonUrl: customerBookingUrl(claim.booking),
      brandKey: resolveEmailBrand({ booking: claim.booking }),
    }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'ADMIN_DECLINED' } } });
});

exports.CLAIM_WINDOW_DAYS = CLAIM_WINDOW_DAYS;
exports.CLAIM_REASONS = CLAIM_REASONS;
exports.OPEN_CLAIM_STATUSES = OPEN_CLAIM_STATUSES;
exports.assertClaimable = assertClaimable;
