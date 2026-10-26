/**
 * Shared pay-later payment-link service.
 *
 * One implementation for every hosted Stripe Checkout attempt:
 *   - customer "Pay now" on the storefront
 *   - supplier "Send payment link" from the Ghana dashboard
 *   - automatic recovery after a failed deferred charge
 *
 * Invariants:
 *   - At most one CREATING/ACTIVE attempt per booking. The partial unique index
 *     in the migration is the final authority; this service also locks the
 *     booking row before creating one.
 *   - A hosted session pauses the pay-later sweep through `paymentLinkHoldAt`
 *     (never by overloading `requiresPaymentActionAt`).
 *   - Only the Stripe webhook settles a booking. Nothing here writes
 *     paymentStatus = SUCCEEDED or status = CONFIRMED.
 *   - Stripe identifiers and the hosted URL never leave the server in a
 *     supplier-facing response.
 *   - Session expiry is min(now + 24h, activityStart - 2h), and a link is never
 *     issued when less than 30 minutes of Stripe session life remain.
 */

const prisma = require('./prismaClient');
const getConfig = require('./getConfig');
const AppError = require('./appError');
const { createCheckoutSession, getStripe } = require('./stripeHelpers');
const { activityStartExactUtc, parseBlob } = require('./availabilityCore');
const { enqueueEmail } = require('./queue');
const emailUrls = require('../../../config/emailUrls');
const logger = require('./logger');

// Payment links stop 2 hours before the activity by default. Ops can tighten
// or widen the window without a code change; invalid or non-positive values
// fall back to the safe default.
const DEFAULT_CUTOFF_HOURS = 2;
const CUTOFF_HOURS = (() => {
  const configured = Number(process.env.PAY_LATER_PAYMENT_LINK_CUTOFF_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CUTOFF_HOURS;
})();
const HOLD_MS = CUTOFF_HOURS * 60 * 60 * 1000;
const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
const SESSION_MIN_MS = 30 * 60 * 1000;
const CREATING_STALE_MS = 2 * 60 * 1000;

const ACTIVE_STATUSES = ['CREATING', 'ACTIVE'];
const RESERVED_STATUSES = ['PENDING', 'CONFIRMED'];
const TERMINAL_STATUSES = ['CANCELLED', 'COMPLETED', 'NO_SHOW', 'REFUNDED'];

const SOURCE = {
  CUSTOMER_PAY_NOW: 'CUSTOMER_PAY_NOW',
  SUPPLIER_LINK: 'SUPPLIER_LINK',
  AUTO_RECOVERY: 'AUTO_RECOVERY',
};

const MODE = {
  CREATE: 'create',
  RESEND: 'resend',
  REGENERATE: 'regenerate',
};

// Keys shared with the admin settings controller, which validates writes.
const FLAGS = require('../config/paymentLinkFlags');

function asBool(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

async function flagEnabled(key) {
  return asBool(await getConfig(key, 'false'));
}

async function assertFlagForSource(source) {
  if (!(await flagEnabled(FLAGS.base))) {
    throw new AppError('Payment links are not enabled.', 404, {
      code: 'FEATURE_DISABLED',
      reasonCode: 'PAYMENT_LINKS_DISABLED',
    });
  }
  if (source === SOURCE.SUPPLIER_LINK && !(await flagEnabled(FLAGS.supplier))) {
    throw new AppError('Supplier payment links are not enabled.', 404, {
      code: 'FEATURE_DISABLED',
      reasonCode: 'SUPPLIER_PAYMENT_LINKS_DISABLED',
    });
  }
  if (source === SOURCE.AUTO_RECOVERY && !(await flagEnabled(FLAGS.recovery))) {
    throw new AppError('Automatic payment recovery is not enabled.', 404, {
      code: 'FEATURE_DISABLED',
      reasonCode: 'PAYMENT_RECOVERY_DISABLED',
    });
  }
}

function activityStartFor(booking) {
  const tickets = parseBlob(booking?.tour?.bookingAndTickets) || {};
  return activityStartExactUtc(tickets, booking?.travelDate, booking?.selectedTime);
}

function paymentLinkDeadlineFor(booking) {
  const start = activityStartFor(booking);
  if (!start || Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() - HOLD_MS);
}

function customerEmailFor(booking) {
  return booking?.customer?.email || booking?.guest?.email || booking?.leadTravelerEmail || null;
}

/**
 * Why a booking may or may not receive a hosted payment link. Reads only
 * persisted facts: no inference from a bare PENDING paymentStatus.
 */
function assessEligibility(booking, { now = new Date() } = {}) {
  const deadlineAt = paymentLinkDeadlineFor(booking);
  const activityStart = activityStartFor(booking);
  const email = customerEmailFor(booking);

  const fail = (code, reasonCode, message, extra = {}) => ({
    eligible: false,
    code,
    reasonCode,
    message,
    deadlineAt,
    activityStart,
    ...extra,
  });

  if (!booking) {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'BOOKING_NOT_FOUND', 'Booking not found.');
  }
  if (booking.paymentTiming !== 'later') {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'NOT_PAY_LATER', 'This booking is not reserved with pay later.');
  }
  if (booking.origin && booking.origin !== 'MARKETPLACE') {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'NOT_MARKETPLACE_BOOKING', 'Payment links are only available for marketplace bookings.');
  }
  if (TERMINAL_STATUSES.includes(booking.status)) {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'BOOKING_TERMINAL', 'This booking is no longer active.');
  }
  if (!RESERVED_STATUSES.includes(booking.status)) {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'BOOKING_NOT_RESERVED', 'This booking is not reserved.');
  }
  if (booking.paymentStatus === 'SUCCEEDED' || booking.paymentStatus === 'REFUNDED') {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'PAYMENT_ALREADY_SETTLED', 'This booking is already paid.');
  }
  if (booking.paymentStatus !== 'PENDING') {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'PAYMENT_IN_PROGRESS', 'A payment is already being processed for this booking.');
  }
  if (!activityStart || Number.isNaN(activityStart.getTime())) {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'ACTIVITY_START_UNKNOWN', 'The activity start time could not be determined.');
  }
  if (now.getTime() >= activityStart.getTime()) {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'ACTIVITY_STARTED', 'The activity has already started.');
  }
  if (!deadlineAt || now.getTime() >= deadlineAt.getTime()) {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'PAYMENT_LINK_WINDOW_CLOSED', 'The secure payment window for this booking has closed.');
  }
  if (!email) {
    return fail('PAYMENT_LINK_NOT_ELIGIBLE', 'CUSTOMER_EMAIL_MISSING', 'There is no customer email address for this booking.');
  }

  return {
    eligible: true,
    code: 'PAYMENT_LINK_ELIGIBLE',
    reasonCode: null,
    message: null,
    deadlineAt,
    activityStart,
    customerEmail: email,
    sessionExpiresAt: computeSessionExpiry(now, deadlineAt),
  };
}

