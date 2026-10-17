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

  beforeEach(() => {
    delete process.env.GA4_MEASUREMENT_ID;
    delete process.env.GA4_API_SECRET;
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
});
