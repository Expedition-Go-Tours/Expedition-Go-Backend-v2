/**
 * Supplier Cancellation Core — GetYourGuide-style flow, single source of truth.
 *
 * Everything that cancels a booking *on behalf of a supplier* goes through
 * here (the status endpoint, the bulk wizard) so the money rules can never
 * drift between entry points:
 *
 *  1. Supplier cancels with a structured reason (cancellationReasons.js).
 *  2. Customer ALWAYS gets a full refund on a supplier-caused cancel — the
 *     customer-facing cancellation policy is ignored (GYG Supplier T&C §3.10).
 *     Exception: a CUSTOMER_REQUESTED cancel where the supplier states they
 *     do NOT agree to refund — that one falls back to the tour policy and is
 *     flagged to admin for review.
 *  3. OPERATIONAL cancels create a 25%-of-retail SupplierCharge, netted off
 *     the supplier's next payout request (financeController.createPayoutRequest).
 *  4. Supplier-caused cancels open a 48h choice window: the customer picks
 *     a new date (reschedule — treated as an amendment, no fee/rate hit) or a
 *     full refund; silence past the deadline auto-refunds (the sweep in
 *     resolveCancellationChoices).
 *  5. refundStatus is the authoritative refund state — paymentStatus is only
 *     ever stamped REFUNDED when Stripe actually refunded.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const { createRefund } = require('./stripeHelpers');
const { evaluateCancellationPolicy } = require('./bookingHelpers');
const { evaluateBookingAvailability } = require('./availabilityCore');
const { detachBookingFromActiveRequests } = require('./financeHelpers');
const { enqueueEmail, enqueueNotification, enqueueEvent } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
const { logActivity } = require('./auditLogger');
const {
  CATEGORIES,
  ORIGINS,
  REFUND_STATES,
  calcCancellationFee,
  validateCancellationPayload,
} = require('./cancellationReasons');

const CHOICE_WINDOW_HOURS = (() => {
  const raw = parseInt(process.env.CANCELLATION_CHOICE_HOURS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 48;
})();

// A PROCESSING refund older than this may be reclaimed (Stripe idempotency
// keys are valid 24h, so a re-attempt inside the window can never double-refund).
const REFUND_RECLAIM_MIN_MS = 10 * 60 * 1000;
// Beyond the idempotency window a stuck PROCESSING row needs human eyes.
const REFUND_STUCK_MS = 24 * 60 * 60 * 1000;

const BATCH_MAX = 100;

function travelerTotal(travelers) {
  const t = travelers && typeof travelers === 'object' ? travelers : {};
  return (t.adults || 0) + (t.children || 0) + (t.infants || 0) || 1;
}

function dateKeyOf(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * How much does the customer get back when *we* cancel for them?
 *  - never paid               → 0 (nothing to refund)
 *  - supplier-caused          → ALWAYS full retail (policy ignored) — GYG rule
 *  - customer-requested + supplier agrees to refund → full retail
 *  - customer-requested + supplier disagrees        → the tour's own policy
 *                                                      (flagged to admin)
 */
function plannedRefund(booking, tour, normalized) {
  if (booking.paymentStatus !== 'SUCCEEDED') {
    return { amount: 0, note: 'not-paid' };
  }
  const gross = parseFloat(booking.grossAmount) || 0;

  const customerRequestedNoRefund =
    normalized.cancellationCategory === CATEGORIES.CUSTOMER_REQUESTED &&
    normalized.customerRefundAgreed === false;

  if (customerRequestedNoRefund) {
    const check = evaluateCancellationPolicy(booking, tour);
    return {
      amount: Math.min(Math.max(parseFloat(check.refundAmount) || 0, 0), gross),
      note: `customer-requested, supplier disagrees → policy: ${check.reason}`,
    };
  }

  return { amount: gross, note: 'full refund (supplier cancellation)' };
}

/**
 * Atomically run the planned refund for a cancelled booking.
 * Claim PENDING → PROCESSING so a click and the sweep can never both pay out;
 * Stripe idempotency key `supplier-cancel-refund:<bookingId>` makes retries
 * safe even if we crash between the charge and the DB write.
 *
 * @returns {{ claimed: boolean, succeeded?: boolean, error?: string }}
 */
