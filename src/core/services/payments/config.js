/**
 * Payment provider configuration and selection.
 *
 * PayPal is opt-in per environment, per brand and per payment shape. Everything
 * here degrades to Stripe when a condition is not met, so a missing env var or
 * a brand that has not been enrolled can never send a customer to a provider we
 * are not ready to support.
 */

const PAYPAL_BASE_URLS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

// PayPal charges in the currency it is told. We only ever quote USD because the
// whole catalogue is USD; anything else falls back to Stripe rather than
// silently converting.
const PAYPAL_SUPPORTED_CURRENCIES = new Set(['USD']);

function envFlag(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function brandList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function paypalConfig() {
  const mode = String(process.env.PAYPAL_MODE || 'sandbox').trim().toLowerCase() === 'live'
    ? 'live'
    : 'sandbox';

  return {
    enabled: envFlag(process.env.PAYPAL_ENABLED),
    mode,
    baseUrl: PAYPAL_BASE_URLS[mode],
    clientId: String(process.env.PAYPAL_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.PAYPAL_CLIENT_SECRET || '').trim(),
    webhookId: String(process.env.PAYPAL_WEBHOOK_ID || '').trim(),
    brands: brandList(process.env.PAYPAL_BRANDS),
    currencies: PAYPAL_SUPPORTED_CURRENCIES,
  };
}

function isPaypalConfigured(config = paypalConfig()) {
  return Boolean(config.clientId && config.clientSecret);
}

/**
 * Fail with an actionable message at the point of use. Webhook processing calls
 * this too: a live capture must still be verifiable even when new checkouts are
 * switched off, so this checks credentials only, never the `enabled` flag.
 */
function assertPaypalConfigured(config = paypalConfig()) {
  if (!isPaypalConfigured(config)) {
    throw new Error('PayPal is not configured: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');
  }
  return config;
}

function assertPaypalWebhookConfigured(config = paypalConfig()) {
  assertPaypalConfigured(config);
  if (!config.webhookId) {
    throw new Error('PayPal is not configured: PAYPAL_WEBHOOK_ID is required to verify webhooks');
  }
  return config;
}

function paypalBrandAllowed(brand, config = paypalConfig()) {
  const key = String(brand || '').trim().toLowerCase();
  return Boolean(key) && config.brands.includes(key);
}

/**
 * Every precondition PayPal needs, with the reason it is missing.
 *
 * This is the single source of truth for BOTH sides of the checkout: the
 * storefront asks it before showing the option, and `resolveProvider` asks it
 * before accepting the choice. Sharing one function is what stops the UI from
 * advertising a method the server would then quietly swap for Stripe.
 *
 * Ordering matters only for which `reason` is reported — the boolean result is
 * the AND of all conditions, so it is identical for every caller.
 */
function paypalAvailability({ brand, currency, paymentTiming } = {}, config = paypalConfig()) {
  if (!config.enabled) return { available: false, reason: 'disabled' };
  if (!isPaypalConfigured(config)) return { available: false, reason: 'not_configured' };
  if (String(paymentTiming || 'now') !== 'now') return { available: false, reason: 'unsupported_timing' };
  if (!paypalBrandAllowed(brand, config)) return { available: false, reason: 'brand_not_enabled' };
  if (!config.currencies.has(String(currency || '').toUpperCase())) {
    return { available: false, reason: 'unsupported_currency' };
  }
  return { available: true, reason: null };
}

/**
 * Decide who collects this payment.
 *
 * Stripe remains the default. PayPal is selected only when the caller asks for
 * it AND `paypalAvailability` says it is safe — including the pay-later rule
 * (reserve-now-pay-later needs an attachable card, which PayPal cannot provide
 * without Reference Transactions). An unknown `requested` value is treated as
 * Stripe rather than as an error so a stale client cannot break checkout.
 */
function resolveProvider({ requested, brand, currency = 'USD', paymentTiming } = {}) {
  const provider = String(requested || '').trim().toLowerCase();
  if (provider !== 'paypal') return 'stripe';
  // `currency` defaults to USD here for the same reason it does in
  // paymentCapabilities: an omitted currency must resolve identically on both
  // sides, or the UI could offer what checkout then refuses.
  return paypalAvailability({ brand, currency, paymentTiming }).available ? 'paypal' : 'stripe';
}

/**
 * What the storefront should offer right now, for a given brand/currency.
 * `paypal.available` is exactly what `resolveProvider` would honour.
 */
function paymentCapabilities({ brand, currency = 'USD', paymentTiming = 'now' } = {}) {
  const config = paypalConfig();
  const paypal = paypalAvailability({ brand, currency, paymentTiming }, config);
  return {
    stripe: { available: Boolean(String(process.env.STRIPE_SECRET_KEY || '').trim()) },
    paypal: {
      ...paypal,
      // Shown so the client can pick a currency, not as a hint about the money:
      // the catalogue is USD-only today.
      currencies: [...config.currencies],
      // Never expose credentials — the mode only tells the UI which sandbox
      // label to render in development.
      mode: config.mode,
    },
  };
}

module.exports = {
  PAYPAL_BASE_URLS,
  paypalConfig,
  isPaypalConfigured,
  assertPaypalConfigured,
  assertPaypalWebhookConfigured,
  paypalBrandAllowed,
  paypalAvailability,
  paymentCapabilities,
  resolveProvider,
};