function computeSessionExpiry(now, deadlineAt) {
  return new Date(Math.min(now.getTime() + SESSION_MAX_MS, deadlineAt.getTime()));
}

function assertSessionWindow(expiresAt, now = new Date()) {
  if (!expiresAt || expiresAt.getTime() - now.getTime() < SESSION_MIN_MS) {
    throw new AppError(
      'The secure payment window is too close to the activity start to create a link. Contact support.',
      409,
      {
        code: 'PAYMENT_LINK_WINDOW_CLOSED',
        reasonCode: 'TOO_CLOSE_TO_ACTIVITY',
        details: { minimumMinutes: 30 },
      },
    );
  }
}

async function loadBookingForPayment(bookingId) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: { select: { id: true, name: true, email: true, stripeCustomerId: true } },
      guest: { select: { id: true, name: true, email: true } },
      tour: {
        select: {
          id: true,
          title: true,
          description: true,
          coverPhoto: true,
          photos: true,
          supplierId: true,
          bookingAndTickets: true,
        },
      },
    },
  });
}

function clientOriginFor(booking) {
  return emailUrls.bookingClientOrigin(booking) || process.env.CLIENT_URL || 'https://travioghana.com';
}

function successPathFor(booking) {
  const dashboard = ['EXPEDITION', 'GHANA'].includes(booking.source);
  if (dashboard) {
    return `/dashboard/bookings?booking=${encodeURIComponent(booking.id)}&paid=1`;
  }
  return `/booking/${encodeURIComponent(booking.id)}?paid=1`;
}

function cancelPathFor(booking) {
  const dashboard = ['EXPEDITION', 'GHANA'].includes(booking.source);
  if (dashboard) {
    return `/dashboard/bookings?booking=${encodeURIComponent(booking.id)}`;
  }
  return `/booking/${encodeURIComponent(booking.id)}`;
}