async function executeRefund(bookingOrId) {
  const id = typeof bookingOrId === 'string' ? bookingOrId : bookingOrId.id;

  // Reclaim a refund that crashed mid-flight inside the idempotency window.
  await prisma.booking.updateMany({
    where: {
      id,
      refundStatus: REFUND_STATES.PROCESSING,
      updatedAt: { lt: new Date(Date.now() - REFUND_RECLAIM_MIN_MS) },
      // Inside Stripe's 24h idempotency window only.
      AND: [{ updatedAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }],
    },
    data: { refundStatus: REFUND_STATES.PENDING, updatedAt: new Date() },
  });

  const claim = await prisma.booking.updateMany({
    where: { id, refundStatus: REFUND_STATES.PENDING },
    data: { refundStatus: REFUND_STATES.PROCESSING, updatedAt: new Date() },
  });
  if (claim.count === 0) return { claimed: false };

  const booking = await prisma.booking.findUnique({ where: { id } });
  if (!booking) return { claimed: false };

  const amount = parseFloat(booking.refundAmount) || 0;
  if (amount <= 0 || booking.paymentStatus !== 'SUCCEEDED') {
    // Nothing to move — close the loop honestly.
    await prisma.booking.update({
      where: { id },
      data: { refundStatus: REFUND_STATES.NOT_APPLICABLE, updatedAt: new Date() },
    });
    return { claimed: true, succeeded: true, amount: 0 };
  }

  try {
    await createRefund(booking.stripePaymentIntentId, Math.round(amount * 100), {
      idempotencyKey: `supplier-cancel-refund:${booking.id}`,
    });
    await prisma.booking.update({
      where: { id },
      data: {
        refundStatus: REFUND_STATES.SUCCEEDED,
        paymentStatus: 'REFUNDED',
        refundAmount: amount,
        refundedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // The money went back — tell the customer with the real amount.
    enqueueEmail({
      type: 'refund-completed',
      bookingId: booking.id,
      data: { refundAmount: amount },
    }).catch((err) => console.error('[Cancellation] refund-completed email failed:', err.message));

    return { claimed: true, succeeded: true, amount };
  } catch (err) {
    console.error(`[Cancellation] Stripe refund failed for booking ${id}:`, err.message);
    await prisma.booking.update({
      where: { id },
      data: { refundStatus: REFUND_STATES.FAILED, updatedAt: new Date() },
    }).catch(() => {});
    notifyAdmin({
      type: 'REFUND_NEEDS_ATTENTION',
      title: 'Supplier-cancel refund failed',
      message: `Refund for booking #${booking.bookingNumber} (${booking.currency} ${amount.toFixed(2)}) failed at Stripe and needs a manual retry. Booking ${id}.`,
      data: { bookingId: booking.id, amount, error: String(err.message).slice(0, 500) },
    }).catch(() => {});
    return { claimed: true, succeeded: false, error: err.message };
  }
}

/**
 * Cancel a booking on behalf of the supplier. Validates the structured
 * payload, applies the money rules, opens the 48h choice window (supplier-
 * caused cancels) and fires every notification.
 *
 * @param {object} args
 * @param {object} args.booking     booking row incl. tour (and tour.supplier when available)
 * @param {object} args.payload     raw wizard body (validated here — never trusted)
 * @param {string} args.supplierId  acting supplier user id (audit log)
 * @param {object} [args.req]       express request for event metadata
 * @param {boolean} [args.skipValidation] internal batch caller already validated
 */
async function cancelBySupplier({ booking, payload, supplierId, req, skipValidation = false }) {
  const validation = skipValidation
    ? { ok: true, errors: [], normalized: payload }
    : validateCancellationPayload(payload);

  if (!validation.ok) {
    throw new AppError(validation.errors.join('; '), 400);
  }
  const input = validation.normalized;

  const tour = booking.tour;
  const refund = plannedRefund(booking, tour, input);
  const fee = calcCancellationFee(booking.grossAmount, input);

  // GYG opens the reschedule-or-refund choice for supplier-caused cancels.
  // A customer-requested cancel skips it — the customer already decided.
  const opensChoiceWindow = input.cancellationCategory !== CATEGORIES.CUSTOMER_REQUESTED;
  const choiceDeadline = opensChoiceWindow
    ? new Date(Date.now() + CHOICE_WINDOW_HOURS * 60 * 60 * 1000)
    : null;

  const refundState =
    booking.paymentStatus !== 'SUCCEEDED' || refund.amount <= 0
      ? REFUND_STATES.NOT_APPLICABLE
      : REFUND_STATES.PENDING;

  const now = new Date();
  const cancellationReasonLabel =
    input.explanation ||
    (input.cancellationCategory === CATEGORIES.OPERATIONAL ? 'Operational cancellation' : 'Cancelled by supplier');

  const result = await prisma.$transaction(async (tx) => {
    const updateData = {
      status: 'CANCELLED',
      cancellationReason: cancellationReasonLabel,
      cancellationCode: input.cancellationCode,
      cancellationCategory: input.cancellationCategory,
      cancellationOrigin: ORIGINS.SUPPLIER,
      countsTowardRate: input.countsTowardRate,
      cancellationFee: fee > 0 ? fee : null,
      refundStatus: refundState,
      refundAmount: refund.amount > 0 ? refund.amount : null,
      cancellationAgreedAt: input.agreedToTerms ? now : null,
      cancellationEvidenceUrl: input.evidenceUrl,
      cancellationChoiceDeadline: choiceDeadline,
      customerChoice: null,
      customerChoiceAt: null,
      proposedTravelDate: null,
      cancelledAt: now,
      payoutStatus: 'CANCELLED',
      supplierNotes: booking.supplierNotes || null,
      updatedAt: now,
    };

    const updatedBooking = await tx.booking.update({ where: { id: booking.id }, data: updateData });

    // A cancelled booking must never pay the supplier — close ledger rows.
    await tx.payout.updateMany({
      where: { bookingId: booking.id, status: 'PENDING' },
      data: { status: 'CANCELLED', processedAt: now },
    });

    // Finance v2: detach from any active payout request.
    await detachBookingFromActiveRequests(tx, booking.id);

    // 25%-of-retail fee (operational cancels only).
    if (fee > 0) {
      await tx.supplierCharge.create({
        data: {
          supplierId: booking.tour.supplierId,
          bookingId: booking.id,
          amount: fee,
          currency: booking.currency || 'USD',
          reason: 'SUPPLIER_CANCELLATION_FEE',
          status: 'OPEN',
          notes: `Cancellation fee (${input.cancellationCategory}) for booking ${booking.bookingNumber}`,
        },
      });
    }

    // Return unused offer spots.
    if (booking.appliedOfferId) {
      await tx.specialOffer.update({
        where: { id: booking.appliedOfferId },
        data: { spotsSold: { decrement: travelerTotal(booking.travelers) } },
      });
    }

    return { updatedBooking };
  });

  // ── Immediate refund path (no choice window): customer-requested ──
  let refundResult = null;
  if (refundState === REFUND_STATES.PENDING && !choiceDeadline) {
    refundResult = await executeRefund(booking.id);
  }

  // ── Notifications ──────────────────────────────────────────────────────
  const customerMessage = choiceDeadline
    ? `Your booking "${tour.title}" has been cancelled by the supplier. Choose a new date or a full refund — you have ${CHOICE_WINDOW_HOURS} hours to decide.`
    : `Your booking "${tour.title}" has been cancelled by the supplier`;

  enqueueNotification({
    userId: booking.customerId,
    type: choiceDeadline ? 'CANCELLATION_CHOICE_REQUIRED' : 'BOOKING_CANCELLED',
    title: 'Booking Cancelled',
    message: customerMessage,
    data: { bookingId: booking.id, choiceDeadline: choiceDeadline ? choiceDeadline.toISOString() : null },
  }).catch((err) => console.error('[Cancellation] customer notification failed:', err.message));

  enqueueEmail({
    type: 'supplier-cancelled-booking',
    bookingId: booking.id,
    data: { reason: cancellationReasonLabel },
  }).catch((err) => console.error('[Cancellation] customer email failed:', err.message));

  if (fee > 0) {
    enqueueEmail({
      type: 'supplier-cancellation-fee',
      bookingId: booking.id,
      data: { feeAmount: fee, feePct: input.cancellationCategory },
    }).catch((err) => console.error('[Cancellation] fee email failed:', err.message));

    enqueueNotification({
      userId: booking.tour.supplierId,
      type: 'PAYOUT_PROCESSED',
      title: 'Cancellation fee applied',
      message: `A cancellation fee of ${(booking.currency || 'USD')} ${fee.toFixed(2)} was applied to booking ${booking.bookingNumber}. It will be deducted from your next payout.`,
      data: { bookingId: booking.id, fee },
    }).catch((err) => console.error('[Cancellation] fee notification failed:', err.message));
  }

  logActivity({
    userId: supplierId,
    action: 'booking.cancelled',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: {
      structured: true,
      cancellationCode: input.cancellationCode,
      category: input.cancellationCategory,
      countsTowardRate: input.countsTowardRate,
      refundAmount: refund.amount,
      fee,
      choiceDeadline: choiceDeadline ? choiceDeadline.toISOString() : null,
      refundNote: refund.note,
    },
  }).catch(() => {});

  enqueueEvent({
    name: 'booking.cancelled',
    userId: supplierId,
    req,
    resource: 'Booking',
    resourceId: booking.id,
    properties: {
      reason: input.cancellationCode,
      category: input.cancellationCategory,
      refundAmount: refund.amount,
      fee,
      tourId: booking.tourId,
    },
  }).catch(() => {});

  return {
    booking: result.updatedBooking,
    refundAmount: refund.amount,
    refundStatus: result.updatedBooking.refundStatus,
    refundExecuted: refundResult ? refundResult.succeeded === true : false,
    fee,
    choiceDeadline,
    countsTowardRate: input.countsTowardRate,
  };
}

/**
 * The customer picked "Choose a new date". Validates availability, restores
 * the booking on the new date and unwinds the cancellation (no fee, not
 * counted against the rate — the experience still happens).
 */
async function resolveChoiceReschedule(booking, newTravelDate) {
  const target = newTravelDate ? new Date(newTravelDate) : null;
  if (!target || Number.isNaN(target.getTime())) {
    throw new AppError('Choose a valid new date', 400);
  }
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (target < startOfToday) {
    throw new AppError('The new date must be in the future', 400);
  }

  const tour = await prisma.tour.findUnique({ where: { id: booking.tourId } });
  if (!tour) throw new AppError('Tour not found', 404);

  const availability = await evaluateBookingAvailability(
    prisma,
    tour,
    dateKeyOf(target),
    booking.selectedTime || null,
    booking.travelers,
    { excludeBookingId: booking.id }
  );
  if (!availability.ok) {
    throw new AppError(`That date is not available: ${availability.reason || 'no capacity'}`, 400);
  }

  const now = new Date();
  const restoredStatus = booking.paymentStatus === 'SUCCEEDED' ? 'CONFIRMED' : 'PENDING';

  const updated = await prisma.$transaction(async (tx) => {
    // Claim the choice atomically so a click + the sweep can't both act.
    const claim = await tx.booking.updateMany({
      where: {
        id: booking.id,
        status: 'CANCELLED',
        OR: [{ customerChoice: null }, { customerChoice: 'RESCHEDULE' }],
      },
      data: { customerChoice: 'RESCHEDULE', customerChoiceAt: now },
    });
    if (claim.count === 0) return null;

    const restored = await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: restoredStatus,
        travelDate: target,
        proposedTravelDate: target,
        cancelledAt: null,
        cancellationChoiceDeadline: null,
        refundAmount: null,
        refundStatus: REFUND_STATES.NOT_APPLICABLE,
        countsTowardRate: false, // rebooked — the experience still happens
        cancellationFee: null,
        payoutStatus: booking.paymentStatus === 'SUCCEEDED' ? 'PENDING' : 'CANCELLED',
        updatedAt: now,
      },
    });

    // Waive any fee created when the cancel was first filed.
    await tx.supplierCharge.updateMany({
      where: { bookingId: booking.id, status: 'OPEN' },
      data: { status: 'WAIVED', settledAt: now, notes: 'Waived — customer rescheduled (booking restored)' },
    });

    // Offer spots were released at cancel time — take them again.
    if (booking.appliedOfferId) {
      await tx.specialOffer.update({
        where: { id: booking.appliedOfferId },
        data: { spotsSold: { increment: travelerTotal(booking.travelers) } },
      });
    }

    return restored;
  });

  if (!updated) {
    throw new AppError('This booking has already been resolved', 400);
  }

  const previousDateLabel = new Date(booking.travelDate).toISOString().slice(0, 10);
  const newDateLabel = dateKeyOf(target);

  enqueueEmail({
    type: 'supplier-changed-booking',
    bookingId: booking.id,
    data: {
      changes: [{ label: 'Date', previous: previousDateLabel, updated: newDateLabel }],
      changeReason: 'Your booking was re-confirmed on a new date after the supplier cancellation.',
    },
  }).catch((err) => console.error('[Cancellation] reschedule customer email failed:', err.message));

  enqueueEmail({
    type: 'supplier-booking-changed',
    bookingId: booking.id,
    data: {
      changes: [{ label: 'Date', previous: previousDateLabel, updated: newDateLabel }],
      changeReason: 'Customer chose a new date for a supplier-cancelled booking.',
    },
  }).catch((err) => console.error('[Cancellation] reschedule supplier email failed:', err.message));

  enqueueNotification({
    userId: booking.customerId,
    type: 'BOOKING_MODIFIED',
    title: 'Booking re-confirmed',
    message: `Your booking for "${tour.title}" is confirmed again on ${newDateLabel}.`,
    data: { bookingId: booking.id, travelDate: newDateLabel },
  }).catch(() => {});

  enqueueNotification({
    userId: tour.supplierId,
    type: 'BOOKING_MODIFIED',
    title: 'Customer chose a new date',
    message: `Booking ${booking.bookingNumber} was re-confirmed on ${newDateLabel} after your cancellation.`,
    data: { bookingId: booking.id, travelDate: newDateLabel },
  }).catch(() => {});

  enqueueEvent({
    name: 'booking.modified',
    userId: booking.customerId,
    resource: 'Booking',
    resourceId: booking.id,
    properties: { reason: 'cancellation-choice-reschedule', previousDate: previousDateLabel, travelDate: newDateLabel },
  }).catch(() => {});

  return { booking: updated, newDate: newDateLabel };
}

