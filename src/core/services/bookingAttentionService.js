/**
 * Server-authoritative booking attention projection.
 *
 * This is deliberately read-only. It never invents a second booking status and
 * never writes payment state. The supplier UI renders the returned object
 * directly; a transient toast or a locally-derived "unpaid" badge is not
 * authority for payment or reservation health.
 *
 * One batch query per page (attempts + email sends), so list pages do not
 * become N+1 as the booking count grows.
 */

const prisma = require('./prismaClient');
const { assessEligibility, customerEmailFor, SEND_COOLDOWN_MS, MAX_CUSTOMER_TOUCHES } = require('./paymentLinkService');

const ACTIVE_ATTEMPT_STATUSES = ['CREATING', 'ACTIVE'];

// Stripe will not create a Checkout Session shorter than this, and the attempt
// service refuses below it (paymentLinkService.assertSessionWindow). Offering
// Send once the remaining window is shorter would advertise an action the
// server is guaranteed to reject.
const SESSION_MIN_MS = 30 * 60 * 1000;

const SAFE_FAILURE_REASONS = {
  AUTHENTICATION_REQUIRED: 'The customer must verify the payment with their bank (3D Secure).',
  CARD_DECLINED: 'The saved card was declined.',
  CARD_DECLINED_RETRYING: 'The saved card was declined. We will retry automatically.',
  AUTO_CHARGE_FAILED: 'The automatic charge could not be completed.',
  NO_PAYMENT_METHOD: 'No saved card is available for the automatic charge.',
  PAYMENT_INTENT_CANCELLED: 'The payment attempt was cancelled.',
  PAYMENT_LINK_EXPIRED: 'The secure payment link expired before the customer paid.',
  PAYMENT_NOT_CONFIRMED: 'Payment has not been confirmed yet.',
};

