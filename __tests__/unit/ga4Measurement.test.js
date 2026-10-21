/**
 * GA4 Measurement Protocol reporting.
 *
 * The money events are sent from the backend on settlement/refund, so these
 * tests pin the two things that keep that safe: nothing is sent without the
 * Measurement Protocol credentials AND the visitor's analytics consent + a GA4
 * client_id, and the event bodies carry the fields GA4 needs to attribute
 * revenue to a booking (transaction_id, value, currency, items).
 */

const {
  buildPurchaseEvent,
  buildRefundEvent,
  sendPurchase,
  sendRefund,
  isEnabled,
  isPlausibleApiSecret,
} = require('../../src/core/services/ga4Measurement');

const baseBooking = {
  bookingNumber: 'GH-12345',
  tourId: 'tour_abc',
  tour: { id: 'tour_abc', title: 'Cape Coast Castle Tour' },
  currency: 'GHS',
  grossAmount: 120.5,
  paymentTiming: 'now',
  gaClientId: '1234567890.1700000000',
  analyticsConsent: true,
};

describe('ga4Measurement', () => {
  const realFetch = global.fetch;
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    delete process.env.GA4_MEASUREMENT_ID;
    delete process.env.GA4_API_SECRET;
    // Every outcome now logs one line; silence it unless a test re-arms the
    // spy with mockImplementation to capture.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  describe('isEnabled', () => {
    it('requires both the measurement id and the api secret', () => {
      expect(isEnabled()).toBe(false);
      process.env.GA4_MEASUREMENT_ID = 'G-TEST';
      expect(isEnabled()).toBe(false);
      process.env.GA4_API_SECRET = 'secret';
      expect(isEnabled()).toBe(true);
    });
  });

  describe('api secret shape guard', () => {
    // The incident: the numeric data-stream ID was pasted as the secret. GA
    // answers 204 for it, so nothing ever failed and revenue stayed at zero.
    it('rejects the numeric data-stream ID', () => {
      expect(isPlausibleApiSecret('16142161530')).toBe(false);
    });

    it('rejects any all-digit value regardless of length', () => {
      expect(isPlausibleApiSecret('12345678901234567890')).toBe(false);
    });

    it('rejects missing, empty or truncated values', () => {
      expect(isPlausibleApiSecret(undefined)).toBe(false);
      expect(isPlausibleApiSecret('')).toBe(false);
      expect(isPlausibleApiSecret('secret')).toBe(false);
    });

    it('accepts a generated API secret', () => {
      expect(isPlausibleApiSecret('6Fb72ziwQdSz-pl0YLpHKA')).toBe(true);
    });

    it('shouts at boot when the configured secret is a stream id', () => {
      process.env.GA4_MEASUREMENT_ID = 'G-TEST';
      process.env.GA4_API_SECRET = '16142161530';
      const calls = [];
      errorSpy.mockImplementation((...args) => calls.push(args.join(' ')));

      jest.isolateModules(() => {
        require('../../src/core/services/ga4Measurement');
      });

      expect(calls.join('\n')).toContain('looks like a data-stream ID');
    });

    it('stays quiet at boot for a plausible secret', () => {
      process.env.GA4_MEASUREMENT_ID = 'G-TEST';
      process.env.GA4_API_SECRET = '6Fb72ziwQdSz-pl0YLpHKA';
      const calls = [];
      errorSpy.mockImplementation((...args) => calls.push(args.join(' ')));

      jest.isolateModules(() => {
        require('../../src/core/services/ga4Measurement');
      });

      expect(calls).toEqual([]);
    });
  });

  describe('buildPurchaseEvent', () => {
    it('builds a purchase with transaction_id, value, currency and an item', () => {
      const body = buildPurchaseEvent(baseBooking);
      expect(body.client_id).toBe('1234567890.1700000000');
      const event = body.events[0];
      expect(event.name).toBe('purchase');
      expect(event.params.transaction_id).toBe('GH-12345');
      expect(event.params.currency).toBe('GHS');
      expect(event.params.value).toBe(120.5);
      expect(event.params.payment_timing).toBe('now');
      expect(event.params.items[0]).toMatchObject({
        item_id: 'tour_abc',
        item_name: 'Cape Coast Castle Tour',
        price: 120.5,
        quantity: 1,
      });
    });

    it('marks a deferred reservation charge as payment_timing=later', () => {
      const body = buildPurchaseEvent({ ...baseBooking, paymentTiming: 'later' });
      expect(body.events[0].params.payment_timing).toBe('later');
    });

    it('returns null without analytics consent', () => {
      expect(buildPurchaseEvent({ ...baseBooking, analyticsConsent: false })).toBeNull();
      expect(buildPurchaseEvent({ ...baseBooking, analyticsConsent: null })).toBeNull();
      expect(buildPurchaseEvent({ ...baseBooking, analyticsConsent: undefined })).toBeNull();
    });

    it('returns null without a client_id', () => {
      expect(buildPurchaseEvent({ ...baseBooking, gaClientId: null })).toBeNull();
      expect(buildPurchaseEvent({ ...baseBooking, gaClientId: '   ' })).toBeNull();
    });

    it('returns null when the total is not a usable amount', () => {
      expect(buildPurchaseEvent({ ...baseBooking, grossAmount: 'not-a-number' })).toBeNull();
      expect(buildPurchaseEvent({ ...baseBooking, grossAmount: -5 })).toBeNull();
    });
  });

  describe('buildRefundEvent', () => {
    it('uses the booking refundAmount when present', () => {
      const body = buildRefundEvent({ ...baseBooking, refundAmount: 60 });
      const event = body.events[0];
      expect(event.name).toBe('refund');
      expect(event.params.transaction_id).toBe('GH-12345');
      expect(event.params.value).toBe(60);
    });

    it('honours an explicit value override (per-refund amount from the charge)', () => {
      const body = buildRefundEvent({ ...baseBooking, refundAmount: 60 }, 42.25);
      expect(body.events[0].params.value).toBe(42.25);
    });

    it('falls back to the original total when no refund amount is stored', () => {
      const body = buildRefundEvent({ ...baseBooking, refundAmount: null });
      expect(body.events[0].params.value).toBe(120.5);
    });

    it('returns null without consent or an amount', () => {
      expect(buildRefundEvent({ ...baseBooking, analyticsConsent: false })).toBeNull();
      expect(buildRefundEvent({ ...baseBooking, grossAmount: 0, refundAmount: null })).toBeNull();
    });
  });

  describe('sendPurchase / sendRefund transport', () => {
    it('does not call the network when disabled', async () => {
      global.fetch = jest.fn();
      await sendPurchase(baseBooking);
      await sendRefund(baseBooking);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('posts a purchase to the Measurement Protocol endpoint', async () => {
      process.env.GA4_MEASUREMENT_ID = 'G-TEST';
      process.env.GA4_API_SECRET = 'secret';
      global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });

      await sendPurchase(baseBooking);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toContain('measurement_id=G-TEST');
      expect(url).toContain('api_secret=secret');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body).events[0].name).toBe('purchase');
    });

    it('never throws when the network fails', async () => {
      process.env.GA4_MEASUREMENT_ID = 'G-TEST';
      process.env.GA4_API_SECRET = 'secret';
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

      await expect(sendPurchase(baseBooking)).resolves.toBeUndefined();
    });
  });

  describe('observability: every outcome leaves exactly one log line', () => {
    let logs;
    let errors;

    beforeEach(() => {
      logs = [];
      errors = [];
      logSpy.mockImplementation((...args) => logs.push(args.join(' ')));
      errorSpy.mockImplementation((...args) => errors.push(args.join(' ')));
      process.env.GA4_MEASUREMENT_ID = 'G-TEST';
      process.env.GA4_API_SECRET = 'secret';
      global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });
    });

    const stream = (lines) => lines.join('\n');

    it('logs the sent line with booking, transaction and value on 2xx', async () => {
      await sendPurchase(baseBooking);
      expect(stream(logs)).toContain(
        '[ga4Measurement] purchase sent booking=GH-12345 tx=GH-12345 value=120.5 GHS'
      );
    });

    it('names a declined consent instead of dropping silently', async () => {
      await sendPurchase({ ...baseBooking, analyticsConsent: false });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(stream(logs)).toContain('purchase skipped booking=GH-12345 reason=no-consent');
    });

    it('separates never-captured attribution from a decline', async () => {
      await sendPurchase({ ...baseBooking, analyticsConsent: null, gaClientId: null });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(stream(logs)).toContain('purchase skipped booking=GH-12345 reason=no-attribution');
    });

    it('names a missing client_id when consent was granted', async () => {
      await sendPurchase({ ...baseBooking, gaClientId: null });
      expect(stream(logs)).toContain('reason=no-client-id');
    });

    it('names an unusable total when everything else is present', async () => {
      await sendPurchase({ ...baseBooking, grossAmount: 'not-a-number' });
      expect(stream(logs)).toContain('reason=no-amount');
    });

    it('shouts not-configured when the credentials are missing', async () => {
      delete process.env.GA4_MEASUREMENT_ID; // the nested beforeEach above sets them
      delete process.env.GA4_API_SECRET;
      await sendPurchase(baseBooking);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(stream(logs)).toContain('purchase skipped booking=GH-12345 reason=not-configured');
    });

    it('reports refund outcomes the same way', async () => {
      await sendRefund({ ...baseBooking, analyticsConsent: false });
      expect(stream(logs)).toContain('refund skipped booking=GH-12345 reason=no-consent');
    });

    it('keeps the HTTP status and booking ref when GA rejects the send', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad payload' });
      await sendPurchase(baseBooking);
      expect(stream(errors)).toContain('purchase send failed booking=GH-12345 HTTP 400');
    });

    it('never logs customer PII, only the booking reference', async () => {
      await sendPurchase({
        ...baseBooking,
        customer: { name: 'Kwame Testerson', email: 'kwame@example.com' },
        leadTravelerEmail: 'kwame@example.com',
      });
      const all = stream(logs) + stream(errors);
      expect(all).not.toContain('kwame@example.com');
      expect(all).not.toContain('Kwame Testerson');
      expect(all).toContain('booking=GH-12345');
    });
  });

  describe('historical backfill (timestamp override)', () => {
    beforeEach(() => {
      process.env.GA4_MEASUREMENT_ID = 'G-TEST';
      process.env.GA4_API_SECRET = 'secret';
      global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });
    });

    it('stamps timestamp_micros on the event when the caller supplies the settle time', async () => {
      await sendPurchase(baseBooking, { timestampMicros: 1760880000000000 });

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.events[0].name).toBe('purchase');
      expect(body.events[0].params.timestamp_micros).toBe(1760880000000000);
    });

    it('omits timestamp_micros for live sends so GA uses server time', async () => {
      await sendPurchase(baseBooking);

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.events[0].params.timestamp_micros).toBeUndefined();
    });

    it('stamps refunds too', async () => {
      await sendRefund(baseBooking, { value: 40, timestampMicros: 1760880000000000 });

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.events[0].name).toBe('refund');
      expect(body.events[0].params.timestamp_micros).toBe(1760880000000000);
    });
  });
});
