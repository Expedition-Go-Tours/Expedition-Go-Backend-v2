jest.mock('../../utils/prismaClient', () => ({
  booking: { findMany: jest.fn(), updateMany: jest.fn() },
}));

jest.mock('../../utils/stripeHelpers', () => {
  let stripeInstance = null;
  return {
    getStripe: jest.fn(() => {
      if (!stripeInstance) {
        stripeInstance = {
          paymentIntents: {
            retrieve: jest.fn(),
            confirm: jest.fn(),
          },
        };
      }
      return stripeInstance;
    }),
    handlePaymentSucceeded: jest.fn(() => Promise.resolve({ bookings: [], oversold: [] })),
  };
});

jest.mock('../../utils/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));

const prisma = require('../../utils/prismaClient');
const { getStripe, handlePaymentSucceeded } = require('../../utils/stripeHelpers');
const { enqueueNotification, enqueueEmail } = require('../../utils/queue');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const { chargePayLaterBookings } = require('../../utils/payLaterSweep');

const dueBooking = (overrides = {}) => ({
  id: 'b-later-1',
  bookingNumber: 'LAT-001',
  customerId: 'c1',
  tourId: 't1',
  total: 175,
  tour: { id: 't1', title: 'Safari', supplierId: 's1' },
  customer: { id: 'c1', email: 'c@x.com' },
  stripePaymentIntentId: 'pi_later',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  paidAt: null,
  paymentTiming: 'later',
  selectedDate: new Date(Date.now() + 12 * 60 * 60 * 1000),
  ...overrides,
});

describe('chargePayLaterBookings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    getStripe().paymentIntents.confirm.mockResolvedValue({ status: 'succeeded', id: 'pi_later' });
  });

  it('returns zeros when no bookings are due', async () => {
    const result = await chargePayLaterBookings();
    expect(result).toEqual({ checked: 0, charged: 0, settled: 0, needsAction: 0, failed: 0, cancelled: 0 });
    expect(getStripe().paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('charges a due booking via PaymentIntent confirm and settles it', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).toHaveBeenCalledWith('pi_later');
    expect(handlePaymentSucceeded).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi_later', status: 'succeeded' }));
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment-successful' }));
    expect(enqueueNotification).toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, charged: 1, settled: 0, needsAction: 0, failed: 0, cancelled: 0 });
  });

  it('settles a booking whose intent already succeeded (webhook was lost)', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'succeeded' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).not.toHaveBeenCalled();
    expect(handlePaymentSucceeded).toHaveBeenCalledWith({ status: 'succeeded' });
    expect(result.settled).toBe(1);
  });

  it('notifies the customer when 3DS action is required (cannot auto-charge)', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_action' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).not.toHaveBeenCalled();
    expect(enqueueNotification).toHaveBeenCalled();
    expect(result.needsAction).toBe(1);
  });

  it('cancels the reservation when the intent was canceled', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });

    const result = await chargePayLaterBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'FAILED' }),
      }),
    );
    expect(result.cancelled).toBe(1);
  });

  it('notifies failure and retries later when the charge is declined', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });
    getStripe().paymentIntents.confirm.mockRejectedValue(new Error('card declined'));

    const result = await chargePayLaterBookings();

    expect(enqueueNotification).toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('cancels bookings with no payment intent on file', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking({ stripePaymentIntentId: null })]);

    const result = await chargePayLaterBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalled();
    expect(result.cancelled).toBe(1);
  });

  it('leaves in-flight (processing) bookings for the next sweep', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'processing' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).not.toHaveBeenCalled();
    expect(handlePaymentSucceeded).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, charged: 0, settled: 0, needsAction: 0, failed: 0, cancelled: 0 });
  });
});