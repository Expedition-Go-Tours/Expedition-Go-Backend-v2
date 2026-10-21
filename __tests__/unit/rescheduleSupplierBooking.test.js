/**
 * Supplier-initiated reschedule (bookingModify.rescheduleBookingBySupplier).
 *
 * This is the one supplier action that rewrites what a customer has already
 * paid for, so the rules are deliberately blunt:
 *
 *   - same price or no move. A move must never silently change the amount the
 *     customer paid, and the supplier must never be handed a hidden price
 *     change either.
 *   - capacity is re-checked WITHOUT this booking's own travellers.
 *   - payout has not begun; the booking is pending/confirmed.
 *   - the customer is notified — nobody finds out at the door.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  booking: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('../../src/core/services/getConfig', () =>
  jest.fn((key, def) => Promise.resolve(def)),
);
jest.mock('../../src/core/services/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/stripeHelpers', () => ({
  calculateCommission: jest.fn(() => Promise.resolve({ amount: 0, supplierPayout: 0 })),
  createRefund: jest.fn(),
  getStripe: jest.fn(),
  ensureStripeCustomer: jest.fn(),
}));
jest.mock('../../src/core/services/tourHelpers', () => ({
  calculateTourPrice: jest.fn(),
}));
jest.mock('../../src/core/services/availabilityCore', () => {
  const actual = jest.requireActual('../../src/core/services/availabilityCore');
  return {
    ...actual,
    evaluateBookingAvailability: jest.fn(),
  };
});
jest.mock('../../src/core/services/tourOptions', () => ({
  getTourOptions: jest.fn(() => []),
  applyOption: jest.fn(() => null),
}));
jest.mock('../../src/core/services/payLaterLeadTime', () => ({
  assertPayLaterLeadTime: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const { calculateTourPrice } = require('../../src/core/services/tourHelpers');
const { evaluateBookingAvailability } = require('../../src/core/services/availabilityCore');
const { enqueueNotification } = require('../../src/core/services/queue');
const { rescheduleBookingBySupplier } = require('../../src/core/services/bookingModify');

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

const baseBooking = (over = {}) => ({
  id: 'b-1',
  bookingNumber: 'TRG-1',
  status: 'CONFIRMED',
  payoutStatus: 'PENDING',
  paymentStatus: 'SUCCEEDED',
  paymentTiming: 'now',
  travelDate: FUTURE,
  selectedTime: '09:00',
  travelers: { adults: 2 },
  subtotal: 400,
  discounts: 0,
  grossAmount: 400,
  platformCommission: 60,
  supplierPayout: 340,
  currency: 'USD',
  optionId: null,
  customerId: 'u-1',
  supplierNotes: '',
  tour: { id: 't-1', title: 'Shai Hills Safari', supplierId: 'supplier-1', schedulesAndPricing: {} },
  customer: { id: 'u-1', name: 'Kwame' },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.findFirst.mockResolvedValue(baseBooking());
  // notifyModificationApplied re-reads the booking before it queues anything.
  prisma.booking.findUnique.mockResolvedValue(baseBooking());
  prisma.booking.update.mockResolvedValue({ ...baseBooking(), travelDate: new Date(FUTURE.getTime() + 86400000) });
  // Default pricing: identical to what the booking already holds → move allowed.
  calculateTourPrice.mockResolvedValue({ success: true, total: 400, subtotal: 400, discount: 0 });
  evaluateBookingAvailability.mockResolvedValue({ ok: true });
});

const move = (over = {}) =>
  rescheduleBookingBySupplier({
    bookingId: 'b-1',
    supplierId: 'supplier-1',
    travelDate: '2026-12-24',
    selectedTime: '10:30',
    ...over,
  });

describe('ownership and state', () => {
  it('404s a booking that is not the supplier’s', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);

    await expect(move()).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('refuses once the booking is completed or cancelled', async () => {
    prisma.booking.findFirst.mockResolvedValue(baseBooking({ status: 'COMPLETED' }));

    await expect(move()).rejects.toThrow(/only pending or confirmed/i);
  });

  it('refuses once payout has begun', async () => {
    prisma.booking.findFirst.mockResolvedValue(baseBooking({ payoutStatus: 'REQUESTED' }));

    await expect(move()).rejects.toThrow(/payout has begun/i);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
});

describe('the price is sacred', () => {
  it('refuses a move that would change what the customer paid, and names both prices', async () => {
    calculateTourPrice.mockResolvedValue({ success: true, total: 500, subtotal: 500, discount: 0 });

    await expect(move()).rejects.toThrow(/priced .*500.*instead of .*400/i);
    // Nothing written, no notification: the customer is never told about a
    // change that did not happen.
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('refuses when the new date cannot be priced at all', async () => {
    calculateTourPrice.mockResolvedValue({ success: false, error: 'No schedule on that date' });

    await expect(move()).rejects.toThrow(/no schedule on that date/i);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
});

describe('capacity', () => {
  it('refuses a date that is full', async () => {
    evaluateBookingAvailability.mockResolvedValue({ ok: false, reason: 'That date is sold out' });

    await expect(move()).rejects.toThrow(/sold out/i);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('re-checks capacity excluding this booking’s own travellers', async () => {
    await move();

    expect(evaluateBookingAvailability).toHaveBeenCalledWith(
      prisma,
      expect.anything(),
      expect.any(String),
      '10:30',
      { adults: 2 },
      expect.objectContaining({ excludeBookingId: 'b-1' }),
    );
  });
});

describe('the move itself', () => {
  it('writes the new date and time and leaves the money untouched', async () => {
    await move();

    const data = prisma.booking.update.mock.calls[0][0].data;
    expect(new Date(data.travelDate).toISOString().slice(0, 10)).toBe('2026-12-24');
    expect(data.selectedTime).toBe('10:30');
    // The whole point: not a single money column moves on a supplier reschedule.
    expect(data.grossAmount).toBeUndefined();
    expect(data.subtotal).toBeUndefined();
    expect(data.supplierPayout).toBeUndefined();
    expect(data.status).toBeUndefined();
  });

  it('records the reason in the supplier notes', async () => {
    await move({ reason: 'Vehicle breakdown' });

    const data = prisma.booking.update.mock.calls[0][0].data;
    expect(data.supplierNotes).toContain('Rescheduled: Vehicle breakdown');
  });

  it('tells the customer about the change', async () => {
    const { changes } = await move();

    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Activity date' }),
        expect.objectContaining({ label: 'Start time' }),
      ]),
    );
    // notifyModificationApplied is fire-and-forget; the notification queue is
    // the observable part.
    await new Promise((resolve) => setImmediate(resolve));
    expect(enqueueNotification).toHaveBeenCalled();
  });

  it('rejects a "move" to the same date and time', async () => {
    prisma.booking.findFirst.mockResolvedValue(baseBooking({ travelDate: new Date('2026-12-24T09:00:00.000Z'), selectedTime: '10:30' }));

    await expect(move()).rejects.toThrow(/no changes were requested/i);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
});
