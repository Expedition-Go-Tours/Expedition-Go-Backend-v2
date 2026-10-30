/**
 * Payment provider facade.
 *
 * Call sites that already hold a Booking should use `refundBookingPayment`
 * instead of calling Stripe directly. It routes to whichever processor actually
 * took the money and returns a Stripe-shaped result, so existing callers keep
 * working without knowing PayPal exists.
 */

const prisma = require('../prismaClient');
const { createRefund } = require('../stripeHelpers');
const {
  resolveProvider,
  paypalConfig,
  isPaypalConfigured,
  paypalBrandAllowed,
  paymentCapabilities,
} = require('./config');
const paypalPayments = require('./paypalPayments');
const { settlePaypalOrder } = require('./settlePaypal');
const normalize = require('./normalize');

/**
 * Create the PayPal order for a checkout draft. Return/cancel URLs come from
 * the brand registry so Ghana and Expedition stay on their own domains, and
 * PayPal appends its own `token` (order id) when it sends the customer back.
 */
async function startPaypalCheckout({ draftId, amountMinor, currency, description, brand, cancelPath }) {
  const base = String(brand?.storefrontUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('startPaypalCheckout requires a brand storefront URL');

  // A bare `/booking` has no tour context, so cancelling on PayPal's page landed
  // the customer on an empty checkout ("How to pay: Pay now — $0.00"). Send
  // them back to the tour's own booking page instead, where they can re-pick.
  //
  // The marker plus the draft id let that page free the hold immediately and
  // say "cancelled, nothing was charged" — otherwise the seats stay held for
  // the full 30 minutes and the customer is left guessing.
  const cancel = String(cancelPath || '/booking');
  const cancelUrl = new URL(`${base}${cancel.startsWith('/') ? cancel : `/${cancel}`}`);
  cancelUrl.searchParams.set('paypal', 'cancelled');
  cancelUrl.searchParams.set('draft', String(draftId));

  return paypalPayments.createOrder({
    draftId,
    amountMinor,
    currency,
    description,
    brandName: brand?.brandName || brand?.key || 'Travio',
    returnUrl: `${base}/booking/paypal/return`,
    cancelUrl: cancelUrl.toString(),
  });
}

/**
 * Capture and settle in one call, used by the browser return route.
 *
 * Ownership is checked against the signed-in customer before anything is
 * captured: an order id alone must not let one account settle another account's
 * payment. The capture itself is idempotent, so a refresh or a webhook race is
 * harmless.
 */
async function captureAndSettlePaypal(orderId, { customerId } = {}) {
  if (!orderId) return { ok: false, reason: 'missing_order' };

  const draft = await prisma.checkoutDraft.findUnique({
    where: { paypalOrderId: orderId },
    include: { tour: { select: { id: true, title: true, slug: true } } },
  });
  if (!draft) return { ok: false, reason: 'not_found' };
  if (customerId && draft.customerId !== customerId) return { ok: false, reason: 'not_owner' };
  if (draft.paymentProvider !== 'PAYPAL') return { ok: false, reason: 'provider_mismatch' };

  if (draft.status === 'PAID') {
    return { ok: true, alreadySettled: true, bookingId: draft.bookingId, draft };
  }
  if (draft.status !== 'HOLDING') {
    // The sweep or a webhook has already decided; settlement is idempotent and
    // will report the terminal state.
    return settlePaypalOrder(orderId, { source: 'return' });
  }

  try {
    await paypalPayments.captureOrder(orderId, {
      idempotencyKey: `paypal-capture-${draft.id}`,
    });
  } catch (err) {
    if (err?.code && /INSTRUMENT_DECLINED|PAYER_ACTION_REQUIRED|ORDER_NOT_APPROVED/i.test(err.code)) {
      return { ok: false, reason: 'declined', code: err.code, draft };
    }
    throw err;
  }

  return settlePaypalOrder(orderId, { source: 'return' });
}

function providerOf(booking) {
  return String(booking?.paymentProvider || 'STRIPE').toUpperCase() === 'PAYPAL' ? 'PAYPAL' : 'STRIPE';
}

/**
 * Recover the approval link for a PayPal draft that is still waiting.
 *
 * The link is not stored (it is derivable), so a customer who refreshes the
 * checkout page — or loses the tab mid-payment — can be sent back to PayPal
 * without minting a second order for the same hold. Ownership is checked
 * exactly as it is for capture: an order id alone must never be enough.
 *
 * Returns:
 *   { ok: true, status, orderStatus, approvalUrl, bookingId }
 *     status       — the DRAFT's status (HOLDING / PAID / EXPIRED / REFUNDED)
 *     orderStatus  — PayPal's own order status, for the client to branch on
 *     approvalUrl  — null when the order can no longer be approved
 *   { ok: false, reason } — missing_order | not_found | not_owner | provider_mismatch
 */
async function getPaypalApproval(orderId, { customerId } = {}) {
  if (!orderId) return { ok: false, reason: 'missing_order' };

  const draft = await prisma.checkoutDraft.findUnique({ where: { paypalOrderId: orderId } });
  if (!draft) return { ok: false, reason: 'not_found' };
  if (customerId && draft.customerId !== customerId) return { ok: false, reason: 'not_owner' };
  if (draft.paymentProvider !== 'PAYPAL') return { ok: false, reason: 'provider_mismatch' };

  const summary = {
    tourTitle: draft.tour?.title || null,
    tourId: draft.tour?.id || null,
    tourSlug: draft.tour?.slug || null,
    amount: Number(draft.pricing?.total || 0),
    currency: draft.pricing?.currency || draft.currency || 'USD',
    travelDate: draft.travelDate || null,
    expiresAt: draft.expiresAt || null,
  };

  if (draft.status === 'PAID') {
    return { ok: true, status: 'PAID', orderStatus: 'COMPLETED', approvalUrl: null, bookingId: draft.bookingId, summary };
  }
  if (draft.status !== 'HOLDING') {
    // EXPIRED / REFUNDED: the hold is gone, and approving now would land the
    // customer in the auto-refund path. Tell the client instead.
    return { ok: true, status: draft.status, orderStatus: null, approvalUrl: null, bookingId: draft.bookingId, summary };
  }

  const { order } = await paypalPayments.getOrder(orderId);
  const links = Array.isArray(order.links) ? order.links : [];
  const approve = links.find((link) => link.rel === 'approve' || link.rel === 'payer-action');

  return {
    ok: true,
    status: 'HOLDING',
    orderStatus: order.status || null,
    approvalUrl: approve?.href || null,
    bookingId: null,
    summary,
  };
}

/**
 * What the storefront should offer right now, for a brand and currency.
 */
function capabilities(opts) {
  return paymentCapabilities(opts);
}

/**
 * Refund a booking through the provider that settled it.
 *
 * `amountMinor` is optional; null means a full refund, matching createRefund.
 * The returned shape mirrors a Stripe refund (`id`, `status`, `amount` in minor
 * units, lowercase `currency`) and adds `provider`.
 */
async function refundBookingPayment(booking, amountMinor = null, opts) {
  if (!booking || !booking.id) {
    throw new Error('refundBookingPayment requires a persisted booking');
  }

  if (providerOf(booking) !== 'PAYPAL') {
    if (!booking.stripePaymentIntentId) {
      throw new Error('Booking has no Stripe PaymentIntent to refund');
    }
    // Forward `opts` untouched (including undefined) so the Stripe path stays
    // byte-for-byte the call it was before PayPal existed. Callers that never
    // passed options keep a two-argument createRefund call.
    return opts === undefined
      ? createRefund(booking.stripePaymentIntentId, amountMinor)
      : createRefund(booking.stripePaymentIntentId, amountMinor, opts);
  }

  const captureId = booking.paypalCaptureId;
  if (!captureId) {
    throw new Error('Booking has no PayPal capture to refund');
  }
  if (String(booking.paymentStatus || '').toUpperCase() === 'REFUNDED') {
    throw new Error('Booking is already refunded');
  }

  const grossMinor = Math.round(Number(booking.grossAmount || 0) * 100);
  if (amountMinor !== null && amountMinor !== undefined) {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > grossMinor) {
      throw new Error(`Refund amount must be between 1 and ${grossMinor} minor units`);
    }
  }

  const currency = String(booking.currency || 'USD').toUpperCase();
  const reason = opts?.metadata?.reason || 'booking_refund';
  const idempotencyKey = opts?.idempotencyKey
    || `paypal-refund-${booking.id}-${amountMinor ?? 'full'}-${reason}`;

  const { normalized } = await paypalPayments.refundCapture({
    captureId,
    amountMinor: amountMinor ?? null,
    currency,
    note: opts?.metadata?.reason ? `Refund for booking ${booking.bookingNumber || booking.id}` : null,
    invoiceId: booking.bookingNumber || booking.id,
    idempotencyKey,
  });

  const status = normalized.status === 'SUCCEEDED'
    ? 'succeeded'
    : normalized.status === 'PENDING'
      ? 'pending'
      : 'failed';

  // Track the refund even when it is still pending, so the reconciliation sweep
  // can settle it later without re-issuing the instruction.
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      paypalRefundId: normalized.refundId,
      paypalRefundStatus: normalized.status,
    },
  }).catch((err) => {
    console.error('[PayPal] Could not record refund on booking', booking.id, err.message);
  });

  return {
    id: normalized.refundId,
    provider: 'PAYPAL',
    status,
    amount: normalized.amountMinor,
    currency: currency.toLowerCase(),
    raw: normalized,
  };
}

module.exports = {
  // selection
  resolveProvider,
  paypalConfig,
  isPaypalConfigured,
  paypalBrandAllowed,
  // payments
  paypal: paypalPayments,
  startPaypalCheckout,
  captureAndSettlePaypal,
  getPaypalApproval,
  capabilities,
  settlePaypalOrder,
  refundBookingPayment,
  normalize,
};