async function findLiveAttempt(bookingId) {
  return prisma.bookingPaymentAttempt.findFirst({
    where: { bookingId, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });
}

async function clearBookingHoldIfCurrent(bookingId, attempt) {
  if (!attempt) return;
  // A stale CREATING row must not clear the hold owned by a newer live attempt.
  if (!attempt.stripeCheckoutSessionId) {
    const other = await prisma.bookingPaymentAttempt.findFirst({
      where: {
        bookingId,
        status: { in: ACTIVE_STATUSES },
        id: { not: attempt.id },
      },
      select: { id: true },
    }).catch(() => null);
    if (other) return;
  }
  const where = {
    id: bookingId,
    paymentLinkHoldAt: { not: null },
  };
  if (attempt.stripeCheckoutSessionId) {
    where.stripeCheckoutSessionId = attempt.stripeCheckoutSessionId;
  }
  await prisma.booking.updateMany({
    where,
    data: { paymentLinkHoldAt: null, stripeCheckoutSessionId: null },
  }).catch(() => {});
}

async function markAttemptExpired(attempt, { reason = 'SESSION_EXPIRED' } = {}) {
  if (!attempt) return false;
  const updated = await prisma.bookingPaymentAttempt.updateMany({
    where: { id: attempt.id, status: { in: ACTIVE_STATUSES } },
    data: {
      status: 'EXPIRED',
      expiredAt: new Date(),
      failureCode: reason,
    },
  });
  if (updated.count === 0) return false;
  await clearBookingHoldIfCurrent(attempt.bookingId, attempt);
  return true;
}

async function failCreatingAttempt(attempt, code, reason) {
  if (!attempt) return;
  await prisma.bookingPaymentAttempt.updateMany({
    where: { id: attempt.id, status: 'CREATING' },
    data: {
      status: 'FAILED',
      failureCode: code,
      failureReason: reason ? String(reason).slice(0, 500) : null,
    },
  }).catch(() => {});
  await clearBookingHoldIfCurrent(attempt.bookingId, attempt);
}

async function markAttemptSuperseded(attempt) {
  if (!attempt) return;
  // Deliberately keep the booking hold. The replacement attempt is created
  // immediately after this so the sweep cannot slip in and charge the original
  // PaymentIntent between expiring the old session and activating the new one.
  await prisma.bookingPaymentAttempt.updateMany({
    where: { id: attempt.id, status: { in: ACTIVE_STATUSES } },
    data: { status: 'SUPERSEDED', expiredAt: new Date() },
  });
}

async function expireProviderSession(sessionId) {
  if (!sessionId) return;
  try {
    await getStripe().checkout.sessions.expire(sessionId);
  } catch (err) {
    const message = String(err?.message || '');
    // An already expired (or missing) session has nothing left to revoke.
    // A COMPLETED session is different: money may already be in flight, so
    // rotating it would risk a second charge. Refuse and let the webhook land.
    if (/already completed|checkout_session_completed/i.test(message)) {
      throw new AppError('This secure link has already been completed. Refresh the booking to see the payment status.', 409, {
        code: 'PAYMENT_LINK_ALREADY_COMPLETED',
        reasonCode: 'PAYMENT_COMPLETION_IN_PROGRESS',
      });
    }
    if (/already expired|resource_missing|No such checkout/i.test(message)) return;
    throw err;
  }
}

async function rotateLiveAttempt(attempt) {
  if (!attempt) return;
  if (attempt.status === 'CREATING') {
    throw new AppError('A secure payment link is still being created. Please try again in a moment.', 409, {
      code: 'PAYMENT_LINK_CREATING',
      reasonCode: 'ATTEMPT_IN_PROGRESS',
    });
  }
  if (attempt.status === 'ACTIVE') {
    try {
      await expireProviderSession(attempt.stripeCheckoutSessionId);
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error(`[PaymentLink] Could not expire session for attempt ${attempt.id}: ${err.message}`);
      throw new AppError('We could not replace the current secure link. Please try again.', 502, {
        code: 'PAYMENT_LINK_PROVIDER_ERROR',
        reasonCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });
    }
  }
  await markAttemptSuperseded(attempt);
}

async function createAttemptRecord(booking, { source, actor, expiresAt, sendInChat }) {
  const now = new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      // Row lock: concurrent supplier/customer/auto-recovery requests serialize
      // before they read the live-attempt set.
      if (typeof tx.$queryRaw === 'function') {
        await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${booking.id} FOR UPDATE`;
      }
      const live = await tx.bookingPaymentAttempt.findFirst({
        where: { bookingId: booking.id, status: { in: ACTIVE_STATUSES } },
        orderBy: { createdAt: 'desc' },
      });
      if (live) return { attempt: live, reused: true };

      const attempt = await tx.bookingPaymentAttempt.create({
        data: {
          bookingId: booking.id,
          source,
          status: 'CREATING',
          amount: booking.grossAmount,
          currency: booking.currency || 'USD',
          expiresAt,
          createdByUserId: actor?.id || null,
          createdByRole: actor?.role || null,
          sendInChat: Boolean(sendInChat),
        },
      });

      const bookingData = { paymentLinkHoldAt: now };
      if (source === SOURCE.SUPPLIER_LINK) {
        // A supplier has taken over delivery for this episode. Recovery must
        // never race them with an automatic replacement.
        bookingData.recoveryClosedAt = now;
        bookingData.recoveryClosedReason = 'SUPPLIER_INTERVENTION';
      } else if (source === SOURCE.AUTO_RECOVERY) {
        if (!booking.recoveryEpisodeStartedAt || booking.recoveryClosedAt) {
          bookingData.recoveryEpisodeKey = `${booking.id}:${now.getTime()}`;
          bookingData.recoveryEpisodeStartedAt = now;
          bookingData.recoveryEmailCount = 0;
          bookingData.recoveryLastSentAt = null;
          bookingData.recoveryClosedAt = null;
          bookingData.recoveryClosedReason = null;
        }
      }

      await tx.booking.update({ where: { id: booking.id }, data: bookingData });
      return { attempt, reused: false };
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      const live = await findLiveAttempt(booking.id);
      if (live) return { attempt: live, reused: true };
    }
    throw err;
  }
}

async function createProviderSession(booking, attempt) {
  const tour = booking.tour || {};
  const amount = Math.round(Number(booking.grossAmount) * 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError('Could not determine the amount due for this booking.', 409, {
      code: 'PAYMENT_LINK_AMOUNT_UNAVAILABLE',
      reasonCode: 'INVALID_BOOKING_TOTAL',
    });
  }

  const session = await createCheckoutSession({
    amount,
    currency: booking.currency || 'USD',
    bookingId: booking.id,
    tourTitle: tour.title,
    tourDescription: tour.description || null,
    tourCoverPhoto: tour.coverPhoto || (Array.isArray(tour.photos) ? tour.photos[0] : null) || null,
    customerId: booking.customer?.stripeCustomerId || undefined,
    customerEmail: customerEmailFor(booking),
    expiresAt: attempt.expiresAt,
    successPath: successPathFor(booking),
    cancelPath: cancelPathFor(booking),
    clientUrl: clientOriginFor(booking),
    source: booking.source === 'EXPEDITION' ? 'expedition' : 'ghana',
    idempotencyKey: `paylater-checkout-attempt:${attempt.id}`,
    metadata: {
      paymentAttemptId: attempt.id,
      paymentAttemptSource: attempt.source,
      paymentTiming: 'later',
      bookingIds: booking.id,
    },
  });

  if (!session?.id || !session?.url) {
    throw new Error('Stripe returned a Checkout Session without an id/url');
  }
  return session;
}

async function activateAttempt(booking, attempt, session) {
  const expiresAt = session.expires_at
    ? new Date(session.expires_at * 1000)
    : attempt.expiresAt;
  const updated = await prisma.bookingPaymentAttempt.updateMany({
    where: { id: attempt.id, status: 'CREATING' },
    data: {
      status: 'ACTIVE',
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || null,
      checkoutUrl: session.url,
      expiresAt,
    },
  });
  if (updated.count === 0) {
    // A concurrent rotation superseded this row while Stripe was creating the
    // session. Revoke it rather than leave a payable orphan.
    await expireProviderSession(session.id).catch(() => {});
    throw new AppError('A newer payment link replaced this one. Please refresh and try again.', 409, {
      code: 'PAYMENT_LINK_SUPERSEDED',
      reasonCode: 'ATTEMPT_SUPERSEDED',
    });
  }
  const held = await prisma.booking.updateMany({
    where: {
      id: booking.id,
      paymentStatus: 'PENDING',
      status: { in: RESERVED_STATUSES },
    },
    data: {
      paymentLinkHoldAt: new Date(),
      stripeCheckoutSessionId: session.id,
    },
  });
  if (held.count === 0) {
    // The booking was settled or terminalized while Stripe was creating the
    // session. Never leave a payable orphan behind, and never claim a hold on a
    // booking that no longer needs this link.
    await prisma.bookingPaymentAttempt.updateMany({
      where: { id: attempt.id, status: 'ACTIVE' },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        failureCode: 'BOOKING_STATE_CHANGED',
      },
    }).catch(() => {});
    await expireProviderSession(session.id).catch(() => {});
    throw new AppError('The booking changed while the link was being created. Refresh and try again.', 409, {
      code: 'PAYMENT_LINK_NOT_ELIGIBLE',
      reasonCode: 'BOOKING_STATE_CHANGED',
    });
  }
  return prisma.bookingPaymentAttempt.findUnique({ where: { id: attempt.id } });
}

/**
 * Create or reuse a live hosted attempt.
 *
 * @param {object} params
 * @param {string} params.bookingId
 * @param {string} params.source - CUSTOMER_PAY_NOW | SUPPLIER_LINK | AUTO_RECOVERY
 * @param {string} [params.mode] - create | resend | regenerate
 * @param {object} [params.actor] - { id, role }
 * @param {boolean} [params.sendInChat]
 */
async function ensurePaymentAttempt({
  bookingId,
  source,
  mode = MODE.CREATE,
  actor = null,
  sendInChat = false,
}) {
  await assertFlagForSource(source);

  const booking = await loadBookingForPayment(bookingId);
  if (!booking) {
    throw new AppError('Booking not found.', 404, {
      code: 'BOOKING_NOT_FOUND',
      reasonCode: 'BOOKING_NOT_FOUND',
    });
  }

  const now = new Date();
  const eligibility = assessEligibility(booking, { now });
  if (!eligibility.eligible) {
    // Resend may reuse a live session that was issued just before the cutoff,
    // because Stripe still owns that session. It must never bypass a terminal
    // booking, a settled payment, a started activity, or a missing email: those
    // are safety facts, not timing convenience.
    const resendWindowOnly = mode === MODE.RESEND
      && eligibility.reasonCode === 'PAYMENT_LINK_WINDOW_CLOSED';
    if (!resendWindowOnly) {
      throw new AppError(eligibility.message, 409, {
        code: eligibility.code,
        reasonCode: eligibility.reasonCode,
        details: eligibility.deadlineAt ? { deadlineAt: eligibility.deadlineAt.toISOString() } : undefined,
      });
    }
  }

  let live = await findLiveAttempt(booking.id);

  if (mode === MODE.REGENERATE) {
    // Regenerate means "replace the live link the supplier is looking at".
    // Creating a fresh link when none is live would hide a stale UI click and
    // could bypass the distinction between SEND and REGENERATE.
    if (!live || live.status !== 'ACTIVE') {
      throw new AppError('There is no active payment link to replace. Send a new link instead.', 409, {
        code: 'PAYMENT_LINK_NOT_ACTIVE',
        reasonCode: 'NO_ACTIVE_ATTEMPT',
      });
    }
    if (new Date(live.expiresAt).getTime() <= now.getTime()) {
      await markAttemptExpired(live, { reason: 'REGENERATE_AFTER_EXPIRY' });
      throw new AppError('The previous payment link has expired. Send a new link instead.', 409, {
        code: 'PAYMENT_LINK_EXPIRED',
        reasonCode: 'ATTEMPT_EXPIRED',
        details: { action: 'send' },
      });
    }
  }

  if (mode === MODE.RESEND) {
    if (!live || live.status !== 'ACTIVE') {
      throw new AppError('There is no active payment link to resend. Generate a new link instead.', 409, {
        code: 'PAYMENT_LINK_NOT_ACTIVE',
        reasonCode: 'NO_ACTIVE_ATTEMPT',
      });
    }
    if (new Date(live.expiresAt).getTime() <= now.getTime()) {
      await markAttemptExpired(live, { reason: 'RESEND_AFTER_EXPIRY' });
      throw new AppError('The previous payment link has expired. Generate a new link instead.', 409, {
        code: 'PAYMENT_LINK_EXPIRED',
        reasonCode: 'ATTEMPT_EXPIRED',
        details: { action: 'regenerate' },
      });
    }
    return { booking, attempt: live, eligibility, reused: true };
  }

  if (live?.status === 'CREATING') {
    const age = now.getTime() - new Date(live.createdAt).getTime();
    if (age < CREATING_STALE_MS) {
      throw new AppError('A secure payment link is still being created. Please try again in a moment.', 409, {
        code: 'PAYMENT_LINK_CREATING',
        reasonCode: 'ATTEMPT_IN_PROGRESS',
      });
    }
    await failCreatingAttempt(live, 'CREATION_TIMEOUT', 'Attempt did not finish creating');
    live = null;
  }

  let rotatedFrom = null;
  if (live?.status === 'ACTIVE') {
    if (new Date(live.expiresAt).getTime() <= now.getTime()) {
      await markAttemptExpired(live, { reason: 'SESSION_EXPIRED' });
      live = null;
    } else if (mode === MODE.REGENERATE) {
      rotatedFrom = live;
      await rotateLiveAttempt(live);
      live = null;
    } else {
      // Recovery may reuse a session that the customer started from Pay now.
      // The episode still has to exist so the two-email cap is enforceable.
      if (source === SOURCE.AUTO_RECOVERY && !booking.recoveryEpisodeStartedAt) {
        await prisma.booking.updateMany({
          where: { id: booking.id, recoveryClosedAt: null },
          data: {
            recoveryEpisodeKey: `${booking.id}:${now.getTime()}`,
            recoveryEpisodeStartedAt: now,
            recoveryEmailCount: 0,
            recoveryLastSentAt: null,
          },
        });
      }
      return { booking, attempt: live, eligibility, reused: true };
    }
  }

  if (!eligibility.eligible) {
    throw new AppError(eligibility.message, 409, {
      code: eligibility.code,
      reasonCode: eligibility.reasonCode,
      details: eligibility.deadlineAt ? { deadlineAt: eligibility.deadlineAt.toISOString() } : undefined,
    });
  }
  assertSessionWindow(eligibility.sessionExpiresAt, now);

  let created;
  try {
    created = await createAttemptRecord(booking, {
      source,
      actor,
      expiresAt: eligibility.sessionExpiresAt,
      sendInChat,
    });
  } catch (err) {
    // The rotated session was already revoked, but no replacement row exists.
    // Release only the hold owned by that superseded attempt; never touch a
    // newer session that won a race.
    if (rotatedFrom) {
      await clearBookingHoldIfCurrent(booking.id, rotatedFrom);
    }
    throw err;
  }
  if (created.reused) {
    return { booking, attempt: created.attempt, eligibility, reused: true };
  }

  let session = null;
  try {
    session = await createProviderSession(booking, created.attempt);
    const attempt = await activateAttempt(booking, created.attempt, session);
    return { booking, attempt, eligibility, reused: false };
  } catch (err) {
    // If Stripe created a session but persisting it failed, revoke it so no
    // payable URL can outlive the failed attempt.
    if (session?.id) {
      await expireProviderSession(session.id).catch(() => {});
    }
    await failCreatingAttempt(
      created.attempt,
      err?.code === 'P2002' ? 'ACTIVE_ATTEMPT_RACE' : 'PROVIDER_ERROR',
      err?.message,
    );
    if (err instanceof AppError) throw err;
    logger.error(`[PaymentLink] Could not create hosted session for booking ${booking.id}: ${err.message}`);
    throw new AppError('We could not create a secure payment link. Please try again.', 502, {
      code: 'PAYMENT_LINK_PROVIDER_ERROR',
      reasonCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
    });
  }
}

async function createSendRecord(booking, attempt, {
  channel,
  recipient,
  actor = null,
  idempotencyKey = null,
}) {
  try {
    const send = await prisma.bookingPaymentLinkSend.create({
      data: {
        bookingId: booking.id,
        attemptId: attempt.id,
        channel,
        status: 'QUEUED',
        recipient: recipient || null,
        idempotencyKey: idempotencyKey || null,
        requestedByUserId: actor?.id || null,
        requestedByRole: actor?.role || null,
      },
    });
    return { send, created: true };
  } catch (err) {
    if (err?.code === 'P2002' && idempotencyKey) {
      const existing = await prisma.bookingPaymentLinkSend.findFirst({
        where: { bookingId: booking.id, channel, idempotencyKey },
      });
      if (existing) return { send: existing, created: false };
    }
    throw err;
  }
}

async function dispatchEmail(booking, attempt, send) {
  await enqueueEmail({
    type: 'payment-link',
    bookingId: booking.id,
    data: {
      paymentLinkSendId: send.id,
      paymentLinkAttemptId: attempt.id,
      amount: Number(attempt.amount),
      expiresAt: attempt.expiresAt,
    },
  });
}

async function dispatchChat(booking, attempt, send) {
  const enabled = await flagEnabled(FLAGS.chat);
  if (!enabled) {
    await prisma.bookingPaymentLinkSend.update({
      where: { id: send.id },
      data: {
        status: 'FAILED',
        failureCode: 'CHAT_DISABLED',
        errorMessage: 'Chat delivery is disabled by configuration',
      },
    }).catch(() => {});
    return { sent: false, code: 'CHAT_DISABLED' };
  }

  const chatService = require('./chatService');
  const origin = clientOriginFor(booking);
  const safeUrl = `${String(origin).replace(/\/$/, '')}/dashboard/bookings?booking=${encodeURIComponent(booking.id)}&pay=1`;
  const content = [
    'A secure payment link is ready for this booking.',
    `Open your booking to complete payment: ${safeUrl}`,
    'If you have already paid, no further action is needed.',
  ].join('\n');

  try {
    const conversation = await chatService.findOrCreateConversation(
      booking.tour.supplierId,
      booking.customerId,
      'SUPPLIER_CUSTOMER',
      {
        bookingId: booking.id,
        bookingNumber: booking.bookingNumber,
        tourTitle: booking.tour?.title || null,
      },
    );
    await chatService.sendMessage(
      conversation.id,
      booking.tour.supplierId,
      send.requestedByUserId || booking.tour.supplierId,
      content,
      null,
      { skipEmail: true },
    );
    await prisma.bookingPaymentLinkSend.update({
      where: { id: send.id },
      data: { status: 'SENT', sentAt: new Date(), providerMessageId: conversation.id },
    }).catch(() => {});
    return { sent: true };
  } catch (err) {
    logger.warn(`[PaymentLink] Chat delivery failed for booking ${booking.id}: ${err.message}`);
    await prisma.bookingPaymentLinkSend.update({
      where: { id: send.id },
      data: {
        status: 'FAILED',
        failureCode: 'CHAT_DELIVERY_FAILED',
        errorMessage: String(err.message || err).slice(0, 500),
      },
    }).catch(() => {});
    return { sent: false, code: 'CHAT_DELIVERY_FAILED' };
  }
}

async function deliverPaymentLink(booking, attempt, {
  sendInChat = false,
  actor = null,
  idempotencyKey = null,
  automatic = false,
  reasonCode = null,
} = {}) {
  const email = customerEmailFor(booking);
  if (!email) {
    throw new AppError('There is no customer email address for this booking.', 409, {
      code: 'PAYMENT_LINK_NOT_ELIGIBLE',
      reasonCode: 'CUSTOMER_EMAIL_MISSING',
    });
  }

  if (automatic) {
    // Re-check the stop conditions immediately before the customer email. The
    // sweep loaded this candidate earlier; a settlement or supplier intervention
    // could have landed since. Never send a recovery email into a closed episode.
    const current = await prisma.booking.findUnique({
      where: { id: booking.id },
      select: { recoveryClosedAt: true, paymentStatus: true, status: true },
    });
    if (
      !current
      || current.recoveryClosedAt
      || current.paymentStatus !== 'PENDING'
      || TERMINAL_STATUSES.includes(current.status)
    ) {
      throw new AppError('Automatic payment recovery is no longer needed for this booking.', 409, {
        code: 'PAYMENT_RECOVERY_CLOSED',
        reasonCode: 'RECOVERY_CLOSED',
      });
    }
  }

  const emailRecord = await createSendRecord(booking, attempt, {
    channel: 'EMAIL',
    recipient: email,
    actor,
    idempotencyKey: idempotencyKey ? `${idempotencyKey}:email` : null,
  });
  const emailSend = emailRecord.send;

  // Only the request that CREATED the row may enqueue the email. A duplicate
  // request with the same Idempotency-Key must never send a second customer
  // email just because the first row is still QUEUED.
  const shouldDispatchEmail = emailRecord.created && emailSend.status === 'QUEUED';
  if (shouldDispatchEmail) {
    try {
      await dispatchEmail(booking, attempt, emailSend);
    } catch (err) {
      await prisma.bookingPaymentLinkSend.update({
        where: { id: emailSend.id },
        data: {
          status: 'FAILED',
          failureCode: 'EMAIL_ENQUEUE_FAILED',
          errorMessage: String(err.message || err).slice(0, 500),
        },
      }).catch(() => {});
      throw new AppError('The secure link could not be emailed. Please try again.', 502, {
        code: 'PAYMENT_LINK_EMAIL_FAILED',
        reasonCode: 'EMAIL_DISPATCH_FAILED',
      });
    }
  }

  let chatResult = null;
  if (sendInChat) {
    const chatRecord = await createSendRecord(booking, attempt, {
      channel: 'CHAT',
      recipient: booking.customerId || null,
      actor,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:chat` : null,
    });
    const chatSend = chatRecord.send;
    chatResult = chatRecord.created && chatSend.status === 'QUEUED'
      ? await dispatchChat(booking, attempt, chatSend)
      : { sent: chatSend.status === 'SENT' };
  }

  if (automatic && shouldDispatchEmail) {
    const updated = await prisma.booking.updateMany({
      where: {
        id: booking.id,
        recoveryEpisodeStartedAt: { not: null },
        recoveryClosedAt: null,
      },
      data: {
        recoveryEmailCount: { increment: 1 },
        recoveryLastSentAt: new Date(),
      },
    });
    if (updated.count === 0) {
      // Episode was closed by a concurrent settlement/intervention. The email
      // may still have been queued, but never claim recovery is active.
      logger.warn(`[PaymentLink] Recovery episode closed while sending for booking ${booking.id}`);
    }
  }

  return {
    attempt,
    emailSend,
    chatSend: chatResult,
    emailStatus: shouldDispatchEmail ? 'QUEUED' : emailSend.status,
    reasonCode,
  };
}

