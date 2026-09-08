/**
 * Completed-trip refund claims (customer-initiated).
 *
 * Flow: customer submits a claim on a paid, completed booking (within 30 days)
 *  -> supplier reviews (approve or decline)
 *  -> on supplier approval an admin releases the money (Stripe refund executed).
 *
 * Money only moves in adminRelease — the supplier decision is advisory and the
 * customer never triggers a charge directly.
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

const OPEN_CLAIM_STATUSES = ['SUBMITTED', 'SUPPLIER_APPROVED'];
const OPEN_DISPUTE_STATUSES = ['OPEN', 'UNDER_REVIEW'];

function claimNumber() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RC-${stamp}-${rand}`;
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

/** Shared guard: can this booking accept a new customer refund claim? */
function assertClaimable(booking, req) {
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
  if (claimType === 'PARTIAL') {
    const amount = Number(requestedAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return next(new AppError('Please enter how much you would like refunded', 400));
    }
  }

  const booking = await prisma.booking.findFirst({
    where: { id, customerId },
    include: {
      tour: { select: { supplierId: true, title: true } },
      disputes: { select: { status: true } },
      refundClaims: { select: { status: true } },
    },
  });

  assertClaimable(booking, req);

  if (booking.disputes?.some((d) => OPEN_DISPUTE_STATUSES.includes(d.status))) {
    throw new AppError('A refund is already being processed for this booking', 409);
  }
  if (booking.refundClaims?.some((c) => OPEN_CLAIM_STATUSES.includes(c.status))) {
    throw new AppError('You already have a refund request in progress for this booking', 409);
  }

  const supplierId = booking.tour?.supplierId;
  if (!supplierId) throw new AppError('Unable to route this refund request', 500);

  const grossAmount = Number(booking.grossAmount) || 0;
  if (claimType === 'PARTIAL') {
    const amount = Number(requestedAmount);
    if (amount > grossAmount) {
      throw new AppError(`The refund amount cannot exceed ${grossAmount.toFixed(2)} ${booking.currency || 'USD'}`, 400);
    }
    req.claimAmount = amount;
  }

  const claim = await prisma.refundClaim.create({
    data: {
      claimNumber: claimNumber(),
      bookingId: booking.id,
      customerId,
      supplierId,
      reason,
      details: typeof details === 'string' && details.trim() ? details.trim().slice(0, 2000) : null,
      type: claimType,
      requestedAmount: claimType === 'PARTIAL' ? req.claimAmount : null,
    },
  });

  const [supplierUser, customerUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: supplierId }, select: { email: true, name: true } }),
    prisma.user.findUnique({ where: { id: customerId }, select: { email: true, name: true } }),
  ]);
  const tourTitle = booking.tour?.title || 'your tour';

  // Notify the supplier + platform (admin) so the claim can be actioned.
  enqueueNotification({
    userId: supplierId,
    type: 'REFUND_CLAIM',
    title: 'Refund request received',
    message: `A customer requested a ${claimType.toLowerCase()} refund for "${tourTitle}".`,
    data: { bookingId: booking.id, claimId: claim.id, source: 'expedition' },
  }).catch((err) => console.error("[RefundClaim] notify/email failed:", err && err.message));

  notifyAdmin({
    type: 'REFUND_CLAIM',
    title: 'Customer refund request',
    message: `${customerUser?.name || 'A customer'} requested a refund (claim ${claim.claimNumber})`,
    data: { bookingId: booking.id, claimId: claim.id },
  }).catch((err) => console.error("[RefundClaim] notify/email failed:", err && err.message));

  // Supplier email so the request is seen outside the app.
  if (supplierUser?.email) {
    sendClaimEmail({
      to: supplierUser.email,
      subject: `Refund request for "${tourTitle}"`,
      heading: 'A customer requested a refund',
      message: `A customer has requested a ${claimType.toLowerCase()} refund for "${tourTitle}" (${claim.claimNumber}). Review it and approve so our team can release the money, or decline with a note.`,
      buttonText: 'Review request',
      buttonUrl: `${emailUrls.supplierDashboard()}/finance?tab=claims&claimId=${claim.id}`,
    }).catch((err) => console.error("[RefundClaim] notify/email failed:", err && err.message));
  }

  // Confirmation to the customer.
  if (customerUser?.email) {
    sendClaimEmail({
      to: customerUser.email,
      subject: 'We received your refund request',
      heading: 'Refund request received',
      message: `Your ${claimType.toLowerCase()} refund request for "${tourTitle}" has been submitted. The provider will review it, and if approved our team will release the refund to your original payment method.`,
      buttonText: 'View booking',
      buttonUrl: `${emailUrls.CLIENT_URL || 'https://travioafrica.com'}/dashboard/bookings?booking=${booking.id}`,
    }).catch((err) => console.error("[RefundClaim] notify/email failed:", err && err.message));
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
    include: { booking: { include: { tour: { select: { supplierId: true, title: true } } } } },
  });
  return claim;
}

