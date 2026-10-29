/**
 * Provider selection.
 *
 * Stripe is the default and the fallback. Every precondition PayPal needs is
 * checked here, so a half-configured deploy can never strand a customer on a
 * provider we cannot finish the payment with.
 */

const {
  paypalConfig,
  paypalAvailability,
  paymentCapabilities,
  isPaypalConfigured,
  assertPaypalConfigured,
  assertPaypalWebhookConfigured,
  paypalBrandAllowed,
  resolveProvider,
} = require('../../../src/core/services/payments/config');

const ENV_KEYS = [
  'PAYPAL_ENABLED',
  'PAYPAL_MODE',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'PAYPAL_BRANDS',
];

let saved;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function configure(over = {}) {
  process.env.PAYPAL_ENABLED = 'true';
  process.env.PAYPAL_CLIENT_ID = 'client-id';
  process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
  process.env.PAYPAL_BRANDS = 'ghana,expedition';
  process.env.PAYPAL_MODE = 'sandbox';
  Object.assign(process.env, over);
}

describe('paypalConfig', () => {
  it('defaults to disabled sandbox with USD only', () => {
    const config = paypalConfig();
    expect(config.enabled).toBe(false);
    expect(config.mode).toBe('sandbox');
    expect(config.baseUrl).toBe('https://api-m.sandbox.paypal.com');
    expect([...config.currencies]).toEqual(['USD']);
    expect(config.brands).toEqual([]);
  });

  it('switches to the live host only for PAYPAL_MODE=live', () => {
    configure({ PAYPAL_MODE: 'live' });
    expect(paypalConfig().baseUrl).toBe('https://api-m.paypal.com');
  });

  it('treats anything that is not exactly "true" as off', () => {
    configure({ PAYPAL_ENABLED: 'yes' });
    expect(paypalConfig().enabled).toBe(false);
    configure({ PAYPAL_ENABLED: 'TRUE' });
    expect(paypalConfig().enabled).toBe(true);
  });

  it('normalises the brand allowlist', () => {
    configure({ PAYPAL_BRANDS: ' Ghana , EXPEDITION ,, africa ' });
    expect(paypalConfig().brands).toEqual(['ghana', 'expedition', 'africa']);
  });
});

describe('credential guards', () => {
  it('reports configured only when both credentials exist', () => {
    expect(isPaypalConfigured()).toBe(false);
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    expect(isPaypalConfigured()).toBe(false);
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    expect(isPaypalConfigured()).toBe(true);
  });

  it('does not require the feature flag to be enabled', () => {
    // Webhooks and in-flight captures must keep working with new checkouts off.
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    expect(() => assertPaypalConfigured()).not.toThrow();
  });

  it('names the missing variables', () => {
    expect(() => assertPaypalConfigured()).toThrow(/PAYPAL_CLIENT_ID/);
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    expect(() => assertPaypalWebhookConfigured()).toThrow(/PAYPAL_WEBHOOK_ID/);
  });
});

describe('paypalBrandAllowed', () => {
  it('matches the enrolled brands only', () => {
    configure();
    expect(paypalBrandAllowed('ghana')).toBe(true);
    expect(paypalBrandAllowed('africa')).toBe(false);
    expect(paypalBrandAllowed('')).toBe(false);
    expect(paypalBrandAllowed(null)).toBe(false);
  });
});

describe('paypalAvailability', () => {
  it('reports WHY it is unavailable, not just that it is', () => {
    configure({ PAYPAL_ENABLED: 'false' });
    expect(paypalAvailability({ brand: 'ghana', currency: 'USD' }).reason).toBe('disabled');

    configure({ PAYPAL_CLIENT_SECRET: '' });
    expect(paypalAvailability({ brand: 'ghana', currency: 'USD' }).reason).toBe('not_configured');

    configure();
    expect(paypalAvailability({ brand: 'africa', currency: 'USD' }).reason).toBe('brand_not_enabled');
    expect(paypalAvailability({ brand: 'ghana', currency: 'GHS' }).reason).toBe('unsupported_currency');
    expect(paypalAvailability({ brand: 'ghana', currency: 'USD', paymentTiming: 'later' }).reason)
      .toBe('unsupported_timing');
    expect(paypalAvailability({ brand: 'ghana', currency: 'USD' })).toEqual({ available: true, reason: null });
  });

  it('is exactly what resolveProvider would honour — no drift between the two', () => {
    const cases = [
      { brand: 'ghana', currency: 'USD' },
      { brand: 'africa', currency: 'USD' },
      { brand: 'ghana', currency: 'EUR' },
      { brand: 'ghana', currency: 'USD', paymentTiming: 'later' },
    ];
    for (const over of cases) {
      configure();
      const available = paypalAvailability(over).available;
      expect(resolveProvider({ requested: 'paypal', ...over })).toBe(available ? 'paypal' : 'stripe');
    }
  });
});

