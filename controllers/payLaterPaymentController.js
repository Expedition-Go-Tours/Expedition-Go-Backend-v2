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
 * While a hosted session is open we set requiresPaymentActionAt so the sweep
 * never double-charges the original reserved PaymentIntent concurrently.
 */
const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { createCheckoutSession } = require('../utils/stripeHelpers');
const { resolveAllowedClientUrl } = require('../utils/clientOrigin');

function paymentState(booking) {
  const isPayLater = booking.paymentTiming === 'later';
  const unpaid = booking.paymentStatus === 'PENDING';
  const reserved = booking.status === 'PENDING' || booking.status === 'CONFIRMED';
  const notCancelled = booking.status !== 'CANCELLED';
  const activityInFuture = booking.travelDate && new Date(booking.travelDate).getTime() > Date.now();

  return {
    canPayNow: Boolean(isPayLater && unpaid && reserved && notCancelled && activityInFuture),
    requiresAction: Boolean(booking.requiresPaymentActionAt && unpaid),
    autoChargeScheduled: Boolean(isPayLater && unpaid && reserved && activityInFuture && !booking.requiresPaymentActionAt),
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
      stripePaymentIntentId: true,
      requiresPaymentActionAt: true,
      stripeCheckoutSessionId: true,
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
          supplier: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!booking) return next(new AppError('Booking not found', 404));

  const state = paymentState(booking);
  if (!state.canPayNow) {
    return next(new AppError(
      booking.paymentStatus === 'SUCCEEDED'
        ? 'This booking is already paid'
        : 'This booking cannot be paid online right now — please contact support',
      400
    ));
  }

  const amount = Math.round(Number(booking.grossAmount) * 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    return next(new AppError('Could not determine the amount due for this booking', 400));
  }

  const tour = booking.tour || {};
  const origin = resolveAllowedClientUrl(req);
  const clientOrigin = booking.clientOrigin || origin;
  // Land the customer back on their booking after payment so the new status
  // (CONFIRMED / paid) is obvious. Expedition manages bookings in the dashboard;
  // legacy storefronts use the /booking/:id deep link.
  const isExpedition = booking.source === 'EXPEDITION';
  const successPath = isExpedition
    ? `/dashboard/bookings?booking=${encodeURIComponent(booking.id)}&paid=1`
    : `/booking/${encodeURIComponent(booking.id)}?paid=1`;

  // Before we create the session, pause the auto-charge sweep for this booking
  // so it cannot confirm the original reserved PI while the customer pays.
  const session = await createCheckoutSession({
    amount,
    currency: booking.currency || 'USD',
    bookingId: booking.id,
    tourTitle: tour.title,
    tourDescription: tour.description || null,
    tourCoverPhoto: tour.coverPhoto || (Array.isArray(tour.photos) && tour.photos[0]) || null,
    customerId: req.user.stripeCustomerId || undefined,
    customerEmail: req.user.email || booking.customer?.email,
    clientUrl: origin,
    successPath,
    source: isExpedition ? 'expedition' : 'ghana',
  });

  // Record the session + pause sweep. If the session expires without payment,
  // checkout.session.expired clears the hold so the sweep may resume/requeue.
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      stripeCheckoutSessionId: session.id,
      requiresPaymentActionAt: new Date(),
      chargeRetries: 0,
      nextRetryAt: null,
    },
  }).catch((err) => console.error('[PayLaterPayNow] Failed to store session id:', err.message));

  res.status(201).json({
    status: 'success',
    data: {
      url: session.url,
      sessionId: session.id,
      paymentState: { ...state, canPayNow: false, requiresAction: true },
    },
    message: 'Redirecting to secure payment…',
  });
});