async function sendPaymentLink({
  bookingId,
  source = SOURCE.SUPPLIER_LINK,
  mode = MODE.CREATE,
  actor = null,
  sendInChat = false,
  idempotencyKey = null,
}) {
  const ensured = await ensurePaymentAttempt({
    bookingId,
    source,
    mode,
    actor,
    sendInChat,
  });

  // Recovery keys include the attempt id: a retry for the SAME session stays
  // idempotent, while a replacement session after expiry is a genuinely new
  // send and must not collide with the old send row.
  const effectiveKey = typeof idempotencyKey === 'function'
    ? idempotencyKey(ensured.attempt)
    : idempotencyKey;

  const delivered = await deliverPaymentLink(ensured.booking, ensured.attempt, {
    sendInChat,
    actor,
    idempotencyKey: effectiveKey,
    automatic: source === SOURCE.AUTO_RECOVERY,
  });
  if (source === SOURCE.SUPPLIER_LINK) {
    // A supplier taking over delivery ends automatic recovery for this
    // episode, including a resend of an auto-created live link. Otherwise the
    // sweep could send an automatic replacement after this link expires even
    // though the supplier is already handling the booking.
    await closeRecoveryEpisode(bookingId, 'SUPPLIER_INTERVENTION');
  }
  return { ...ensured, ...delivered, delivered: true };
}