function safeFailureReason(code) {
  return SAFE_FAILURE_REASONS[code] || 'Payment could not be confirmed.';
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function paymentConfirmationState(booking) {
  const map = {
    PENDING: 'UNCONFIRMED',
    PROCESSING: 'PROCESSING',
    SUCCEEDED: 'CONFIRMED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    REFUNDED: 'REFUNDED',
  };
  return map[booking.paymentStatus] || 'UNCONFIRMED';
}

function amountDueFor(booking) {
  if (booking.paymentStatus !== 'PENDING') return null;
  return {
    amount: Number(booking.grossAmount),
    currency: booking.currency || 'USD',
  };
}

function emailStateFor(send) {
  if (!send) return 'NOT_SENT';
  if (send.status === 'SENT') return 'SENT';
  if (send.status === 'QUEUED') return 'QUEUED';
  if (send.status === 'FAILED') return 'FAILED';
  return 'NOT_SENT';
}

function latestSendForBooking(sends, attempt) {
  if (!sends || sends.length === 0) return null;
  if (attempt) {
    const forAttempt = sends.find((s) => s.attemptId === attempt.id);
    if (forAttempt) return forAttempt;
    // A new attempt without a send is NOT_SENT, even if an older attempt had
    // been emailed. Showing the old "sent" state would misrepresent the current
    // link.
    return null;
  }
  return sends[0] || null;
}

/**
 * One enum the supplier UI switches on, so a sent link, an expired one and a
 * booking whose window closed each look different at a glance. Paid beats
 * everything, then a live link, then an expired one, then a closed window.
 */
function linkStateFor({ paymentConfirmed, liveAttempt, relevantAttempt, deadlineAt, emailState, now }) {
  if (paymentConfirmed) return 'PAID';
  if (liveAttempt && liveAttempt.status === 'ACTIVE') {
    return emailState === 'NOT_SENT' ? 'READY' : 'SENT';
  }
  if (relevantAttempt && new Date(relevantAttempt.expiresAt).getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  if (deadlineAt && deadlineAt.getTime() <= now.getTime()) return 'WINDOW_CLOSED';
  return 'NONE';
}

function action(code, label, extra = {}) {
  return { code, label, ...extra };
}

/**
 * Build one attention object from a booking plus its preloaded attempt/send
 * snapshot. Pure: no DB access, easy to test and reuse by detail/list endpoints.
 */
function buildBookingAttention(booking, snapshot = {}, options = {}) {
  const {
    canManage = false,
    flags = {},
    now = new Date(),
  } = options;

  const eligibility = assessEligibility(booking, { now });
  const deadlineAt = eligibility.deadlineAt;
  const activityStart = eligibility.activityStart;
  const attempts = snapshot.attempts || [];
  const sends = snapshot.sends || [];
  const latestAttempt = attempts[0] || null;
  const liveAttempt = attempts.find(
    (a) => ACTIVE_ATTEMPT_STATUSES.includes(a.status)
      && new Date(a.expiresAt).getTime() > now.getTime(),
  ) || null;
  const relevantAttempt = liveAttempt || latestAttempt;
  // Chat rows share this table; the email state only considers EMAIL sends.
  const lastSend = latestSendForBooking(sends.filter((s) => s.channel !== 'CHAT'), relevantAttempt);
  const emailState = emailStateFor(lastSend);
  // Session life, not merely "before the cutoff": the attempt service refuses
  // to open a Stripe session with less than 30 minutes of life left, so an
  // eligible booking inside that floor must not be offered a Send action the
  // server is guaranteed to reject.
  const sessionFloorOpen = Boolean(
    deadlineAt && deadlineAt.getTime() - now.getTime() >= SESSION_MIN_MS,
  );
  const eligible = eligibility.eligible && sessionFloorOpen;
  const activityNotStarted = Boolean(
    activityStart && !Number.isNaN(activityStart.getTime())
      && now.getTime() < activityStart.getTime(),
  );
  const linkFlagsOn = Boolean(flags.base && flags.supplier);
  // A customer-created live session has no supplier email send row yet. The
  // supplier may still email that same link (the attempt service reuses it).
  // Sending is only possible without a live attempt, or against a completed
  // ACTIVE session that no email has been accepted for yet. A CREATING row is
  // still talking to Stripe, so no send action is safe to expose.
  const canSend = Boolean(
    canManage && linkFlagsOn && eligible
      && (!liveAttempt || (liveAttempt.status === 'ACTIVE' && emailState === 'NOT_SENT')),
  );
  // A resend may reuse a live session in the final two hours even though a new
  // link can no longer be issued. It must never bypass a started activity,
  // terminal booking, settled payment, or missing email.
  const canResend = Boolean(
    canManage && linkFlagsOn && liveAttempt && liveAttempt.status === 'ACTIVE'
      && emailState !== 'NOT_SENT' && customerEmailFor(booking)
      && activityNotStarted && booking.paymentTiming === 'later'
      && booking.paymentStatus === 'PENDING'
      && ['PENDING', 'CONFIRMED'].includes(booking.status),
  );
  const canRegenerate = Boolean(
    canManage && linkFlagsOn && eligible && liveAttempt && liveAttempt.status === 'ACTIVE',
  );
  const canSendInChat = Boolean(
    canManage && flags.base && flags.supplier && flags.chat && (canSend || canResend),
  );
  const paymentConfirmed = booking.paymentStatus === 'SUCCEEDED';
  // A future retry timestamp is the persisted fact the sweep honors. Do not
  // require a particular failure string: every transient decline schedules the
  // same retry, and the supplier must see "Payment retrying" rather than an
  // action they do not need to take yet.
  const retrying = Boolean(
    booking.nextRetryAt
      && new Date(booking.nextRetryAt).getTime() > now.getTime()
      && !booking.requiresPaymentActionAt,
  );

  const payment = {
    confirmed: paymentConfirmed,
    confirmationState: paymentConfirmationState(booking),
    amountDue: amountDueFor(booking),
    failureReason: booking.paymentFailureCode ? safeFailureReason(booking.paymentFailureCode) : null,
    failureCode: booking.paymentFailureCode || null,
    retrying,
    lastAttemptAt: iso(relevantAttempt?.createdAt),
  };

  // Customer touches so far, and when the next one is allowed. The service
  // enforces one email per day and a hard ceiling; the projection only reports
  // them, so the supplier UI can offer a countdown instead of a button that
  // would come back as a 409/429.
  const customerTouches = sends.filter((s) => ['QUEUED', 'SENT'].includes(s.status));
  const emailTouches = customerTouches.filter((s) => s.channel !== 'CHAT');
  const newestEmailTouch = emailTouches.reduce(
    (newest, s) => (!newest || new Date(s.createdAt) > new Date(newest.createdAt) ? s : newest),
    null,
  );
  const nextResendAtDate = newestEmailTouch
    ? new Date(new Date(newestEmailTouch.createdAt).getTime() + SEND_COOLDOWN_MS)
    : null;
  const supersededAttempt = liveAttempt
    ? attempts.find((a) => a.supersededByAttemptId === liveAttempt.id)
    : null;

  const link = {
    // One field the UI can switch on, instead of inferring the situation from
    // the email row and the deadline separately.
    state: linkStateFor({ paymentConfirmed, liveAttempt, relevantAttempt, deadlineAt, emailState, now }),
    active: Boolean(liveAttempt && liveAttempt.status === 'ACTIVE'),
    expiresAt: iso(relevantAttempt?.expiresAt),
    emailState,
    lastEmailedAt: iso(lastSend?.sentAt || lastSend?.createdAt),
    // Customer touches so far, the channels they went out on, and when the next
    // one is allowed: the supplier UI shows a countdown rather than a button
    // that would be refused.
    sentCount: customerTouches.length,
    channels: {
      email: emailTouches.length > 0,
      chat: customerTouches.some((s) => s.channel === 'CHAT'),
    },
    nextResendAt: iso(nextResendAtDate),
    supersededAt: iso(supersededAttempt?.updatedAt || supersededAttempt?.createdAt),
    atTouchLimit: customerTouches.length >= MAX_CUSTOMER_TOUCHES,
    canSend,
    canResend,
    canRegenerate,
    canSendInChat,
    customerEmailOnFile: Boolean(customerEmailFor(booking)),
  };

  const actions = [];
  if (canSend) actions.push(action('SEND_PAYMENT_LINK', 'Send payment link'));
  if (canResend) actions.push(action('RESEND_PAYMENT_LINK', 'Resend payment link'));
  // Regenerate is only meaningful when a link exists; with no live link the
  // primary SEND action already creates one.
  if (canRegenerate) actions.push(action('REGENERATE_PAYMENT_LINK', 'Generate new link'));

  const base = {
    level: 'NONE',
    code: null,
    reasonCode: null,
    title: null,
    message: null,
    nextStep: null,
    deadlineAt: iso(deadlineAt),
    payment,
    link,
    actions,
  };

  // Terminal booking: only information, never a resurrect action. Capacity
  // loss is only asserted when persisted cancellation data says so; we do not
  // infer "unavailable" from a generic cancellation.
  if (['CANCELLED', 'COMPLETED', 'NO_SHOW', 'REFUNDED'].includes(booking.status)) {
    const capacityLost = ['CAPACITY_LOST', 'OVERBOOKED'].includes(booking.cancellationCode);
    if (capacityLost) {
      return {
        ...base,
        level: 'CRITICAL',
        code: 'RESERVATION_UNAVAILABLE',
        reasonCode: 'CAPACITY_NO_LONGER_AVAILABLE',
        title: 'Reservation unavailable',
        message: 'This reservation was cancelled because the activity is no longer available.',
        nextStep: 'No payment action is needed. The cancellation details show the next step for the customer.',
        actions: [],
      };
    }
    // A completed or no-show pay-later booking with no settled payment is a
    // real money problem. Do not hide it behind a generic terminal badge just
    // because no further payment link can be issued.
    if (
      ['COMPLETED', 'NO_SHOW'].includes(booking.status)
      && booking.paymentTiming === 'later'
      && !['SUCCEEDED', 'REFUNDED'].includes(booking.paymentStatus)
    ) {
      return {
        ...base,
        level: 'ACTION_REQUIRED',
        code: 'PAYMENT_ACTION_REQUIRED',
        reasonCode: 'PAYMENT_NOT_CONFIRMED',
        title: 'Payment not confirmed',
        message: 'This booking was marked completed or no-show without a confirmed payment.',
        nextStep: 'Contact the customer or support to reconcile the payment. No new secure link can be issued after the activity.',
        actions: [],
      };
    }
    return base;
  }

  if (booking.paymentTiming !== 'later' || booking.paymentStatus === 'SUCCEEDED') {
    return base;
  }

  if (booking.paymentStatus === 'PROCESSING') {
    return {
      ...base,
      level: 'INFO',
      reasonCode: 'PAYMENT_PROCESSING',
      title: 'Payment processing',
      message: 'Payment is being processed. It is not confirmed until the payment provider reports success.',
      nextStep: 'No action needed right now. Refresh in a moment if this stays unchanged.',
      actions: [],
    };
  }

  const windowClosesSoon = Boolean(
    deadlineAt && deadlineAt.getTime() > now.getTime()
      && deadlineAt.getTime() - now.getTime() <= 24 * 60 * 60 * 1000,
  );
  const hasFailure = Boolean(booking.paymentFailureCode);

  if (booking.requiresPaymentActionAt && booking.paymentStatus === 'PENDING') {
    const emailedLiveLink = Boolean(liveAttempt && emailState === 'SENT');
    let message;
    let nextStep;
    if (emailedLiveLink) {
      message = 'Payment is still unconfirmed. A secure payment link was emailed to the customer.';
      nextStep = 'The customer can pay using the secure link. Resend it if they cannot find it.';
    } else if (liveAttempt?.status === 'CREATING') {
      message = 'Payment is still unconfirmed. A secure payment link is being prepared.';
      nextStep = 'Wait a moment and refresh the booking before taking another action.';
    } else if (liveAttempt) {
      message = emailState === 'QUEUED'
        ? 'Payment is still unconfirmed. The secure link email is queued but not accepted by the provider yet.'
        : 'A secure payment link is active but the customer has not been notified successfully.';
      nextStep = 'Resend the link, or send it in chat if the customer cannot receive email.';
    } else if (eligible) {
      message = emailState === 'SENT'
        ? 'Payment is still unconfirmed. The previous secure link is no longer active.'
        : 'Payment has not been confirmed for this reservation.';
      nextStep = canSend
        ? 'Send the customer a new secure payment link so they can pay with another card.'
        : 'Automatic secure links are unavailable for this booking. Contact support before the activity.';
    } else if (emailState === 'SENT') {
      message = 'Payment is still unconfirmed and the secure link has expired.';
      nextStep = 'The payment window has closed, so no new link can be issued. Contact the customer or support now.';
    } else {
      message = 'Payment has not been confirmed for this reservation.';
      nextStep = 'The payment window has closed, so no new link can be issued. Contact the customer or support now.';
    }
    return {
      ...base,
      level: 'ACTION_REQUIRED',
      code: 'PAYMENT_ACTION_REQUIRED',
      reasonCode: booking.paymentFailureCode
        || (liveAttempt ? (emailState === 'SENT' ? 'PAYMENT_LINK_SENT' : 'PAYMENT_LINK_NOT_EMAILED') : 'PAYMENT_NOT_CONFIRMED'),
      title: 'Payment not confirmed',
      message,
      nextStep,
      actions,
    };
  }

  // A hosted link is live and the customer is expected to act. This is a
  // persistent, supplier-visible state, not a toast.
  if (liveAttempt && booking.paymentStatus === 'PENDING') {
    if (liveAttempt.status === 'CREATING') {
      return {
        ...base,
        level: 'INFO',
        code: 'PAYMENT_PROCESSING',
        reasonCode: 'PAYMENT_LINK_PREPARING',
        title: 'Preparing secure link',
        message: 'A secure payment link is being prepared for the customer.',
        nextStep: 'No action is needed yet. Refresh in a moment to see the sent link.',
        actions: [],
      };
    }
    return {
      ...base,
      level: windowClosesSoon ? 'WARNING' : 'ACTION_REQUIRED',
      code: windowClosesSoon ? 'RESERVATION_AT_RISK' : 'PAYMENT_ACTION_REQUIRED',
      reasonCode: emailState === 'SENT' ? 'PAYMENT_LINK_SENT' : 'PAYMENT_LINK_NOT_EMAILED',
      title: windowClosesSoon ? 'Payment window closing' : 'Payment not confirmed',
      message: emailState === 'SENT'
        ? 'Payment is still unconfirmed. A secure payment link was emailed to the customer.'
        : 'A secure payment link is active but the customer has not been notified successfully.',
      nextStep: emailState === 'SENT'
        ? 'The customer can complete payment from the link. Resend it if needed.'
        : 'Resend the link, or send it in chat if the customer cannot receive email.',
      actions,
    };
  }

  if (hasFailure && !retrying) {
    return {
      ...base,
      level: 'WARNING',
      code: 'PAYMENT_FAILED',
      reasonCode: booking.paymentFailureCode,
      title: 'Payment failed',
      message: safeFailureReason(booking.paymentFailureCode),
      nextStep: eligible
        ? (canSend
          ? 'Send a secure payment link so the customer can pay with another card.'
          : 'Automatic secure links are unavailable for this booking. Contact support before the activity.')
        : 'The payment window has closed. Contact support before promising the reservation.',
      actions,
    };
  }

  if (hasFailure && retrying) {
    return {
      ...base,
      level: 'WARNING',
      code: 'PAYMENT_FAILED',
      reasonCode: booking.paymentFailureCode,
      title: 'Payment retrying',
      message: 'The saved card failed and an automatic retry is scheduled.',
      nextStep: 'No action needed right now. The system will retry automatically.',
      actions: [],
    };
  }

  if (windowClosesSoon) {
    return {
      ...base,
      level: 'WARNING',
      code: 'RESERVATION_AT_RISK',
      reasonCode: 'PAYMENT_WINDOW_CLOSING',
      title: 'Payment window closing',
      message: 'Payment has not been confirmed and the secure payment window closes soon.',
      nextStep: canSend
        ? 'Send a secure payment link now if the customer needs to pay with another card.'
        : 'Contact the customer or support to arrange payment before the window closes.',
      actions,
    };
  }

  // Normal reserve-now-pay-later state: no failure yet, but never show it as
  // paid. The card renders a neutral "Payment unconfirmed" pill. The supplier
  // may still choose to send a secure link proactively; that intentionally
  // pauses the automatic sweep until the hosted session expires.
  return {
    ...base,
    level: 'INFO',
    reasonCode: 'PAYMENT_NOT_CONFIRMED',
    title: 'Payment unconfirmed',
    message: 'This reservation is held but payment has not been collected yet.',
    nextStep: canSend
      ? 'The saved card will be charged automatically before the activity. You can also send a secure payment link now.'
      : 'The saved card will be charged automatically before the activity.',
    actions,
  };
}

function groupByBooking(rows) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.bookingId) || [];
    list.push(row);
    map.set(row.bookingId, list);
  }
  return map;
}