/**
 * Resolve a customer choice submitted from the emailed signed link.
 * No login required — the HMAC token carries booking + deadline.
 */
async function applyCustomerChoice({ token, choice, newTravelDate }) {
  const { verifyChoiceToken } = require('./cancellationReasons');
  const parsed = verifyChoiceToken(token);
  if (!parsed) throw new AppError('This link is invalid or has expired', 400);

  const booking = await prisma.booking.findUnique({
    where: { id: parsed.bookingId },
    include: { tour: { select: { id: true, title: true, supplierId: true } } },
  });
  if (!booking || booking.status !== 'CANCELLED' || booking.cancellationOrigin !== ORIGINS.SUPPLIER) {
    throw new AppError('This booking is not awaiting a cancellation decision', 400);
  }
  if (booking.refundStatus === REFUND_STATES.SUCCEEDED) {
    throw new AppError('This booking has already been refunded', 400);
  }
  if (booking.customerChoice && booking.customerChoice !== choice) {
    throw new AppError('You have already made a choice for this booking', 400);
  }

  if (choice === 'REFUND') {
    // Nothing to move (never paid / zero refund): record the choice, done.
    if (booking.refundStatus === REFUND_STATES.NOT_APPLICABLE || booking.paymentStatus !== 'SUCCEEDED') {
      await prisma.booking.updateMany({
        where: { id: booking.id, customerChoice: null },
        data: { customerChoice: 'REFUND', customerChoiceAt: new Date() },
      });
      return { outcome: 'REFUNDED', refunded: false, nothingToRefund: true };
    }

    await prisma.booking.updateMany({
      where: { id: booking.id, customerChoice: null },
      data: { customerChoice: 'REFUND', customerChoiceAt: new Date() },
    });
    const refund = await executeRefund(booking.id);
    if (!refund.claimed) {
      // Someone (the sweep) already ran it — report from current state.
      const fresh = await prisma.booking.findUnique({ where: { id: booking.id }, select: { refundStatus: true } });
      return {
        outcome: 'REFUNDED',
        refunded: fresh?.refundStatus === REFUND_STATES.SUCCEEDED,
        refundFailed: fresh?.refundStatus === REFUND_STATES.FAILED,
      };
    }
    return {
      outcome: 'REFUNDED',
      refunded: refund.succeeded === true,
      refundFailed: refund.succeeded === false,
    };
  }

  if (choice === 'RESCHEDULE') {
    const result = await resolveChoiceReschedule(booking, newTravelDate);
    return { outcome: 'RESCHEDULED', booking: result.booking, newDate: result.newDate };
  }

  throw new AppError('Choice must be REFUND or RESCHEDULE', 400);
}