async function resendPaymentLink({ bookingId, actor = null, sendInChat = false, idempotencyKey = null }) {
  return sendPaymentLink({
    bookingId,
    source: SOURCE.SUPPLIER_LINK,
    mode: MODE.RESEND,
    actor,
    sendInChat,
    idempotencyKey,
  });
}

async function regeneratePaymentLink({ bookingId, actor = null, sendInChat = false, idempotencyKey = null }) {
  return sendPaymentLink({
    bookingId,
    source: SOURCE.SUPPLIER_LINK,
    mode: MODE.REGENERATE,
    actor,
    sendInChat,
    idempotencyKey,
  });
}

/**
 * Automatic recovery: create/reuse a hosted attempt and send one email. The
 * caller owns episode limits and stop conditions.
 */
async function sendAutomaticRecoveryLink({ bookingId, reasonCode = null, idempotencyKey = null }) {
  return sendPaymentLink({
    bookingId,
    source: SOURCE.AUTO_RECOVERY,
    mode: MODE.CREATE,
    actor: { id: null, role: 'system' },
    sendInChat: false,
    idempotencyKey: typeof idempotencyKey === 'string'
      ? (attempt) => `${idempotencyKey}:${attempt.id}`
      : idempotencyKey,
  }).then(async (result) => {
    if (result.delivered) {
      // Count is incremented inside deliverPaymentLink only after the episode
      // still exists. Return the refreshed value for the caller's audit log.
      const refreshed = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { recoveryEmailCount: true, recoveryEpisodeKey: true },
      }).catch(() => null);
      return { ...result, reasonCode, recovery: refreshed };
    }
    return { ...result, reasonCode };
  });
}