/**
 * Attach `attention` to each booking with two batched queries. Never mutates
 * the booking payload beyond adding the projection.
 */
async function attachBookingAttention(bookings, options = {}) {
  const list = Array.isArray(bookings) ? bookings : [];
  if (list.length === 0) return list;
  const ids = list.map((b) => b.id).filter(Boolean);
  const [attempts, sends] = await Promise.all([
    prisma.bookingPaymentAttempt.findMany({
      where: { bookingId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        bookingId: true,
        source: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        settledAt: true,
        expiredAt: true,
        supersededByAttemptId: true,
      },
    }),
    // Every channel: the projection reports customer touches (email + chat) for
    // the send ceiling, and picks the EMAIL row for the email state itself.
    prisma.bookingPaymentLinkSend.findMany({
      where: { bookingId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        bookingId: true,
        attemptId: true,
        channel: true,
        status: true,
        sentAt: true,
        createdAt: true,
        failureCode: true,
      },
    }),
  ]);
  const attemptsByBooking = groupByBooking(attempts);
  const sendsByBooking = groupByBooking(sends);
  const now = options.now || new Date();

  return list.map((booking) => ({
    ...booking,
    attention: buildBookingAttention(booking, {
      attempts: attemptsByBooking.get(booking.id) || [],
      sends: sendsByBooking.get(booking.id) || [],
    }, { ...options, now }),
  }));
}

module.exports = {
  buildBookingAttention,
  attachBookingAttention,
  safeFailureReason,
};