/**
 * Sweep (every 5 min): close out the choice windows and retry planned refunds.
 *  - window expired, no answer     → default to a full refund (GYG's rule)
 *  - customer chose REFUND, refund still PENDING → execute it
 *  - refund stuck PROCESSING > 24h → alert admin (money-safe: no auto-retry)
 */
async function resolveCancellationChoices() {
  const now = new Date();
  let autoRefunded = 0;
  let refundsExecuted = 0;
  let alerted = 0;

  // 1) Expired windows with no answer → auto-refund.
  const expired = await prisma.booking.findMany({
    where: {
      status: 'CANCELLED',
      cancellationOrigin: ORIGINS.SUPPLIER,
      customerChoice: null,
      cancellationChoiceDeadline: { lt: now },
      refundStatus: { in: [REFUND_STATES.PENDING, REFUND_STATES.PROCESSING] },
    },
    select: { id: true, refundStatus: true },
    take: 100,
  });

  for (const row of expired) {
    await prisma.booking.updateMany({
      where: { id: row.id, customerChoice: null },
      data: { customerChoice: 'REFUND', customerChoiceAt: now },
    });
    const res = await executeRefund(row.id);
    if (res.claimed && res.succeeded) autoRefunded += 1;
  }

  // Windows that expired with nothing to refund still need closing out.
  await prisma.booking.updateMany({
    where: {
      status: 'CANCELLED',
      cancellationOrigin: ORIGINS.SUPPLIER,
      customerChoice: null,
      cancellationChoiceDeadline: { lt: now },
      refundStatus: REFUND_STATES.NOT_APPLICABLE,
    },
    data: { customerChoice: 'REFUND', customerChoiceAt: now },
  });

  // 2) Explicit refund choices whose payment hasn't gone back yet.
  const chosenRefunds = await prisma.booking.findMany({
    where: {
      status: 'CANCELLED',
      customerChoice: 'REFUND',
      refundStatus: REFUND_STATES.PENDING,
    },
    select: { id: true },
    take: 100,
  });
  for (const row of chosenRefunds) {
    const res = await executeRefund(row.id);
    if (res.claimed && res.succeeded) refundsExecuted += 1;
  }

  // 3) Refunds stuck in PROCESSING past the idempotency window → human eyes.
  const stuck = await prisma.booking.findMany({
    where: {
      refundStatus: REFUND_STATES.PROCESSING,
      updatedAt: { lt: new Date(Date.now() - REFUND_STUCK_MS) },
    },
    select: { id: true, bookingNumber: true },
    take: 20,
  });
  for (const row of stuck) {
    const alreadyAlerted = await prisma.adminNotification.findFirst({
      where: { type: 'REFUND_NEEDS_ATTENTION', data: { path: ['bookingId'], equals: row.id } },
      select: { id: true },
    });
    if (alreadyAlerted) continue;
    notifyAdmin({
      type: 'REFUND_NEEDS_ATTENTION',
      title: 'Refund stuck in PROCESSING',
      message: `Refund for booking ${row.bookingNumber} has been in PROCESSING for 24h+ — verify in Stripe and resolve manually.`,
      data: { bookingId: row.id },
    }).catch(() => {});
    alerted += 1;
  }

  if (autoRefunded || refundsExecuted || alerted) {
    console.log(
      `[CancellationChoice] sweep → ${autoRefunded} auto-refunded (expired), ${refundsExecuted} refunded (chosen), ${alerted} stuck refunds alerted`
    );
  }
  return { autoRefunded, refundsExecuted, alerted };
}

