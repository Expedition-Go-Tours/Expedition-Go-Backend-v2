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
 *  - Admin release runs inside a transaction that locks the claim row and uses
 *    a PROCESSING checkpoint; a crash rolls back cleanly to SUPPLIER_APPROVED
 *    and duplicate/concurrent releases are impossible.
 *  - Every status change is guarded (updateMany/row-lock against the expected
 *    status) so approve/decline/release never double-apply.
 *  - Eligibility blocks any booking that has already received money back via
 *    any path (supplier dispute RESOLVED_CUSTOMER, earlier RELEASED claim, or
 *    refundedAt/REFUNDED), preventing double refunds.
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { enqueueNotification } = require('../utils/queue');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { createRefund } = require('../utils/stripeHelpers');
const { sendEmail } = require('../utils/emailService');
const emailUrls = require('../config/emailUrls');

const CLAIM_WINDOW_DAYS = 30;
const CLAIM_WINDOW_MS = CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000;

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

async function sendClaimEmail({ to, subject, heading, message, buttonText, buttonUrl }) {
  try {
    await sendEmail({
      to,
      subject,
      template: 'generic-notification',
      data: {
        header: heading,
        message,
        buttonText: buttonText || 'View details',
        buttonUrl: buttonUrl || emailUrls.supplierDashboard(),
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

    return createClaimWithRetry(tx, {
      bookingId: booking.id,
      customerId,
      supplierId,
      reason,
      details: typeof details === 'string' && details.trim() ? details.trim().slice(0, 2000) : null,
      type: claimType,
      requestedAmount: amountToRequest,
    });
  });

  const [supplierUser, customerUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: claim.supplierId }, select: { email: true, name: true } }),
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
      buttonUrl: `${emailUrls.supplierDashboard()}/finance?tab=claims&claimId=${claim.id}`,
    }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
  }

  if (customerUser?.email) {
    const booking = await prisma.booking.findUnique({
      where: { id: claim.bookingId },
      select: { id: true, clientOrigin: true },
    });
    sendClaimEmail({
      to: customerUser.email,
      subject: 'We received your refund request',
      heading: 'Refund request received',
      message: `Your ${claimType.toLowerCase()} refund request for "${tourTitle}" has been submitted. The provider will review it, and if approved our team will release the refund to your original payment method.`,
      buttonText: 'View booking',
      buttonUrl: customerBookingUrl({ id: booking?.id || claim.bookingId, clientOrigin: booking?.clientOrigin }),
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
        select: { id: true, customerId: true, clientOrigin: true, bookingNumber: true, grossAmount: true, currency: true, tour: { select: { title: true } } },
      },
    },
  });
  return claim;
}

async function atomicSupplierTransition(id, supplierId, expected, nextStatus, setter) {
  const updated = await prisma.refundClaim.updateMany({
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

  const changed = await atomicSupplierTransition(claim.id, supplierId, 'SUBMITTED', 'SUPPLIER_APPROVED', {
    reviewedById: req.user.id,
    reviewedAt: new Date(),
  });
  if (changed === 0) {
    return next(new AppError(`This claim is no longer awaiting your review (${await claimCurrentStatus(claim.id)})`, 409));
  }

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

  const changed = await atomicSupplierTransition(claim.id, supplierId, 'SUBMITTED', 'SUPPLIER_DECLINED', {
    reviewNote: note,
    reviewedById: req.user.id,
    reviewedAt: new Date(),
  });
  if (changed === 0) {
    return next(new AppError(`This claim is no longer awaiting your review (${await claimCurrentStatus(claim.id)})`, 409));
  }

  const tourTitle = claim.booking?.tour?.title || '';
  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Update on your refund request (${tourTitle})`,
      heading: 'Your refund request was not approved',
      message: `The provider declined your refund request with this note: "${note}"`,
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
          grossAmount: true,
          currency: true,
          refundedAt: true,
          paymentStatus: true,
          stripePaymentIntentId: true,
          tour: { select: { title: true, supplier: { select: { name: true } } } },
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

    try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RefundClaim" WHERE id = ${claim.id} FOR UPDATE`;
      const cur = await tx.refundClaim.findUnique({ where: { id: claim.id }, select: { status: true } });
      if (cur?.status !== 'SUPPLIER_APPROVED' && cur?.status !== 'PROCESSING') {
        throw new AppError(`This claim is not awaiting release (${cur?.status || 'unknown'})`, 409);
      }

      const booking = await tx.booking.findUnique({
        where: { id: claim.bookingId },
        select: { id: true, grossAmount: true, currency: true, refundedAt: true, paymentStatus: true, stripePaymentIntentId: true },
      });
      if (!booking || booking.refundedAt || booking.paymentStatus === 'REFUNDED') {
        throw new AppError('This booking has already been refunded', 409);
      }
      const paidTotal = Number(booking.grossAmount) || 0;
      if (releasedAmount > paidTotal) {
        throw new AppError(`Release amount cannot exceed ${paidTotal.toFixed(2)} ${booking.currency || 'USD'}`, 400);
      }
      if (!booking.stripePaymentIntentId) {
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
      try {
        await createRefund(booking.stripePaymentIntentId, cents, {
          metadata: { reason: 'customer_refund_claim', claimId: claim.id, bookingId: booking.id },
        });
      } catch (refundErr) {
        console.error('[RefundClaim] Stripe refund failed:', refundErr.message);
        throw new AppError(`Could not process the refund: ${refundErr.message}`, 502);
      }

      await tx.refundClaim.update({
        where: { id: claim.id },
        data: { status: 'RELEASED', releasedAmount },
      });
      await tx.booking.update({
        where: { id: booking.id },
        data: { refundedAt: new Date(), refundAmount: releasedAmount },
      });
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`Could not release the refund: ${err.message}`, 502);
  }

  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Refund released — ${claim.booking?.currency || 'USD'} ${releasedAmount.toFixed(2)}`,
      heading: 'Your refund has been released',
      message: `The refund of ${claim.booking?.currency || 'USD'} ${releasedAmount.toFixed(2)} for your trip "${claim.booking?.tour?.title || ''}" is on its way to your original payment method.`,
      buttonText: 'View booking',
      buttonUrl: customerBookingUrl(claim.booking),
    }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'RELEASED', releasedAmount } } });
});

exports.adminDecline = catchAsync(async (req, res, next) => {
  const claim = await loadClaimForAdmin(req.params.id);
  if (!claim) return next(new AppError('Claim not found', 404));
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!note) return next(new AppError('Please add a note explaining the decision', 400));

  const updated = await prisma.refundClaim.updateMany({
    where: { id: claim.id, status: { in: ['SUBMITTED', 'SUPPLIER_APPROVED'] } },
    data: { status: 'ADMIN_DECLINED', reviewNote: note, releasedById: req.user.id, releasedAt: new Date() },
  });
  if (updated.count === 0) {
    return next(new AppError(`This claim is not awaiting a decision (${await claimCurrentStatus(claim.id)})`, 409));
  }

  const tourTitle = claim.booking?.tour?.title || '';
  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Update on your refund request (${tourTitle})`,
      heading: 'Your refund request was not approved',
      message: `We could not release your refund: "${note}". If you have questions, contact support.`,
    }).catch((err) => console.error('[RefundClaim] notify/email failed:', err && err.message));
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'ADMIN_DECLINED' } } });
});

exports.CLAIM_WINDOW_DAYS = CLAIM_WINDOW_DAYS;
exports.CLAIM_REASONS = CLAIM_REASONS;
exports.OPEN_CLAIM_STATUSES = OPEN_CLAIM_STATUSES;
exports.assertClaimable = assertClaimable;