exports.supplierApprove = catchAsync(async (req, res, next) => {
  const supplierId = supplierContext(req);
  const claim = await loadOwnedClaim(req.params.id, supplierId);
  if (!claim) return next(new AppError('Claim not found or you cannot review it', 404));
  if (claim.status !== 'SUBMITTED') return next(new AppError('This claim is no longer awaiting your review', 409));

  await prisma.refundClaim.update({
    where: { id: claim.id },
    data: { status: 'SUPPLIER_APPROVED', reviewedById: req.user.id, reviewedAt: new Date() },
  });

  notifyAdmin({
    type: 'REFUND_CLAIM',
    title: 'Refund request approved by provider',
    message: `Claim ${claim.claimNumber} was approved and is ready to release`,
    data: { bookingId: claim.bookingId, claimId: claim.id },
  }).catch((err) => console.error("[RefundClaim] notify/email failed:", err && err.message));

  // Tell the customer their provider approved it (release is pending admin).
  const tourTitle = claim.booking?.tour?.title || '';
  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Refund approved by the provider (${tourTitle})`,
      heading: 'Your refund request was approved',
      message: 'The provider approved your refund request. Our team will now release the refund to your original payment method — this usually takes a few business days.',
      buttonText: 'View booking',
      buttonUrl: `${emailUrls.CLIENT_URL || 'https://travioafrica.com'}/dashboard/bookings?booking=${claim.bookingId}`,
    }).catch((err) => console.error("[RefundClaim] notify/email failed:", err && err.message));
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'SUPPLIER_APPROVED' } } });
});

exports.supplierDecline = catchAsync(async (req, res, next) => {
  const supplierId = supplierContext(req);
  const claim = await loadOwnedClaim(req.params.id, supplierId);
  if (!claim) return next(new AppError('Claim not found or you cannot review it', 404));
  if (claim.status !== 'SUBMITTED') return next(new AppError('This claim is no longer awaiting your review', 409));

  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!note) return next(new AppError('Please add a note explaining the decision', 400));

  await prisma.refundClaim.update({
    where: { id: claim.id },
    data: { status: 'SUPPLIER_DECLINED', reviewNote: note, reviewedById: req.user.id, reviewedAt: new Date() },
  });

  const tourTitle = claim.booking?.tour?.title || '';
  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Update on your refund request (${tourTitle})`,
      heading: 'Your refund request was not approved',
      message: `The provider declined your refund request with this note: "${note}"`,
    }).catch((err) => console.error("[RefundClaim] notify/email failed:", err && err.message));
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'SUPPLIER_DECLINED' } } });
});

/** Admins: claims that were approved by the supplier and await release. */
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
    include: { booking: { include: { tour: { select: { title: true, supplier: { select: { name: true } } } } } } },
  });
  return claim;
}