/**
 * Bulk cancellation (GYG's Cancellation Management wizard). Cancels every
 * matching booking with the same structured reason and optionally blocks the
 * dates so nobody can keep selling them.
 *
 * @returns {{ matched, cancelled, failed, totalRefunded, totalFees, results, blockedDates }}
 */
/**
 * Shared front-half of the bulk cancellation: validate the wizard payload,
 * resolve the supplier's tour, and fetch the bookings matching the range.
 * Used by both this executor and the admin-approval gate
 * (cancellationRequestService) so the two can never disagree about WHICH
 * bookings are affected.
 */
async function matchPreview({ supplierId, payload, filters }) {
  const validation = validateCancellationPayload(payload);
  if (!validation.ok) throw new AppError(validation.errors.join('; '), 400);

  const { tourId, dateFrom, dateTo, selectedTime } = filters || {};
  if (!tourId) throw new AppError('tourId is required', 400);
  if (!dateFrom || !dateTo) throw new AppError('dateFrom and dateTo are required', 400);

  const start = new Date(dateFrom);
  const end = new Date(dateTo);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError('Invalid date range', 400);
  }
  if (end < start) throw new AppError('dateTo must be after dateFrom', 400);

  // The tour must belong to this supplier (single-tour scope keeps the blast
  // radius small — one product, one date range, like GYG's wizard).
  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId },
    include: { supplier: true },
  });
  if (!tour) throw new AppError('Tour not found or access denied', 404);

  const endOfEnd = new Date(end);
  endOfEnd.setHours(23, 59, 59, 999);

  const where = {
    tourId: tour.id,
    status: { in: ['PENDING', 'CONFIRMED'] },
    travelDate: { gte: start, lte: endOfEnd },
  };
  if (selectedTime) where.selectedTime = selectedTime;

  const rows = await prisma.booking.findMany({
    where,
    include: { tour: { include: { supplier: true } } },
    orderBy: { travelDate: 'asc' },
    take: BATCH_MAX + 1,
  });

  return {
    validation,
    tour,
    start,
    end,
    matched: rows.slice(0, BATCH_MAX),
    overflow: rows.length > BATCH_MAX,
  };
}

