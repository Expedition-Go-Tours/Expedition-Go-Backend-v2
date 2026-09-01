const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { freezeBookingForDispute } = require('../utils/financeHelpers');
const { logActivity } = require('../utils/auditLogger');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { enqueueNotification, enqueueEmail } = require('../utils/queue');

// ── Supplier-initiated refund requests ──
// A supplier files a refund request when a customer's money should go back —
// cancellation policy enforcement, overbooking, force majeure, or a direct
// customer ask. An admin reviews every request: approving refunds the
// customer via Stripe and cancels the booking's funds; denying unfreezes the
// funds back to the supplier's eligible balance.
// Mounted at /disputes (see routes/disputeRoutes.js).
// NOTE: the model/table is named "Dispute" for historical reasons — everywhere
// user-facing calls this a "refund request".

const VALID_REASONS = [
  'OPERATIONAL', // guide/vehicle/venue unavailable, minimum participants not reached
  'FORCE_MAJEURE', // weather, disasters, events beyond the supplier's control
  'CUSTOMER_REQUESTED', // customer asked the supplier directly for a refund
  'OTHER',
];

// Funds must still be on the platform for a self-serve refund request:
// - PENDING  → upcoming booking, not yet cleared
// - ELIGIBLE → cleared, withdrawable
// REQUESTED  → cancel the payout request first; DISPUTED → one already open;
// CANCELLED  → already refunded/cancelled; PAID → money left the platform,
//              admin handles those manually (no clawback yet).
const DISPUTABLE_PAYOUT_STATUSES = ['PENDING', 'ELIGIBLE'];

function toNumber(v) {
  return v == null ? 0 : parseFloat(v);
}

/**
 * POST /disputes
 * Body: { bookingId, reason, description? }
 * Auth: supplier owner or team member with payouts.request permission
 */
