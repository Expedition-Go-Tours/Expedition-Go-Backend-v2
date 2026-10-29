/**
 * PayPal → internal payment shape.
 *
 * The rest of the booking pipeline already speaks Stripe: amounts in minor
 * units, a session-like object with `amount_total` and `currency`, and a
 * provider reference it can refund against. Normalising here keeps PayPal
 * details out of checkoutHold, reconciliation and the refund call sites.
 */

const ORDER_STATUS = {
  CREATED: 'PENDING',
  SAVED: 'PENDING',
  PAYER_ACTION_REQUIRED: 'PROCESSING',
  APPROVED: 'PROCESSING',
  VOIDED: 'CANCELLED',
  COMPLETED: 'SUCCEEDED',
};

const CAPTURE_STATUS = {
  COMPLETED: 'SUCCEEDED',
  PENDING: 'PROCESSING',
  DECLINED: 'FAILED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'REFUNDED',
};

const REFUND_STATUS = {
  COMPLETED: 'SUCCEEDED',
  PENDING: 'PENDING',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

/**
 * Decimal string → integer minor units, without floating-point arithmetic.
 * PayPal sends "900.00"; `Number("900.00") * 100` happens to work for most
 * values but drifts for others, and money must not depend on that luck.
 */
function toMinorUnits(value) {
  const raw = String(value ?? '').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid money value: ${raw}`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = (match[3] || '').padEnd(2, '0');
  return sign * (whole * 100 + Number(fraction));
}

function fromMinorUnits(minor) {
  const value = Number(minor);
  if (!Number.isInteger(value)) {
    throw new Error(`Minor units must be an integer, got ${minor}`);
  }
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function amountOf(entity) {
  const amount = entity?.amount || entity?.seller_receivable_breakdown?.gross_amount || null;
  if (!amount || amount.value === undefined) {
    throw new Error('PayPal payload is missing an amount');
  }
  return {
    amountMinor: toMinorUnits(amount.value),
    currency: String(amount.currency_code || '').toUpperCase(),
  };
}

function paymentChannel(order) {
  const source = order?.payment_source;
  if (!source || typeof source !== 'object') return null;
  const key = Object.keys(source)[0] || null;
  if (key === 'card') {
    return source.card?.brand ? `CARD:${String(source.card.brand).toUpperCase()}` : 'CARD';
  }
  return key ? String(key).toUpperCase() : null;
}

function normalizeOrder(order) {
  if (!order || !order.id) throw new Error('PayPal order payload is missing an id');
  const unit = Array.isArray(order.purchase_units) ? order.purchase_units[0] : null;
  const { amountMinor, currency } = amountOf(unit);
  return {
    provider: 'PAYPAL',
    orderId: order.id,
    status: ORDER_STATUS[order.status] || 'PENDING',
    paypalStatus: order.status || null,
    amountMinor,
    currency,
    draftId: unit?.custom_id || unit?.reference_id || null,
    invoiceId: unit?.invoice_id || null,
    channel: paymentChannel(order),
    payerEmail: order.payer?.email_address || null,
    payerName: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(' ') || null,
    createTime: order.create_time || null,
  };
}

/**
 * Pick the capture that actually holds the money. An order can carry several
 * captures after a partial refund or a split shipment; the first COMPLETED one
 * is the payment this booking was settled with.
 */
function captureFromOrder(order) {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  for (const unit of units) {
    const captures = unit?.payments?.captures;
    if (!Array.isArray(captures)) continue;
    const completed = captures.find((capture) => capture?.status === 'COMPLETED');
    if (completed) return completed;
  }
  for (const unit of units) {
    const captures = unit?.payments?.captures;
    if (Array.isArray(captures) && captures.length) return captures[0];
  }
  return null;
}

function normalizeCapture(order, capture = captureFromOrder(order)) {
  if (!order || !order.id) throw new Error('PayPal order payload is missing an id');
  if (!capture || !capture.id) {
    throw new Error(`PayPal order ${order.id} has no capture`);
  }
  const orderShape = normalizeOrder(order);
  // A capture echoed back by the capture RESPONSE can omit `amount` (observed
  // live). The order's purchase unit always carries it, and this integration
  // only ever captures the full amount, so the unit amount IS the captured
  // amount. Anything else — a partial capture — carries its own amount and is
  // never inferred.
  const captureHasAmount = capture.amount && capture.amount.value !== undefined;
  const { amountMinor, currency } = captureHasAmount
    ? amountOf(capture)
    : { amountMinor: orderShape.amountMinor, currency: orderShape.currency };
  return {
    ...orderShape,
    captureId: capture.id,
    captureStatus: capture.status || null,
    status: CAPTURE_STATUS[capture.status] || 'PENDING',
    // The capture amount is authoritative for what was actually collected.
    amountMinor,
    currency,
    sellerProtection: capture.seller_protection?.status || null,
    createTime: capture.create_time || orderShape.createTime,
  };
}

/**
 * `fallback` carries the amount we know from the request when PayPal's response
 * omits it — a partial refund always has one, a full refund gets it from the
 * capture. Without either we still refuse to guess.
 */
function normalizeRefund(refund, fallback = null) {
  if (!refund || !refund.id) throw new Error('PayPal refund payload is missing an id');
  const hasAmount = refund.amount && refund.amount.value !== undefined;
  const { amountMinor, currency } = hasAmount
    ? amountOf(refund)
    : fallback && fallback.amountMinor !== undefined
      ? { amountMinor: fallback.amountMinor, currency: String(fallback.currency || 'USD').toUpperCase() }
      : amountOf(refund);
  return {
    provider: 'PAYPAL',
    refundId: refund.id,
    status: REFUND_STATUS[refund.status] || 'PENDING',
    paypalStatus: refund.status || null,
    amountMinor,
    currency,
    captureId: refund.links?.find((link) => /captures\//.test(link.href || ''))?.href?.split('/captures/')[1] || null,
    createTime: refund.create_time || null,
  };
}

/**
 * Stripe-shaped view used by materializeHold. Keeping this adapter tiny is the
 * point: the hold code should not learn a second provider's vocabulary.
 */
function toSettlementSession(payment) {
  return {
    id: payment.orderId,
    amount_total: payment.amountMinor,
    currency: payment.currency,
  };
}

module.exports = {
  ORDER_STATUS,
  CAPTURE_STATUS,
  REFUND_STATUS,
  toMinorUnits,
  fromMinorUnits,
  normalizeOrder,
  normalizeCapture,
  normalizeRefund,
  captureFromOrder,
  toSettlementSession,
};