async function expireCurrentAttemptForSession(sessionId) {
  if (!sessionId) return false;
  const attempt = await prisma.bookingPaymentAttempt.findFirst({
    where: { stripeCheckoutSessionId: sessionId, status: 'ACTIVE' },
  });
  if (!attempt) return false;
  return markAttemptExpired(attempt, { reason: 'PROVIDER_SESSION_EXPIRED' });
}

async function markAttemptSettledForSession(sessionId) {
  if (!sessionId) return false;
  const updated = await prisma.bookingPaymentAttempt.updateMany({
    where: { stripeCheckoutSessionId: sessionId, status: { in: ACTIVE_STATUSES } },
    data: { status: 'COMPLETED', settledAt: new Date(), requiresAction: false },
  });
  return updated.count > 0;
}

/**
 * payment_intent.succeeded can arrive before checkout.session.completed for a
 * hosted attempt. Mark by PaymentIntent as well so the attempt cannot be reaped
 * as "still active" after the money landed.
 */
async function markAttemptSettledByPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return false;
  const updated = await prisma.bookingPaymentAttempt.updateMany({
    where: {
      stripePaymentIntentId: paymentIntentId,
      status: { in: ACTIVE_STATUSES },
    },
    data: { status: 'COMPLETED', settledAt: new Date(), requiresAction: false },
  });
  return updated.count > 0;
}

