jest.mock('../../utils/prismaClient', () => ({
  booking: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
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

jest.mock('../../utils/discordNotifier', () => ({
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));

const prisma = require('../../utils/prismaClient');
const { getStripe, handlePaymentSucceeded } = require('../../utils/stripeHelpers');
const { enqueueNotification, enqueueEmail } = require('../../utils/queue');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const { notifyDiscord } = require('../../utils/discordNotifier');
const { chargePayLaterBookings } = require('../../utils/payLaterSweep');

const dueBooking = (overrides = {}) => ({
  id: 'b-later-1',
  bookingNumber: 'LAT-001',
  customerId: 'c1',
  tourId: 't1',
  grossAmount: 175,
  tour: { id: 't1', title: 'Safari', supplierId: 's1' },
  customer: { id: 'c1', email: 'c@x.com' },
  stripePaymentIntentId: 'pi_later',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  paidAt: null,
  paymentTiming: 'later',
  travelDate: new Date(Date.now() + 12 * 60 * 60 * 1000),
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
    expect(result).toEqual({ checked: 0, charged: 0, settled: 0, needsAction: 0, failed: 0, cancelled: 0, retried: 0 });
    expect(getStripe().paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('charges a due booking via PaymentIntent confirm and settles it', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).toHaveBeenCalledWith('pi_later', expect.objectContaining({ return_url: expect.any(String) }));
    expect(handlePaymentSucceeded).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi_later', status: 'succeeded' }));
    expect(enqueueNotification).toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, charged: 1, settled: 0, needsAction: 0, failed: 0, cancelled: 0, retried: 0 });
  });

  it('charges a PENDING pay-later booking (the current creation state)', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking({ status: 'PENDING' })]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).toHaveBeenCalledWith('pi_later', expect.objectContaining({ return_url: expect.any(String) }));
    expect(handlePaymentSucceeded).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi_later', status: 'succeeded' }));
    expect(result.charged).toBe(1);
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

  it('cancels the reservation when the intent was canceled (after max retries)', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking({ chargeRetries: 3 })]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });

    const result = await chargePayLaterBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'FAILED' }),
      }),
    );
    expect(result.cancelled).toBe(1);
  });

  it('retries later when the charge is declined (under max retries)', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });
    getStripe().paymentIntents.confirm.mockRejectedValue(new Error('card declined'));

    const result = await chargePayLaterBookings();

    expect(notifyAdmin).toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(result.retried).toBe(1);
  });

  it('cancels bookings with no payment intent on file (after max retries)', async () => {
    prisma.booking.findMany.mockResolvedValue([dueBooking({ stripePaymentIntentId: null, chargeRetries: 3 })]);

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
    expect(result).toEqual({ checked: 1, charged: 0, settled: 0, needsAction: 0, failed: 0, cancelled: 0, retried: 0 });
  });

  describe('Discord notifications', () => {
    it('sends red embed on initial confirm failure', async () => {
      prisma.booking.findMany.mockResolvedValue([dueBooking()]);
      getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });
      getStripe().paymentIntents.confirm.mockRejectedValue(new Error('card declined'));

      await chargePayLaterBookings();

      expect(notifyDiscord).toHaveBeenCalledWith(
        'incidents',
        'Pay-later charge failed for booking LAT-001',
        expect.objectContaining({
          title: 'Payment Collection Failed',
          color: 0xff4444,
          fields: expect.arrayContaining([
            expect.objectContaining({ name: 'Booking #', value: 'LAT-001' }),
            expect.objectContaining({ name: 'Reason', value: 'card declined' }),
          ]),
        })
      );
    });

    it('sends yellow retry embed with retry count', async () => {
      prisma.booking.findMany.mockResolvedValue([dueBooking({ chargeRetries: 0 })]);
      getStripe().paymentIntents.confirm.mockRejectedValue(new Error('insufficient funds'));

      await chargePayLaterBookings();

      expect(notifyDiscord).toHaveBeenCalledWith(
        'incidents',
        'Pay-later charge failed — retry 1/3',
        expect.objectContaining({
          title: 'Payment Retry Scheduled',
          color: 0xffaa00,
          fields: expect.arrayContaining([
            expect.objectContaining({ name: 'Next Retry' }),
            expect.objectContaining({ name: 'Reason', value: 'insufficient funds' }),
          ]),
        })
      );
    });

    it('sends red embed when max retries exceeded (cancel)', async () => {
      prisma.booking.findMany.mockResolvedValue([dueBooking({ chargeRetries: 3 })]);
      getStripe().paymentIntents.confirm.mockRejectedValue(new Error('card declined'));

      await chargePayLaterBookings();

      expect(notifyDiscord).toHaveBeenCalledWith(
        'incidents',
        expect.stringContaining('cancelled after 3'),
        expect.objectContaining({
          title: 'Pay-Later Booking Cancelled',
          color: 0xff4444,
          fields: expect.arrayContaining([
            expect.objectContaining({ name: 'Booking #', value: 'LAT-001' }),
          ]),
        })
      );
    });

    it('sends red embed when intent is canceled (exhausted retries)', async () => {
      prisma.booking.findMany.mockResolvedValue([dueBooking({ chargeRetries: 3 })]);
      getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });

      await chargePayLaterBookings();

      expect(notifyDiscord).toHaveBeenCalledWith(
        'incidents',
        expect.stringContaining('cancelled after 3'),
        expect.objectContaining({
          title: 'Pay-Later Booking Cancelled',
          color: 0xff4444,
        })
      );
    });

    it('sends red embed when no PI and no retries left', async () => {
      prisma.booking.findMany.mockResolvedValue([dueBooking({ stripePaymentIntentId: null, chargeRetries: 3 })]);

      await chargePayLaterBookings();

      expect(notifyDiscord).toHaveBeenCalledWith(
        'incidents',
        expect.stringContaining('cancelled after 3'),
        expect.objectContaining({
          title: 'Pay-Later Booking Cancelled',
          color: 0xff4444,
        })
      );
    });

    it('does NOT send Discord embed on successful charge', async () => {
      prisma.booking.findMany.mockResolvedValue([dueBooking()]);
      getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });

      await chargePayLaterBookings();

      expect(notifyDiscord).not.toHaveBeenCalled();
    });

    it('does NOT send Discord embed on successful settle', async () => {
      prisma.booking.findMany.mockResolvedValue([dueBooking()]);
      getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'succeeded' });

      await chargePayLaterBookings();

      expect(notifyDiscord).not.toHaveBeenCalled();
    });
  });
});