describe('paymentCapabilities', () => {
  it('advertises PayPal for an enrolled brand with USD credentials present', () => {
    configure();
    const caps = paymentCapabilities({ brand: 'ghana' });
    expect(caps.paypal).toMatchObject({ available: true, reason: null, currencies: ['USD'] });
    expect(caps.stripe.available).toBe(Boolean(process.env.STRIPE_SECRET_KEY));
  });

  it('reports unavailable, with a reason, when the feature is off', () => {
    configure({ PAYPAL_ENABLED: 'false' });
    expect(paymentCapabilities({ brand: 'ghana' }).paypal)
      .toMatchObject({ available: false, reason: 'disabled' });
  });

  it('never leaks credentials', () => {
    configure();
    const serialized = JSON.stringify(paymentCapabilities({ brand: 'ghana' }));
    expect(serialized).not.toContain('client-id');
    expect(serialized).not.toContain('client-secret');
  });

  it('agrees with resolveProvider for the same inputs', () => {
    configure();
    const caps = paymentCapabilities({ brand: 'ghana', currency: 'USD' });
    expect(resolveProvider({ requested: 'paypal', brand: 'ghana', currency: 'USD' }))
      .toBe(caps.paypal.available ? 'paypal' : 'stripe');
  });
});

describe('resolveProvider', () => {
  it('returns stripe when nothing is requested', () => {
    configure();
    expect(resolveProvider({ brand: 'ghana', currency: 'USD' })).toBe('stripe');
    expect(resolveProvider({ requested: 'stripe', brand: 'ghana', currency: 'USD' })).toBe('stripe');
    expect(resolveProvider({ requested: 'klarna', brand: 'ghana', currency: 'USD' })).toBe('stripe');
  });

  it('returns paypal when every precondition holds', () => {
    configure();
    expect(resolveProvider({
      requested: 'paypal',
      brand: 'ghana',
      currency: 'USD',
      paymentTiming: 'now',
    })).toBe('paypal');
  });

  it('falls back to stripe when the feature is off', () => {
    configure({ PAYPAL_ENABLED: 'false' });
    expect(resolveProvider({ requested: 'paypal', brand: 'ghana', currency: 'USD' })).toBe('stripe');
  });

  it('falls back to stripe when credentials are missing', () => {
    configure({ PAYPAL_CLIENT_SECRET: '' });
    expect(resolveProvider({ requested: 'paypal', brand: 'ghana', currency: 'USD' })).toBe('stripe');
  });

  it('falls back to stripe for a brand that is not enrolled', () => {
    configure();
    expect(resolveProvider({ requested: 'paypal', brand: 'africa', currency: 'USD' })).toBe('stripe');
  });

  it('falls back to stripe for currencies we cannot quote', () => {
    configure();
    expect(resolveProvider({ requested: 'paypal', brand: 'ghana', currency: 'GHS' })).toBe('stripe');
    expect(resolveProvider({ requested: 'paypal', brand: 'ghana', currency: 'EUR' })).toBe('stripe');
  });

  it('accepts a lowercase currency code', () => {
    configure();
    expect(resolveProvider({ requested: 'paypal', brand: 'ghana', currency: 'usd' })).toBe('paypal');
  });

  it('never offers pay-later through PayPal', () => {
    configure();
    expect(resolveProvider({
      requested: 'paypal',
      brand: 'ghana',
      currency: 'USD',
      paymentTiming: 'later',
    })).toBe('stripe');
  });
});
