/**
 * Booking materialisation with a provider tag.
 *
 * materializeHold is the only path that creates a pay-now Booking, so it is
 * also the only place that can attach a payment reference. The rules: write the
 * identifiers of the provider that settled, never the other one's, and refuse a
 * capture whose amount or currency does not match the frozen price.
 */

const prisma = require('../../src/core/services/prismaClient');
const { evaluateBookingAvailability } = require('../../src/core/services/availabilityCore');
const { materializeHold } = require('../../src/core/services/checkoutHold');

jest.mock('../../src/core/services/prismaClient', () => ({ $transaction: jest.fn() }));
jest.mock('../../src/core/services/availabilityCore', () => ({
  evaluateBookingAvailability: jest.fn(),
  travelerCount: jest.fn((travelers) => {
    if (!travelers) return 0;
    if (typeof travelers === 'number') return travelers;
    return (travelers.adults || 0) + (travelers.children || 0) + (travelers.infants || 0);
  }),
  parseBlob: jest.fn(() => ({})),
}));
jest.mock('../../src/core/services/bookingHelpers', () => ({
  generateBookingNumber: jest.fn(() => 'TRG-1-2026-1'),
}));
jest.mock('../../src/core/services/geoUtils', () => ({
  resolvePickupSelection: jest.fn(),
  normalizePickupSnapshot: jest.fn(() => null),
}));
jest.mock('../../src/core/services/queue', () => ({ enqueueNotification: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/eventEmitter', () => ({ emit: jest.fn() }));

const DRAFT = {
  id: 'draft_1',
  status: 'HOLDING',
  customerId: 'cus_1',
  tourId: 'tour_1',
  travelDate: new Date('2026-11-10T00:00:00Z'),
  selectedTime: '09:00',
  currency: 'USD',
  pricing: { subtotal: '120.00', total: '120.00', discount: '0.00', currency: 'USD' },
  payload: {
    _source: 'GHANA',
    _bookingPrefix: 'TRG',
    travelers: { adults: 2, children: 0, infants: 0 },
    leadTraveler: { name: 'Ama', email: 'ama@example.com', phone: '+233000000000' },
    pickup: null,
    specialRequests: '',
  },
  commissionRate: '0.15',
  platformCommission: '18.00',
  supplierPayout: '102.00',
};

const BOOKING = {
  id: 'booking_1',
  bookingNumber: 'TRG-1-2026-1',
  customerId: 'cus_1',
  tourId: 'tour_1',
  tour: { id: 'tour_1', title: 'Cape Coast', supplierId: 'sup_1' },
};

let tx;

beforeEach(() => {
  jest.clearAllMocks();
  tx = {
    checkoutDraft: {
      findUnique: jest.fn().mockResolvedValue(DRAFT),
      update: jest.fn().mockResolvedValue({}),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'tour_1' }]),
    tour: { findUnique: jest.fn().mockResolvedValue({ id: 'tour_1', bookingAndTickets: '{}' }) },
    booking: { create: jest.fn().mockResolvedValue(BOOKING) },
    cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  prisma.$transaction.mockImplementation((fn) => fn(tx));
  evaluateBookingAvailability.mockResolvedValue({ ok: true });
});

const stripeSession = { id: 'cs_1', amount_total: 12000, currency: 'USD' };
const paypalCapture = { id: 'ORDER-1', amount_total: 12000, currency: 'USD' };

describe('materializeHold — provider tagging', () => {
  it('writes only PayPal identifiers for a PayPal capture', async () => {
    const result = await materializeHold('draft_1', paypalCapture, null, {
      provider: 'PAYPAL',
      captureId: 'CAP-1',
    });

    expect(result.ok).toBe(true);
    const data = tx.booking.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      paymentProvider: 'PAYPAL',
      paypalOrderId: 'ORDER-1',
      paypalCaptureId: 'CAP-1',
    });
    expect(data.stripePaymentIntentId).toBeUndefined();
    expect(data.stripeCheckoutSessionId).toBeUndefined();
  });

  it('leaves the Stripe path exactly as it was', async () => {
    await materializeHold('draft_1', stripeSession, 'pi_1');

    const data = tx.booking.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      paymentProvider: 'STRIPE',
      stripePaymentIntentId: 'pi_1',
      stripeCheckoutSessionId: 'cs_1',
    });
    expect(data.paypalOrderId).toBeUndefined();
    expect(data.paypalCaptureId).toBeUndefined();
  });

  it('refuses a PayPal settlement with no capture id', async () => {
    await expect(materializeHold('draft_1', paypalCapture, null, { provider: 'PAYPAL' }))
      .rejects.toThrow(/requires a capture id/);
    expect(tx.booking.create).not.toHaveBeenCalled();
  });
});

describe('materializeHold — money guards', () => {
  it('rejects an amount that does not match the frozen price', async () => {
    await expect(materializeHold('draft_1', { ...stripeSession, amount_total: 11999 }, 'pi_1'))
      .rejects.toThrow(/Amount mismatch/);
    expect(tx.booking.create).not.toHaveBeenCalled();
  });

  it('rejects a currency that does not match the draft', async () => {
    await expect(materializeHold('draft_1', { ...stripeSession, currency: 'GHS' }, 'pi_1'))
      .rejects.toThrow(/Currency mismatch/);
    expect(tx.booking.create).not.toHaveBeenCalled();
  });

  it('accepts a lowercase currency code', async () => {
    await expect(materializeHold('draft_1', { ...stripeSession, currency: 'usd' }, 'pi_1'))
      .resolves.toMatchObject({ ok: true });
  });
});

describe('materializeHold — idempotency and capacity', () => {
  it('is a no-op when the draft is no longer HOLDING', async () => {
    tx.checkoutDraft.findUnique.mockResolvedValue({ ...DRAFT, status: 'PAID' });

    const result = await materializeHold('draft_1', paypalCapture, null, {
      provider: 'PAYPAL',
      captureId: 'CAP-1',
    });

    expect(result).toMatchObject({ ok: false, reason: 'already_settled' });
    expect(tx.booking.create).not.toHaveBeenCalled();
  });

  it('expires the draft when capacity disappeared during the hold', async () => {
    evaluateBookingAvailability.mockResolvedValue({ ok: false, reason: 'sold out' });

    const result = await materializeHold('draft_1', paypalCapture, null, {
      provider: 'PAYPAL',
      captureId: 'CAP-1',
    });

    expect(result).toMatchObject({ ok: false, oversold: true });
    expect(tx.checkoutDraft.update).toHaveBeenCalledWith({
      where: { id: 'draft_1' },
      data: { status: 'EXPIRED' },
    });
    expect(tx.booking.create).not.toHaveBeenCalled();
  });
});
