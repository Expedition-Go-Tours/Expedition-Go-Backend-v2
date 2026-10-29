/**
 * PayPal payment operations.
 *
 * Thin business layer over paypalClient: create an order, capture it, read it
 * back, refund a capture, verify a webhook. Every mutating call takes an
 * idempotency key so a retry can never move money twice.
 */

const { request, PayPalApiError } = require('./paypalClient');
const { assertPaypalConfigured, assertPaypalWebhookConfigured } = require('./config');
const {
  fromMinorUnits,
  normalizeOrder,
  normalizeCapture,
  normalizeRefund,
  captureFromOrder,
  toMinorUnits,
} = require('./normalize');

const MAX_DESCRIPTION = 127;
const MAX_INVOICE_ID = 127;

function clamp(value, max) {
  return String(value || '').slice(0, max);
}

/**
 * Create a PayPal order and return the URL the customer must be sent to.
 *
 * `application_context` is used rather than `payment_source.paypal` because it
 * carries the return/cancel URLs without narrowing the funding sources PayPal
 * offers on its own page.
 */
async function createOrder({
  draftId,
  amountMinor,
  currency,
  description,
  brandName,
  returnUrl,
  cancelUrl,
  idempotencyKey,
}) {
  const config = assertPaypalConfigured();
  if (!draftId) throw new Error('createOrder requires a draftId');
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`createOrder requires a positive integer amount, got ${amountMinor}`);
  }

  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: clamp(draftId, MAX_INVOICE_ID),
        custom_id: clamp(draftId, MAX_INVOICE_ID),
        invoice_id: clamp(draftId, MAX_INVOICE_ID),
        description: clamp(description || 'Travio booking', MAX_DESCRIPTION),
        amount: {
          currency_code: String(currency || 'USD').toUpperCase(),
          value: fromMinorUnits(amountMinor),
        },
      },
    ],
    application_context: {
      brand_name: clamp(brandName || 'Travio', MAX_DESCRIPTION),
      locale: 'en-US',
      landing_page: 'LOGIN',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  };

  const order = await request('/v2/checkout/orders', {
    method: 'POST',
    body,
    idempotencyKey: idempotencyKey || `paypal-order-${draftId}`,
    config,
  });

  const links = Array.isArray(order?.links) ? order.links : [];
  const approval = links.find((link) => link.rel === 'payer-action')
    || links.find((link) => link.rel === 'approve');

  if (!approval?.href) {
    throw new PayPalApiError('PayPal did not return an approval link', {
      code: 'MISSING_APPROVAL_LINK',
      retriable: false,
      requestId: order?.id || null,
    });
  }

  return {
    provider: 'PAYPAL',
    orderId: order.id,
    status: order.status,
    approvalUrl: approval.href,
    raw: order,
  };
}

async function getOrder(orderId) {
  const config = assertPaypalConfigured();
  if (!orderId) throw new Error('getOrder requires an order id');
  const order = await request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { config });
  return { order, normalized: normalizeOrder(order) };
}

/**
 * Capture an approved order.
 *
 * PayPal treats `PayPal-Request-Id` as an idempotency key, so a retry after a
 * network timeout returns the original result instead of charging twice. If the
 * order was already captured (a race with another worker or a customer refresh),
 * the order is read back rather than treated as an error.
 */
async function captureOrder(orderId, { idempotencyKey } = {}) {
  const config = assertPaypalConfigured();
  if (!orderId) throw new Error('captureOrder requires an order id');
  if (!idempotencyKey) throw new Error('captureOrder requires an idempotency key');

  // The POST is the ACTION; the GET is the source of truth.
  //
  // PayPal's capture response is a thin acknowledgement whose capture object
  // does not reliably carry `amount` — seen live, for both COMPLETED and
  // PENDING captures — which made normalisation throw *after* the money had
  // already moved (the webhook then settled it, but the browser got a 500).
  // Reading the order back costs one extra call and always returns the full
  // capture, so every caller normalises the same authoritative shape.
  let posted = null;
  try {
    posted = await request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      body: {},
      idempotencyKey,
      config,
    });
  } catch (err) {
    const alreadyCaptured = err instanceof PayPalApiError
      && /ORDER_ALREADY_CAPTURED/i.test(String(err.code || ''));
    // Anything else is a real failure (not approved, instrument declined, …)
    // and must surface to the caller — never be mistaken for a payment.
    if (!alreadyCaptured) throw err;
  }

  let order = posted;
  try {
    ({ order } = await getOrder(orderId));
  } catch (err) {
    // The capture already happened; never lose it because a read failed. The
    // posted body is a valid fallback thanks to normalizeCapture's amount
    // fallback, and the webhook will settle regardless.
    if (!order) throw err;
    console.warn('[PayPal] Could not re-read order after capture, using capture response:', orderId, err.message);
  }

  return { order, capture: normalizeCapture(order) };
}