/**
 * Money arrived but no booking could be settled (late, duplicate, terminal or
 * amount mismatch). The hosted session is spent, so close the attempt and
 * release the hold. The reconciliation service handles the refund; this keeps
 * a new link possible for a still-active booking.
 */
async function markAttemptUnclaimedForSession(sessionId, reason = 'PAYMENT_UNCLAIMED') {
  if (!sessionId) return false;
  const attempt = await prisma.bookingPaymentAttempt.findFirst({
    where: { stripeCheckoutSessionId: sessionId, status: { in: ACTIVE_STATUSES } },
  });
  if (!attempt) return false;
  await prisma.bookingPaymentAttempt.updateMany({
    where: { id: attempt.id, status: { in: ACTIVE_STATUSES } },
    data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: reason },
  });
  await clearBookingHoldIfCurrent(attempt.bookingId, attempt);
  return true;
}

async function markAttemptUnclaimedByPaymentIntent(paymentIntentId, reason = 'PAYMENT_UNCLAIMED') {
  if (!paymentIntentId) return false;
  const attempts = await prisma.bookingPaymentAttempt.findMany({
    where: {
      stripePaymentIntentId: paymentIntentId,
      status: { in: ACTIVE_STATUSES },
    },
    select: { id: true, bookingId: true, stripeCheckoutSessionId: true },
  });
  for (const attempt of attempts) {
    await prisma.bookingPaymentAttempt.updateMany({
      where: { id: attempt.id, status: { in: ACTIVE_STATUSES } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: reason },
    });
    await clearBookingHoldIfCurrent(attempt.bookingId, attempt);
  }
  return attempts.length > 0;
}

