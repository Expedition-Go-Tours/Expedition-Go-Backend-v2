const { sanitizeBookingPaymentInternals, STRIP_KEYS } = require('../../utils/sanitizeBookings');

describe('sanitizeBookingPaymentInternals', () => {
  it('strips payment-internal ids from a single booking', () => {
    const booking = {
      id: 'b1',
      bookingNumber: 'TV-1234',
      stripePaymentIntentId: 'pi_123',
      stripeCheckoutSessionId: 'cs_123',
      customerId: 'c1',
      grossAmount: 100,
    };
    const out = sanitizeBookingPaymentInternals(booking);
    expect(out.id).toBe('b1');
    expect(out.bookingNumber).toBe('TV-1234');
    expect(out.stripePaymentIntentId).toBeUndefined();
    expect(out.stripeCheckoutSessionId).toBeUndefined();
    expect(STRIP_KEYS).toContain('stripePaymentIntentId');
  });

  it('strips ids from an array of bookings and preserves other fields', () => {
    const bookings = [
      { id: 'a', stripePaymentIntentId: 'pi_a' },
      { id: 'b', stripeCheckoutSessionId: 'cs_b' },
    ];
    const out = sanitizeBookingPaymentInternals(bookings);
    expect(out[0].stripePaymentIntentId).toBeUndefined();
    expect(out[1].stripeCheckoutSessionId).toBeUndefined();
    expect(out[0].id).toBe('a');
    expect(out[1].id).toBe('b');
  });

  it('does not mutate nested relations or null values', () => {
    const booking = { id: 'x', tour: { title: 'Tour' }, stripePaymentIntentId: 'pi_x' };
    const out = sanitizeBookingPaymentInternals(booking);
    expect(out.tour.title).toBe('Tour');
    expect(sanitizeBookingPaymentInternals(null)).toBeNull();
    expect(sanitizeBookingPaymentInternals(undefined)).toBeUndefined();
  });
});