/**
 * Read an order and return its capture. Used by the webhook and the sweeps so
 * the decision is always based on PayPal's current state, never on a payload
 * we received.
 */
async function readCapture(orderId) {
  const { order, normalized } = await getOrder(orderId);
  const rawCapture = captureFromOrder(order);
  if (!rawCapture) {
    return { order, orderNormalized: normalized, capture: null };
  }
  return { order, orderNormalized: normalized, capture: normalizeCapture(order, rawCapture) };
}

async function refundCapture({
  captureId,
  amountMinor = null,
  currency = 'USD',
  note = null,
  invoiceId = null,
  idempotencyKey,
}) {
  const config = assertPaypalConfigured();
  if (!captureId) throw new Error('refundCapture requires a capture id');
  if (!idempotencyKey) throw new Error('refundCapture requires an idempotency key');

  const body = {};
  if (amountMinor !== null && amountMinor !== undefined) {
    body.amount = {
      value: fromMinorUnits(amountMinor),
      currency_code: String(currency || 'USD').toUpperCase(),
    };
  }
  if (note) body.note_to_payer = clamp(note, 255);
  if (invoiceId) body.invoice_id = clamp(invoiceId, MAX_INVOICE_ID);

  const posted = await request(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST',
    body,
    idempotencyKey,
    config,
  });

  // Same rule as captureOrder: the POST is the action, a GET is the source of
  // truth. Live, the refund response came back without `amount`, which threw
  // AFTER PayPal had already refunded the customer.
  let refund = posted;
  if (posted?.id && !(posted.amount && posted.amount.value !== undefined)) {
    try {
      const fresh = await request(`/v2/payments/refunds/${encodeURIComponent(posted.id)}`, { config });
      if (fresh?.id) refund = fresh;
    } catch { /* keep the POST body; the fallbacks below cover the amount */ }
  }

  let fallback = amountMinor !== null && amountMinor !== undefined
    ? { amountMinor, currency }
    : null;
  if (!(refund.amount && refund.amount.value !== undefined) && !fallback) {
    // A full refund: the capture knows what it refunded.
    try {
      const capture = await request(`/v2/payments/captures/${encodeURIComponent(captureId)}`, { config });
      const refunded = capture?.seller_receivable_breakdown?.refunded_amount;
      if (refunded && refunded.value !== undefined) {
        fallback = { amountMinor: toMinorUnits(refunded.value), currency: refunded.currency_code };
      }
    } catch { /* leave the amount unknown — normalizeRefund will say so */ }
  }

  return { refund, normalized: normalizeRefund(refund, fallback) };
}

async function getRefund(refundId) {
  const config = assertPaypalConfigured();
  const refund = await request(`/v2/payments/refunds/${encodeURIComponent(refundId)}`, { config });
  return { refund, normalized: normalizeRefund(refund) };
}

/**
 * Verify a webhook delivery.
 *
 * PayPal does not HMAC-sign payloads. Verification is a round trip to PayPal's
 * API using the transmission headers, the configured webhook id and the exact
 * event body we received. Anything other than SUCCESS is rejected.
 */
async function verifyWebhookSignature(headers, event) {
  const config = assertPaypalWebhookConfigured();

  const transmissionId = headers['paypal-transmission-id'];
  const transmissionTime = headers['paypal-transmission-time'];
  const transmissionSig = headers['paypal-transmission-sig'];
  const certUrl = headers['paypal-cert-url'];
  const authAlgo = headers['paypal-auth-algo'];

  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    return { verified: false, reason: 'missing_transmission_headers' };
  }

  // The cert URL must be PayPal's, otherwise a forged header could point the
  // verification call at an attacker-controlled certificate endpoint.
  let certHost;
  try {
    certHost = new URL(certUrl).hostname;
  } catch {
    return { verified: false, reason: 'invalid_cert_url' };
  }
  if (certHost !== 'api.paypal.com' && certHost !== 'api.sandbox.paypal.com') {
    return { verified: false, reason: 'untrusted_cert_url' };
  }

  const payload = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: config.webhookId,
    webhook_event: event,
  };

  const result = await request('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: payload,
    config,
  });

  return {
    verified: result?.verification_status === 'SUCCESS',
    status: result?.verification_status || null,
  };
}

module.exports = {
  createOrder,
  getOrder,
  captureOrder,
  readCapture,
  refundCapture,
  getRefund,
  verifyWebhookSignature,
  toMinorUnits,
};