/**
 * Stale CREATING rows and expired ACTIVE rows must not hold the sweep forever.
 * Runs from the pay-later sweep (or a cleanup scheduler).
 */
async function reapStalePaymentAttempts({ now = new Date(), limit = 100 } = {}) {
  const staleCreatingBefore = new Date(now.getTime() - CREATING_STALE_MS);
  const creating = await prisma.bookingPaymentAttempt.findMany({
    where: { status: 'CREATING', createdAt: { lt: staleCreatingBefore } },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });
  for (const attempt of creating) {
    await failCreatingAttempt(attempt, 'CREATION_TIMEOUT', 'Attempt did not finish creating');
  }

  const expired = await prisma.bookingPaymentAttempt.findMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now } },
    take: limit,
    orderBy: { expiresAt: 'asc' },
  });
  for (const attempt of expired) {
    await markAttemptExpired(attempt, { reason: 'SESSION_EXPIRED' });
  }

  return { creating: creating.length, expired: expired.length };
}

/**
 * Queue retries eventually stop, but a QUEUED row has no terminal event of its
 * own. Mark old QUEUED email sends FAILED so the UI stops promising an email
 * that will never arrive. The provider error detail stays internal.
 */
async function reapStalePaymentLinkSends({ now = new Date(), limit = 100, olderThanMs = 60 * 60 * 1000 } = {}) {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const stale = await prisma.bookingPaymentLinkSend.findMany({
    where: {
      channel: 'EMAIL',
      status: 'QUEUED',
      createdAt: { lt: cutoff },
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  for (const send of stale) {
    await prisma.bookingPaymentLinkSend.updateMany({
      where: { id: send.id, status: 'QUEUED' },
      data: {
        status: 'FAILED',
        failureCode: 'EMAIL_DELIVERY_TIMEOUT',
        errorMessage: 'No provider result before the delivery timeout',
      },
    }).catch(() => {});
  }
  return { failed: stale.length };
}

async function closeRecoveryEpisode(bookingId, reason) {
  await prisma.booking.updateMany({
    where: { id: bookingId, recoveryClosedAt: null },
    data: { recoveryClosedAt: new Date(), recoveryClosedReason: reason },
  }).catch(() => {});
}

module.exports = {
  FLAGS,
  SOURCE,
  MODE,
  flagEnabled,
  assessEligibility,
  paymentLinkDeadlineFor,
  activityStartFor,
  customerEmailFor,
  ensurePaymentAttempt,
  sendPaymentLink,
  resendPaymentLink,
  regeneratePaymentLink,
  sendAutomaticRecoveryLink,
  expireCurrentAttemptForSession,
  markAttemptSettledForSession,
  markAttemptSettledByPaymentIntent,
  markAttemptUnclaimedForSession,
  markAttemptUnclaimedByPaymentIntent,
  markAttemptExpired,
  reapStalePaymentAttempts,
  reapStalePaymentLinkSends,
  closeRecoveryEpisode,
  computeSessionExpiry,
};