exports.createDispute = catchAsync(async (req, res, next) => {
  const { bookingId, reason, description } = req.body || {};
  const supplierId = req.supplierId;

  if (!bookingId) return next(new AppError('bookingId is required', 400));
  if (!VALID_REASONS.includes(reason)) {
    return next(new AppError(`reason must be one of: ${VALID_REASONS.join(', ')}`, 400));
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, tour: { supplierId } },
    include: { tour: { select: { title: true, supplierId: true } }, customer: { select: { id: true, name: true, email: true } } },
  });
  if (!booking) return next(new AppError('Booking not found among your bookings', 404));

  if (booking.paymentStatus !== 'SUCCEEDED') {
    return next(new AppError('Refund requests can only be opened for paid bookings', 400));
  }

  if (!DISPUTABLE_PAYOUT_STATUSES.includes(booking.payoutStatus)) {
    const reasonMap = {
      REQUESTED: 'This booking is part of a payout request — cancel that request first',
      DISPUTED: 'A refund request is already open for this booking',
      CANCELLED: 'This booking has already been refunded or cancelled',
      PAID: 'This booking has already been paid out — contact support to arrange a refund',
    };
    return next(new AppError(reasonMap[booking.payoutStatus] || 'Funds for this booking cannot be refunded right now', 400));
  }

  const existing = await prisma.dispute.findFirst({
    where: { bookingId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
  });
  if (existing) {
    return next(new AppError(`An open refund request (${existing.disputeNumber}) already exists for this booking`, 409));
  }

  const ts = Date.now().toString().slice(-6);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const disputeNumber = `DS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${ts}${rand}`;

  const dispute = await prisma.$transaction(async (tx) => {
    const created = await tx.dispute.create({
      data: {
        disputeNumber,
        bookingId,
        openedById: req.user.id,
        supplierId,
        reason,
        description: description || null,
        status: 'OPEN',
      },
    });
    await freezeBookingForDispute(tx, bookingId);
    return created;
  });

  await logActivity({
    userId: req.user.id,
    action: 'dispute.opened',
    resource: 'Dispute',
    resourceId: dispute.id,
    metadata: { disputeNumber, bookingId, reason, bookingNumber: booking.bookingNumber },
  });

  // Admins review the queue — ping the admin notification feed.
  notifyAdmin({
    type: 'REFUND_REQUEST',
    title: 'New Refund Request',
    message: `${reason.replace(/_/g, ' ').toLowerCase()} refund request ${disputeNumber} for "${booking.tour.title}" (${booking.bookingNumber})`,
    data: { disputeId: dispute.id, disputeNumber, bookingId },
  }).catch(() => {});

  // Heads-up to the supplier account too (team members may file on behalf of
  // the owner).
  enqueueNotification({
    userId: supplierId,
    type: 'DISPUTE_OPENED',
    title: 'Refund Request Submitted',
    message: `Your refund request (${disputeNumber}) for "${booking.tour.title}" is awaiting review.`,
    data: { disputeId: dispute.id },
  }).catch(() => {});

  enqueueEmail({ type: 'dispute-opened', disputeId: dispute.id }).catch((err) =>
    console.error('[Dispute] Opening email failed:', err.message)
  );

  // Discord: rich embed with Approve / Deny buttons
  const { notifyDiscord } = require('../utils/discordNotifier');
  const adminDash = process.env.ADMIN_DASHBOARD_URL;
  const reviewUrl = adminDash ? `${adminDash.replace(/\/+$/, '')}/disputes/${dispute.id}` : null;
  const amount = toNumber(booking.grossAmount).toFixed(2);
  const reasonLabel = reason.replace(/_/g, ' ');
  notifyDiscord(
    'approvals',
    `Refund request ${disputeNumber} for "${booking.tour.title}"`,
    {
      title: 'Refund Request Opened',
      color: 0xffaa00,
      url: reviewUrl || undefined,
      fields: [
        { name: 'Request #', value: disputeNumber, inline: true },
        { name: 'Amount', value: `${booking.currency || 'USD'} ${amount}`, inline: true },
        { name: 'Reason', value: reasonLabel, inline: true },
        { name: 'Booking #', value: booking.bookingNumber, inline: true },
        { name: 'Tour', value: booking.tour.title, inline: true },
        { name: 'Supplier', value: supplierId, inline: true },
        ...(description ? [{ name: 'Details', value: description.slice(0, 1024), inline: false }] : []),
      ],
      cooldownKey: dispute.id,
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Approve Refund', custom_id: `dsp:approve:${dispute.id}` },
            { type: 2, style: 4, label: 'Deny', custom_id: `dsp:deny:${dispute.id}` },
          ],
        },
      ],
    }
  ).catch(() => {});

  // AI dispute recommendation (fire-and-forget, non-blocking)
  if (process.env.MIMO_API_KEY) {
    const { callMimo, parseJson } = require('../utils/mimoClient');
    const ctx = [
      `Dispute: ${disputeNumber}`,
      `Reason: ${reasonLabel}`,
      `Amount: ${booking.currency || 'USD'} ${amount}`,
      `Tour: ${booking.tour.title}`,
      `Booking: ${booking.bookingNumber} (status: ${booking.status}, payment: ${booking.paymentStatus})`,
      `Description: ${description || '(none)'}`,
    ].join('\n');
    callMimo({
      system: 'You are a travel-platform dispute advisor. Analyze the refund request and recommend: APPROVE (refund the customer), DENY (keep the funds with the supplier), or NEEDS更多信息 (cannot decide from available data). Return ONLY a JSON object: {"recommendation":"APPROVE|DENY|NEEDS更多信息","rationale":"1-3 sentence explanation","riskLevel":"low|medium|high"}',
      user: ctx,
      maxTokens: 512,
      temperature: 0.1,
    }).then((text) => {
      let parsed;
      try {
        parsed = parseJson(text);
      } catch (e) {
        console.warn(`[dispute] AI parse failed for ${disputeNumber}: ${e.message}`);
        return;
      }
      const rec = parsed.recommendation || 'NEEDS更多信息';
      const color = rec === 'APPROVE' ? 0x00c853 : rec === 'DENY' ? 0xff4444 : 0xffaa00;
      notifyDiscord(
        'approvals',
        `AI recommendation for ${disputeNumber}: **${rec}**`,
        {
          title: 'AI Dispute Recommendation',
          color,
          fields: [
            { name: 'Recommendation', value: rec, inline: true },
            { name: 'Risk level', value: parsed.riskLevel || '—', inline: true },
            { name: 'Rationale', value: (parsed.rationale || '—').slice(0, 1024), inline: false },
          ],
          cooldownKey: `${dispute.id}:ai`,
        }
      ).catch((e) => { console.warn(`[dispute] AI Discord notify failed: ${e.message}`); });
    }).catch((e) => { console.warn(`[dispute] AI call failed for ${disputeNumber}: ${e.message}`); });
  }

  res.status(201).json({ status: 'success', data: { dispute } });
});

/**
 * GET /disputes/mine
 * Refund requests opened by me (or on behalf of my supplier account).
 */
exports.getMyDisputes = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  const [disputes, totalCount] = await Promise.all([
    prisma.dispute.findMany({
      where: { openedById: req.user.id },
      include: {
        booking: { select: { bookingNumber: true, travelDate: true, grossAmount: true, currency: true, tour: { select: { title: true, coverPhoto: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.dispute.count({ where: { openedById: req.user.id } }),
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
 * PATCH /disputes/:id/withdraw
 * The filer pulls their own request back before it's resolved.
 */
exports.withdrawDispute = catchAsync(async (req, res, next) => {
  const dispute = await prisma.dispute.findFirst({
    where: { id: req.params.id, openedById: req.user.id, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
  });
  if (!dispute) return next(new AppError('Refund request not found or can no longer be withdrawn', 404));

  const { unfreezeBookingAfterDispute } = require('../utils/financeHelpers');

  await prisma.$transaction(async (tx) => {
    await tx.dispute.update({
      where: { id: dispute.id },
      data: { status: 'WITHDRAWN', resolution: 'Withdrawn by supplier', resolvedAt: new Date() },
    });
    await unfreezeBookingAfterDispute(tx, dispute.bookingId);
  });

  await logActivity({
    userId: req.user.id,
    action: 'dispute.withdrawn',
    resource: 'Dispute',
    resourceId: dispute.id,
    metadata: { disputeNumber: dispute.disputeNumber },
  });

  res.status(200).json({ status: 'success', data: { dispute: { id: dispute.id, status: 'WITHDRAWN' } } });
});
