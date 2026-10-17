/**
 * GA4 Measurement Protocol — server-side purchase and refund reporting.
 *
 * The storefront can only report what the browser sees; a booking is settled by
 * a Stripe webhook (or a pay-later sweep / admin "charge now") long after the
 * customer's tab closed. So the money events are reported here, from the single
 * exactly-once settlement hook `notifyBookingsSettled()` and the refund
 * branches of `stripeHelpers.js`.
 *
 * The Measurement Protocol has no Consent Mode: there is no cookie and no
 * client-side signal. Consent is therefore re-checked against the choice stored
 * on the booking (`analyticsConsent`) and the visitor's GA4 `client_id`
 * (`gaClientId`) must be present. A booking with no consent, or made before
 * this was captured, is silently skipped — no event is ever sent.
 *
 * Safe by design, like discordNotifier:
 *  - No-op (resolves immediately) when GA4_MEASUREMENT_ID / GA4_API_SECRET unset.
 *  - Never throws — every failure is caught and logged.
 *  - Fire-and-forget: callers do not await, and a slow/blocked GA can never
 *    delay or fail a settled booking.
 *
 * Required env (see .env.example):
 *   GA4_MEASUREMENT_ID=G-XXXXXXXXXX
 *   GA4_API_SECRET=<Measurement Protocol API secret>
 *
 * Docs: https://developers.google.com/analytics/devguides/collection/protocol/ga4
 */

const MEASUREMENT_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const REQUEST_TIMEOUT_MS = 5000;

/** Measurement Protocol is only usable when both the id and the secret are set. */
function isEnabled() {
  return Boolean(process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET);
}

/** Money must be a finite, non-negative number before it reaches GA. */
function toAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : null;
}

/**
 * The consent + identity gate shared by every event. Returns the client_id when
 * the booking may be reported, otherwise null. Never throws.
 */
function resolveClientId(booking) {
  if (!booking) return null;
  if (booking.analyticsConsent !== true) return null;
  const clientId = typeof booking.gaClientId === 'string' ? booking.gaClientId.trim() : '';
  return clientId || null;
}

/**
 * GA4 ecommerce item for a booking. `quantity` is 1 and the whole booking value
 * sits on `price` so `value` and the item total always reconcile.
 */
function buildItem(booking, amount) {
  return {
    item_id: booking.tourId || booking.id,
    item_name: booking.tour?.title || 'Tour booking',
    price: amount,
    quantity: 1,
  };
}

/**
 * Pure builders — the event body for a settled booking and for a refund. Kept
 * separate from transport so they can be asserted without network mocking.
 * Both return null when the booking must not be reported.
 */
function buildPurchaseEvent(booking) {
  const clientId = resolveClientId(booking);
  if (!clientId) return null;
  const value = toAmount(booking.grossAmount);
  if (value === null) return null;

  return {
    client_id: clientId,
    events: [
      {
        name: 'purchase',
        params: {
          transaction_id: booking.bookingNumber,
          currency: booking.currency || 'USD',
          value,
          // 'later' distinguishes a deferred reservation charge from a pay-now
          // purchase without needing a separate revenue event.
          payment_timing: booking.paymentTiming === 'later' ? 'later' : 'now',
          items: [buildItem(booking, value)],
        },
      },
    ],
  };
}

function buildRefundEvent(booking, valueOverride) {
  const clientId = resolveClientId(booking);
  if (!clientId) return null;
  // The triggering refund's own amount (from the charge) wins; otherwise fall
  // back to the booking's stored refundAmount, then the original total.
  const raw = valueOverride != null
    ? valueOverride
    : (booking.refundAmount != null ? booking.refundAmount : booking.grossAmount);
  const value = toAmount(raw);
  if (value === null || value <= 0) return null;

  return {
    client_id: clientId,
    events: [
      {
        name: 'refund',
        params: {
          transaction_id: booking.bookingNumber,
          currency: booking.currency || 'USD',
          value,
        },
      },
    ],
  };
}

/** POST one Measurement Protocol body. Always resolves; never throws. */
async function deliver(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${MEASUREMENT_ENDPOINT}?measurement_id=${encodeURIComponent(process.env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(process.env.GA4_API_SECRET)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[ga4Measurement] HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.error(`[ga4Measurement] send failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report a settled booking as a purchase. Fire-and-forget.
 * @param {object} booking a booking with gaClientId + analyticsConsent + tour included
 */
function sendPurchase(booking) {
  if (!isEnabled()) return Promise.resolve();
  const body = buildPurchaseEvent(booking);
  if (!body) return Promise.resolve();
  return deliver(body);
}

/**
 * Report a refund against the original purchase (matched by transaction_id).
 * Fire-and-forget.
 * @param {object} booking a booking with gaClientId + analyticsConsent + tour included
 * @param {{ value?: number }} [opts] explicit refund amount (major units) when the
 *   booking row does not yet carry it (e.g. reported straight from the charge)
 */
function sendRefund(booking, { value } = {}) {
  if (!isEnabled()) return Promise.resolve();
  const body = buildRefundEvent(booking, value);
  if (!body) return Promise.resolve();
  return deliver(body);
}

module.exports = {
  buildPurchaseEvent,
  buildRefundEvent,
  sendPurchase,
  sendRefund,
  isEnabled,
};