async function cancelBatchBySupplier({ supplierId, payload, filters, req }) {
  const { validation, tour, start, end, matched, overflow } = await matchPreview({ supplierId, payload, filters });
  const batch = matched;

  const results = [];
  let totalRefunded = 0;
  let totalFees = 0;

  for (const booking of batch) {
    try {
      const outcome = await cancelBySupplier({
        booking,
        payload: validation.normalized,
        supplierId,
        req,
        skipValidation: true,
      });
      results.push({ bookingId: booking.id, bookingNumber: booking.bookingNumber, ok: true, refundAmount: outcome.refundAmount, fee: outcome.fee });
      totalRefunded += outcome.refundAmount;
      totalFees += outcome.fee;
    } catch (err) {
      results.push({ bookingId: booking.id, bookingNumber: booking.bookingNumber, ok: false, error: err.message });
    }
  }

  // ── "Stop accepting bookings?" → block the dates ──
  const blockedDates = [];
  if (filters.stopAcceptingBookings) {
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = dateKeyOf(cursor);
      const dayStart = new Date(`${key}T00:00:00.000Z`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (dayStart >= today) {
        await prisma.tourDateOverride.upsert({
          where: { tourId_date: { tourId: tour.id, date: dayStart } },
          create: {
            tourId: tour.id,
            date: dayStart,
            status: 'BLOCKED',
            notes: `Blocked by bulk cancellation on ${new Date().toISOString().slice(0, 10)}`,
          },
          update: { status: 'BLOCKED', notes: `Blocked by bulk cancellation on ${new Date().toISOString().slice(0, 10)}` },
        }).catch((err) => console.error('[CancellationBatch] block date failed for', key, err.message));
        blockedDates.push(key);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  logActivity({
    userId: supplierId,
    action: 'booking.bulk_cancelled',
    resource: 'Tour',
    resourceId: tour.id,
    metadata: {
      matched: batch.length,
      cancelled: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      totalRefunded,
      totalFees,
      blockedDates,
      range: { dateFrom: dateKeyOf(start), dateTo: dateKeyOf(end) },
    },
  }).catch(() => {});

  return {
    matched: batch.length,
    overflow,
    cancelled: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    totalRefunded: Math.round(totalRefunded * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    blockedDates,
    results,
  };
}

module.exports = {
  CHOICE_WINDOW_HOURS,
  BATCH_MAX,
  plannedRefund,
  executeRefund,
  cancelBySupplier,
  applyCustomerChoice,
  resolveChoiceReschedule,
  resolveCancellationChoices,
  cancelBatchBySupplier,
  matchPreview,
};
