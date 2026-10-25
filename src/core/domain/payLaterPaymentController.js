/**
 * Pay-Later "Complete payment now" controller.
 *
 * A reserve-now-pay-later booking normally auto-charges near the activity date
 * via the pay-later sweep. When that cannot happen (3DS challenge, expired or
 * declined card, or the customer simply wants to pay early / change card), the
 * booking is flagged `requiresPaymentActionAt` and the customer is emailed a
 * deep link back to the booking. This controller:
 *
 *   GET  /:source/bookings/:id/payment-state  — what action (if any) the
 *        customer can take on an unpaid pay-later booking.
 *   POST /:source/bookings/:id/pay-now         — start a HOSTED Stripe Checkout
 *        session for the outstanding amount. Stripe's hosted page handles 3DS,
 *        wallet and card update with zero custom card UI; completion settles the
 *        booking through the existing checkout.session.completed webhook path.
 *
 * While a hosted session is open we set paymentLinkHoldAt so the sweep never
 * double-charges the original reserved PaymentIntent concurrently. The flag is
 * intentionally separate from requiresPaymentActionAt: a hosted link is not a
 * manual-action escalation.
 */
const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const { createCheckoutSession, getStripe } = require('../services/stripeHelpers');
const { resolveAllowedClientUrl } = require('../services/clientOrigin');
const paymentLinkService = require('../services/paymentLinkService');

function paymentState(booking) {
  const isPayLater = booking.paymentTiming === 'later';
  const unpaid = booking.paymentStatus === 'PENDING';
  const reserved = booking.status === 'PENDING' || booking.status === 'CONFIRMED';
  const notCancelled = booking.status !== 'CANCELLED';
  // The activity-start cutoff, not the date-only travelDate. A 6pm activity
  // remains payable earlier the same day; a date-only activity anchors to local
  // midnight. Stripe still needs 30 minutes of session life.
  const deadlineAt = paymentLinkService.paymentLinkDeadlineFor(booking);
  const sessionWindowOpen = Boolean(
    deadlineAt && deadlineAt.getTime() - Date.now() >= 30 * 60 * 1000,
  );
  const activityInFuture = Boolean(
    deadlineAt && deadlineAt.getTime() + 2 * 60 * 60 * 1000 > Date.now(),
  );
  const heldByHostedLink = Boolean(booking.paymentLinkHoldAt);

  return {
    canPayNow: Boolean(isPayLater && unpaid && reserved && notCancelled && sessionWindowOpen),
    requiresAction: Boolean((booking.requiresPaymentActionAt || heldByHostedLink) && unpaid),
    autoChargeScheduled: Boolean(
      isPayLater && unpaid && reserved && activityInFuture
        && !booking.requiresPaymentActionAt && !heldByHostedLink,
    ),
    hostedLinkActive: heldByHostedLink,
    sessionWindowOpen,
    deadlineAt: deadlineAt ? deadlineAt.toISOString() : null,
    bookingNumber: booking.bookingNumber,
    travelDate: booking.travelDate,
  };
}

/**
 * GET /bookings/:id/payment-state
 */
exports.getPaymentState = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const customerId = req.user.id;

  const booking = await prisma.booking.findFirst({
    where: { id, customerId },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      paymentTiming: true,
      paymentStatus: true,
      paidAt: true,
      travelDate: true,
      selectedTime: true,
      stripePaymentIntentId: true,
      requiresPaymentActionAt: true,
      paymentLinkHoldAt: true,
      stripeCheckoutSessionId: true,
      tour: { select: { bookingAndTickets: true } },
    },
  });

  if (!booking) return next(new AppError('Booking not found', 404));

  res.status(200).json({ status: 'success', data: { paymentState: paymentState(booking) } });
});

/**
 * POST /bookings/:id/pay-now
 * Start a hosted Stripe Checkout session for the outstanding amount.
 */
