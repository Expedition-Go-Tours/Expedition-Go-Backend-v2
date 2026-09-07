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
  chargeRetries: 0,
  nextRetryAt: null,
  requiresPaymentActionAt: null,
  ...overrides,
});

const ZERO_SUMMARY = { checked: 0, charged: 0, settled: 0, manual: 0, processing: 0, failed: 0, cancelled: 0, retried: 0, waiting: 0 };

describe('chargePayLaterBookings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    getStripe().paymentIntents.confirm.mockResolvedValue({ status: 'succeeded', id: 'pi_later' });
  });

  it('returns zeros when no bookings are due', async () => {
    const result = await chargePayLaterBookings();
    expect(result).toEqual(ZERO_SUMMARY);
    expect(getStripe().paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('charges a due booking via PaymentIntent confirm and settles it', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking()]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).toHaveBeenCalledWith('pi_later', expect.objectContaining({ return_url: expect.any(String) }));
    expect(handlePaymentSucceeded).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi_later', status: 'succeeded' }));
    expect(enqueueNotification).toHaveBeenCalled();
    expect(result).toEqual({ ...ZERO_SUMMARY, checked: 1, charged: 1 });
  });

  it('charges a PENDING pay-later booking (the current creation state)', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking({ status: 'PENDING' })]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).toHaveBeenCalledWith('pi_later', expect.objectContaining({ return_url: expect.any(String) }));
    expect(handlePaymentSucceeded).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi_later', status: 'succeeded' }));
    expect(result.charged).toBe(1);
  });

  it('settles a booking whose intent already succeeded (webhook was lost)', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking()]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'succeeded' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).not.toHaveBeenCalled();
    expect(handlePaymentSucceeded).toHaveBeenCalledWith({ status: 'succeeded' });
    expect(result.settled).toBe(1);
  });

  it('escalates 3DS action-required bookings to manual payment (no auto-charge)', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking()]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_action' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requiresPaymentActionAt: null }),
        data: expect.objectContaining({ requiresPaymentActionAt: expect.any(Date) }),
      })
    );
    expect(enqueueNotification).toHaveBeenCalled();
    expect(enqueueEmail).toHaveBeenCalled();
    expect(result.manual).toBe(1);
  });

  it('does not escalate a booking that is already flagged for manual action', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking({ requiresPaymentActionAt: new Date() })]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_action' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(result.waiting).toBe(1);
  });

  it('escalates an invalid-card booking (requires_payment_method) to manual after retries are exhausted', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking({ chargeRetries: 3 })]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });

    const result = await chargePayLaterBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requiresPaymentActionAt: expect.any(Date) }),
      })
    );
    expect(result.manual).toBe(1);
  });

  it('retries later when the charge is declined (under max retries)', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking()]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });
    getStripe().paymentIntents.confirm.mockRejectedValue(new Error('card declined'));

    const result = await chargePayLaterBookings();

    expect(notifyAdmin).toHaveBeenCalled();
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'b-later-1' },
        data: expect.objectContaining({ chargeRetries: 1, nextRetryAt: expect.any(Date) }),
      })
    );
    expect(result.retried).toBe(1);
  });

  it('escalates to manual (never silently cancels) after max decline retries', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking({ chargeRetries: 3 })]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });
    getStripe().paymentIntents.confirm.mockRejectedValue(new Error('card declined'));

    const result = await chargePayLaterBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requiresPaymentActionAt: expect.any(Date) }),
      })
    );
    expect(result.manual).toBe(1);
  });

  it('escalates to manual when no payment intent is on file', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking({ stripePaymentIntentId: null })]).mockResolvedValueOnce([]);

    const result = await chargePayLaterBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requiresPaymentActionAt: expect.any(Date) }),
      })
    );
    expect(result.manual).toBe(1);
  });

  it('leaves in-flight (processing) bookings for the next sweep', async () => {
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking()]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'processing' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).not.toHaveBeenCalled();
    expect(handlePaymentSucceeded).not.toHaveBeenCalled();
    expect(result.processing).toBe(1);
  });

  it('only selects bookings whose activity date is strictly in the future (charge-after-event guard)', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    await chargePayLaterBookings();

    const dueWhere = prisma.booking.findMany.mock.calls[0][0].where;
    expect(dueWhere.travelDate.gt).toBeInstanceOf(Date);
    // Activity started / past bookings are handled by the finalize pass, never
    // auto-charged.
    expect(dueWhere.travelDate.lte).toBeInstanceOf(Date);
    expect(prisma.booking.findMany).toHaveBeenCalledTimes(2); // due + finalize
  });

  it('defense-in-depth: never confirms a booking once its activity day has ended', async () => {
    const pastDay = new Date(Date.now() - 48 * 60 * 60 * 1000);
    prisma.booking.findMany.mockResolvedValueOnce([dueBooking({ travelDate: pastDay })]).mockResolvedValueOnce([]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });

    const result = await chargePayLaterBookings();

    expect(getStripe().paymentIntents.confirm).not.toHaveBeenCalled();
    expect(getStripe().paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'FAILED' }),
      })
    );
    expect(result.cancelled).toBe(1);
  });

  it('finalizes unpaid bookings once the activity day has fully passed', async () => {
    const past = new Date(Date.now() - (24 + 12) * 60 * 60 * 1000);
    prisma.booking.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([dueBooking({ travelDate: past })]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });

    const result = await chargePayLaterBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paymentStatus: 'PENDING', paidAt: null }),
        data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'FAILED' }),
      })
    );
    expect(result.cancelled).toBe(1);
  });

  describe('Discord notifications', () => {
    it('sends red embed on initial confirm failure', async () => {
      prisma.booking.findMany.mockResolvedValueOnce([dueBooking()]).mockResolvedValueOnce([]);
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
      prisma.booking.findMany.mockResolvedValueOnce([dueBooking({ chargeRetries: 0 })]).mockResolvedValueOnce([]);
      getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });
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

    it('does NOT send the auto-cancel embed when max retries exceeded (escalates instead)', async () => {
      prisma.booking.findMany.mockResolvedValueOnce([dueBooking({ chargeRetries: 3 })]).mockResolvedValueOnce([]);
      getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });
      getStripe().paymentIntents.confirm.mockRejectedValue(new Error('card declined'));

      await chargePayLaterBookings();

      expect(notifyDiscord).not.toHaveBeenCalledWith(
        'incidents',
        expect.stringContaining('cancelled'),
        expect.any(Object)
      );
      // Instead a "manual payment required" embed is sent once.
      expect(notifyDiscord).toHaveBeenCalledWith(
        'incidents',
        'Pay-later booking LAT-001 needs manual payment',
        expect.objectContaining({ title: 'Manual Payment Required' })
      );
    });

    it('does NOT send Discord embed on successful charge', async () => {
      prisma.booking.findMany.mockResolvedValueOnce([dueBooking()]).mockResolvedValueOnce([]);
      getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_confirmation' });

      await chargePayLaterBookings();

      expect(notifyDiscord).not.toHaveBeenCalled();
    });

    it('does NOT send Discord embed on successful settle', async () => {
      prisma.booking.findMany.mockResolvedValueOnce([dueBooking()]).mockResolvedValueOnce([]);
      getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'succeeded' });

      await chargePayLaterBookings();

      expect(notifyDiscord).not.toHaveBeenCalled();
    });
  });
});