exports.adminRelease = catchAsync(async (req, res, next) => {
  const claim = await loadClaimForAdmin(req.params.id);
  if (!claim) return next(new AppError('Claim not found', 404));
  if (claim.status !== 'SUPPLIER_APPROVED') return next(new AppError('Only provider-approved claims can be released', 409));

  const booking = claim.booking;
  if (!booking || booking.refundedAt || booking.paymentStatus === 'REFUNDED') {
    return next(new AppError('This booking has already been refunded', 409));
  }

  const paidTotal = Number(booking.grossAmount) || 0;
  const releasedAmount = Number(req.body?.releasedAmount ?? paidTotal);
  if (!Number.isFinite(releasedAmount) || releasedAmount <= 0 || releasedAmount > paidTotal) {
    return next(new AppError(`Release amount must be between 0 and ${paidTotal.toFixed(2)} ${booking.currency || 'USD'}`, 400));
  }

  if (!booking.stripePaymentIntentId) {
    return next(new AppError('No payment method available to refund this booking', 502));
  }

  const cents = Math.round(releasedAmount * 100);
  try {
    await createRefund(booking.stripePaymentIntentId, cents, {
      metadata: { reason: 'customer_refund_claim', claimId: claim.id, bookingId: booking.id },
    });
  } catch (err) {
    console.error('[RefundClaim] Stripe refund failed:', err.message);
    return next(new AppError(`Could not process the refund: ${err.message}`, 502));
  }

  await prisma.$transaction([
    prisma.refundClaim.update({
      where: { id: claim.id },
      data: {
        status: 'RELEASED',
        releasedById: req.user.id,
        releasedAt: new Date(),
        releasedAmount,
        reviewNote: claim.reviewNote,
      },
    }),
    prisma.booking.update({
      where: { id: booking.id },
      data: { refundedAt: new Date(), refundAmount: releasedAmount },
    }),
  ]);

  // Customer notification that the money is on its way.
  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Refund released — ${booking.currency || 'USD'} ${releasedAmount.toFixed(2)}`,
      heading: 'Your refund has been released',
      message: `The refund of ${booking.currency || 'USD'} ${releasedAmount.toFixed(2)} for your trip "${booking.tour?.title || ''}" is on its way to your original payment method.`,
    }).catch((err) => console.error("[RefundClaim] notify/email failed:", err && err.message));
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'RELEASED', releasedAmount } } });
});

exports.adminDecline = catchAsync(async (req, res, next) => {
  const claim = await loadClaimForAdmin(req.params.id);
  if (!claim) return next(new AppError('Claim not found', 404));
  if (!['SUBMITTED', 'SUPPLIER_APPROVED'].includes(claim.status)) {
    return next(new AppError('This claim is not awaiting release', 409));
  }
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!note) return next(new AppError('Please add a note explaining the decision', 400));

  await prisma.refundClaim.update({
    where: { id: claim.id },
    data: { status: 'ADMIN_DECLINED', reviewNote: note, releasedById: req.user.id, releasedAt: new Date() },
  });

  const tourTitle = claim.booking?.tour?.title || '';
  const customerEmail = await userEmail(claim.booking?.customerId);
  if (customerEmail) {
    sendClaimEmail({
      to: customerEmail,
      subject: `Update on your refund request (${tourTitle})`,
      heading: 'Your refund request was not approved',
      message: `We could not release your refund: "${note}". If you have questions, contact support.`,
    }).catch((err) => console.error("[RefundClaim] notify/email failed:", err && err.message));
  }

  res.status(200).json({ status: 'success', data: { claim: { ...claim, status: 'ADMIN_DECLINED' } } });
});

exports.CLAIM_WINDOW_DAYS = CLAIM_WINDOW_DAYS;
exports.CLAIM_REASONS = CLAIM_REASONS;
exports.OPEN_CLAIM_STATUSES = OPEN_CLAIM_STATUSES;
exports.assertClaimable = assertClaimable;
