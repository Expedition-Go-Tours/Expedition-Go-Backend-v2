/**
 * Money-side reconciliation.
 *
 * A successful charge that settles no booking must be refunded only when the
 * persisted booking state proves it is terminal, duplicated, too late, or for
 * the wrong amount. Never refund the same money twice.
 */
jest.mock('../../src/core/services/prismaClient', () => ({}));
jest.mock('../../src/core/services/stripeHelpers', () => ({
  getStripe: jest.fn(),
  createRefund: jest.fn(),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn() }));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn() }));

const { refundReasonFor } = require('../../src/core/services/paymentReconciliationService');

const NOW = new Date('2026-10-30T12:00:00.000Z');

function booking(over = {}) {
  return {
    id: 'booking_1',
    bookingNumber: 'TRG-1-2026-1',
    status: 'CONFIRMED',
    paymentTiming: 'later',
    paymentStatus: 'PENDING',
    grossAmount: '120.00',
    currency: 'USD',
    refundStatus: null,
    refundedAt: null,
    stripePaymentIntentId: 'pi_original',
    travelDate: new Date('2026-11-01T00:00:00.000Z'),
    selectedTime: '09:00',
    tour: {
      bookingAndTickets: JSON.stringify({
        availability: { timezone: 'Africa/Accra' },
        perSlotCutoff: false,
      }),
    },
    ...over,
  };
}

function intent(over = {}) {
  return {
    id: 'pi_new',
    status: 'succeeded',
    amount: 12000,
    currency: 'usd',
    ...over,
  };
}

describe('refundReasonFor', () => {
  it('refunds a terminal booking rather than resurrecting it', () => {
    expect(refundReasonFor(booking({ status: 'CANCELLED' }), intent(), NOW))
      .toBe('BOOKING_TERMINAL');
  });

  it('refunds a second charge when the booking already settled on another intent', () => {
    expect(refundReasonFor(
      booking({ paymentStatus: 'SUCCEEDED', stripePaymentIntentId: 'pi_original' }),
      intent(),
      NOW,
    )).toBe('DUPLICATE_CHARGE');
  });

  it('never refunds a completed booking on a duplicate success event', () => {
    const event = intent({ id: 'pi_original' });
    const completed = booking({
      status: 'COMPLETED',
      paymentStatus: 'SUCCEEDED',
      stripePaymentIntentId: 'pi_original',
    });

    expect(refundReasonFor(completed, event, NOW)).toBeNull();
  });

  it('still completes a cancellation refund for a paid, cancelled booking', () => {
    const event = intent({ id: 'pi_original' });
    const cancelledPaid = booking({
      status: 'CANCELLED',
      paymentStatus: 'SUCCEEDED',
      stripePaymentIntentId: 'pi_original',
    });

    expect(refundReasonFor(cancelledPaid, event, NOW)).toBe('BOOKING_TERMINAL');
  });

  it('ignores a duplicate webhook for the same intent', () => {
    expect(refundReasonFor(
      booking({ paymentStatus: 'SUCCEEDED', stripePaymentIntentId: 'pi_new' }),
      intent(),
      NOW,
    )).toBeNull();
  });

  it('refunds a charge that lands after the activity started', () => {
    expect(refundReasonFor(
      booking({ travelDate: new Date('2026-10-30T00:00:00.000Z'), selectedTime: '09:00' }),
      intent(),
      NOW,
    )).toBe('PAYMENT_TOO_LATE');
  });

  it('allows a same-day time-slot charge before that slot starts', () => {
    expect(refundReasonFor(
      booking({ travelDate: new Date('2026-10-30T00:00:00.000Z'), selectedTime: '18:00' }),
      intent(),
      NOW,
    )).toBeNull();
  });

  it('refunds an amount or currency mismatch', () => {
    expect(refundReasonFor(booking(), intent({ amount: 10000 }), NOW)).toBe('AMOUNT_MISMATCH');
    expect(refundReasonFor(booking(), intent({ currency: 'eur' }), NOW)).toBe('AMOUNT_MISMATCH');
  });

  it('never refunds money already returned', () => {
    expect(refundReasonFor(
      booking({ status: 'REFUNDED', paymentStatus: 'REFUNDED', refundedAt: NOW }),
      intent(),
      NOW,
    )).toBeNull();
    expect(refundReasonFor(
      booking({ status: 'CANCELLED', paymentStatus: 'FAILED', refundStatus: 'REFUNDED' }),
      intent(),
      NOW,
    )).toBeNull();
  });
});