exports.startPayNow = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const customerId = req.user.id;

  const booking = await prisma.booking.findFirst({
    where: { id, customerId },
    include: {
      tour: {
        select: {
          id: true,
          title: true,
          description: true,
          coverPhoto: true,
          photos: true,
          bookingAndTickets: true,
          supplier: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!booking) return next(new AppError('Booking not found', 404));

  const state = paymentState(booking);
  if (!state.canPayNow) {
    const alreadyPaid = booking.paymentStatus === 'SUCCEEDED';
    const windowClosed = state.sessionWindowOpen === false
      && booking.paymentStatus === 'PENDING';
    return next(new AppError(
      alreadyPaid
        ? 'This booking is already paid.'
        : windowClosed
          ? 'The secure payment window for this booking has closed. Please contact support.'
          : 'This booking cannot be paid online right now. Please contact support.',
      409,
      {
        code: alreadyPaid
          ? 'BOOKING_ALREADY_PAID'
          : windowClosed
            ? 'PAYMENT_LINK_WINDOW_CLOSED'
            : 'PAYMENT_NOT_AVAILABLE',
        reasonCode: alreadyPaid
          ? 'PAYMENT_ALREADY_SETTLED'
          : windowClosed
            ? 'PAYMENT_WINDOW_CLOSED'
            : 'PAYMENT_NOT_ELIGIBLE',
      },
    ));
  }

  const amount = Math.round(Number(booking.grossAmount) * 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    return next(new AppError('Could not determine the amount due for this booking', 400, {
      code: 'PAYMENT_LINK_AMOUNT_UNAVAILABLE',
      reasonCode: 'INVALID_BOOKING_TOTAL',
    }));
  }

  // Shared attempt service: one active hosted session per booking, cutoff,
  // idempotency, and the booking-level hold. The customer is redirected to the
  // existing live session when one is already open (no duplicate Stripe
  // PaymentIntent, no duplicate recovery email).
  if (await paymentLinkService.flagEnabled(paymentLinkService.FLAGS.base)) {
    const ensured = await paymentLinkService.ensurePaymentAttempt({
      bookingId: booking.id,
      source: paymentLinkService.SOURCE.CUSTOMER_PAY_NOW,
      mode: paymentLinkService.MODE.CREATE,
      actor: { id: req.user.id, role: 'customer' },
      sendInChat: false,
    });
    const attempt = ensured.attempt;
    if (!attempt?.checkoutUrl) {
      return next(new AppError('Could not start secure payment. Please try again.', 502, {
        code: 'PAYMENT_LINK_PROVIDER_ERROR',
        reasonCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
      }));
    }
    return res.status(201).json({
      status: 'success',
      data: {
        url: attempt.checkoutUrl,
        sessionId: attempt.stripeCheckoutSessionId,
        paymentState: { ...state, canPayNow: false, requiresAction: true, hostedLinkActive: true },
      },
      message: 'Redirecting to secure payment…',
    });
  }

  // Legacy path (shared attempts disabled): never create a second hosted
  // session while an earlier one is still open. Resume the existing Stripe
  // session instead, and let an in-flight completed session land via webhook.
  if (booking.paymentLinkHoldAt) {
    if (booking.stripeCheckoutSessionId) {
      let existing;
      try {
        existing = await getStripe().checkout.sessions.retrieve(booking.stripeCheckoutSessionId);
      } catch (err) {
        console.error('[PayLaterPayNow] Could not retrieve the existing session:', err.message);
        return next(new AppError('We could not check the existing payment page. Please try again.', 502, {
          code: 'PAYMENT_LINK_PROVIDER_ERROR',
          reasonCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
        }));
      }
      if (existing?.status === 'open' && existing.url) {
        return res.status(200).json({
          status: 'success',
          data: {
            url: existing.url,
            sessionId: existing.id,
            paymentState: { ...state, canPayNow: false, requiresAction: true, hostedLinkActive: true },
          },
          message: 'Resuming your secure payment page.',
        });
      }
      if (['complete', 'processing'].includes(existing?.status)) {
        return next(new AppError(
          'A payment for this booking is already being processed. Refresh in a moment to see the result.',
          409,
          { code: 'PAYMENT_LINK_COMPLETION_IN_PROGRESS', reasonCode: 'PAYMENT_COMPLETION_IN_PROGRESS' },
        ));
      }
      // Stripe says the old session is expired. Release only that stale hold.
      await prisma.booking.updateMany({
        where: { id: booking.id, stripeCheckoutSessionId: booking.stripeCheckoutSessionId },
        data: { paymentLinkHoldAt: null, stripeCheckoutSessionId: null },
      }).catch(() => {});
    } else {
      return next(new AppError(
        'A secure payment page is already being prepared for this booking. Please try again in a moment.',
        409,
        { code: 'PAYMENT_LINK_CREATING', reasonCode: 'ATTEMPT_IN_PROGRESS' },
      ));
    }
  }

  const tour = booking.tour || {};
  const origin = resolveAllowedClientUrl(req);
  // Prefer the storefront the booking was created on. It was allow-listed and
  // stored at creation time, so the post-payment redirect stays on the right
  // brand even when the request's Origin header is missing or untrusted.
  const clientOrigin = booking.clientOrigin || origin;
  // Land the customer back on their booking after payment so the new status
  // (CONFIRMED / paid) is obvious. The Expedition and Ghana storefronts both
  // manage bookings in the dashboard; legacy TravioAfrica uses /booking/:id.
  const isExpedition = booking.source === 'EXPEDITION';
  const usesDashboard = isExpedition || booking.source === 'GHANA';
  const successPath = usesDashboard
    ? `/dashboard/bookings?booking=${encodeURIComponent(booking.id)}&paid=1`
    : `/booking/${encodeURIComponent(booking.id)}?paid=1`;

  // Pause the sweep BEFORE Stripe is called. The old order created a payable
  // session first and only then wrote the hold, leaving a window where the
  // sweep could charge the original PaymentIntent at the same time.
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      paymentLinkHoldAt: new Date(),
      chargeRetries: 0,
      nextRetryAt: null,
    },
  });

  let session;
  try {
    const requestedKey = req.get ? req.get('Idempotency-Key') : req.headers?.['idempotency-key'];
    session = await createCheckoutSession({
      amount,
      currency: booking.currency || 'USD',
      bookingId: booking.id,
      tourTitle: tour.title,
      tourDescription: tour.description || null,
      tourCoverPhoto: tour.coverPhoto || (Array.isArray(tour.photos) && tour.photos[0]) || null,
      customerId: req.user.stripeCustomerId || undefined,
      customerEmail: req.user.email || booking.customer?.email,
      clientUrl: clientOrigin,
      successPath,
      source: isExpedition ? 'expedition' : 'ghana',
      idempotencyKey: requestedKey
        ? `paynow:${booking.id}:${req.user.id}:${requestedKey}`
        : undefined,
    });
  } catch (err) {
    await prisma.booking.update({
      where: { id: booking.id },
      data: { paymentLinkHoldAt: null },
    }).catch(() => {});
    console.error('[PayLaterPayNow] Stripe session creation failed:', err.message);
    return next(new AppError('Could not start secure payment. Please try again.', 502, {
      code: 'PAYMENT_LINK_PROVIDER_ERROR',
      reasonCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
    }));
  }

  // Record the session. If the session expires without payment,
  // checkout.session.expired clears this hold only when the session is current.
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      stripeCheckoutSessionId: session.id,
      paymentLinkHoldAt: new Date(),
      chargeRetries: 0,
      nextRetryAt: null,
    },
  }).catch((err) => console.error('[PayLaterPayNow] Failed to store session id:', err.message));

  res.status(201).json({
    status: 'success',
    data: {
      url: session.url,
      sessionId: session.id,
      paymentState: { ...state, canPayNow: false, requiresAction: true, hostedLinkActive: true },
    },
    message: 'Redirecting to secure payment…',
  });
});
