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
            cancel: jest.fn(() => Promise.resolve({})),
          },
          checkout: {
            sessions: {
              retrieve: jest.fn(),
            },
          },
        };
      }
      return stripeInstance;
    }),
    handlePaymentSucceeded: jest.fn(() => Promise.resolve({ bookings: [], oversold: [] })),
    createRefund: jest.fn(() => Promise.resolve({ id: 're_mock' })),
  };
});

jest.mock('../../utils/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));

const prisma = require('../../utils/prismaClient');
const { getStripe, handlePaymentSucceeded } = require('../../utils/stripeHelpers');
const { cancelStalePendingBookings } = require('../../utils/bookingCleanup');

const pendingBooking = (overrides = {}) => ({
  id: 'b-pending-1',
  customerId: 'c1',
  tourId: 't1',
  tour: { title: 'Safari' },
  stripePaymentIntentId: 'pi_pending',
  status: 'PENDING',
  paymentStatus: 'PENDING',
  paidAt: null,
  ...overrides,
});

describe('cancelStalePendingBookings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
  });

  it('returns zeros when there are no stale bookings', async () => {
    const result = await cancelStalePendingBookings();
    expect(result).toEqual({ stale: 0, confirmed: 0, cancelled: 0 });
    expect(getStripe().paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('cancels stale bookings whose intent settled but webhook was lost', async () => {
    prisma.booking.findMany.mockResolvedValue([pendingBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'succeeded' });

    const result = await cancelStalePendingBookings();

    expect(handlePaymentSucceeded).toHaveBeenCalledWith({ status: 'succeeded' });
    expect(result).toEqual({ stale: 1, confirmed: 1, cancelled: 0 });
  });

  it('releases capacity for declined or canceled intents', async () => {
    prisma.booking.findMany.mockResolvedValue([
      pendingBooking({ id: 'b1', stripePaymentIntentId: 'pi_declined' }),
    ]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });

    const result = await cancelStalePendingBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'b1', paymentStatus: { in: ['PENDING', 'PROCESSING'] } }),
        data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'FAILED' }),
      }),
    );
    expect(result.cancelled).toBe(1);
  });

  it('cancels abandoned 3DS intents and closes the intent so no charge lands later', async () => {
    prisma.booking.findMany.mockResolvedValue([pendingBooking()]);
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_action' });

    const result = await cancelStalePendingBookings();

    expect(getStripe().paymentIntents.cancel).toHaveBeenCalledWith('pi_pending');
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cancellationReason: 'Payment authorization expired' }) }),
    );
    expect(result.cancelled).toBe(1);
  });

  it('cancels bookings with no intent at all', async () => {
    prisma.booking.findMany.mockResolvedValue([pendingBooking({ stripePaymentIntentId: null })]);

    const result = await cancelStalePendingBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalled();
    expect(result.cancelled).toBe(1);
  });

  it('skips bookings whose intent cannot be retrieved (retried next sweep)', async () => {
    prisma.booking.findMany.mockResolvedValue([pendingBooking()]);
    getStripe().paymentIntents.retrieve.mockRejectedValue(new Error('network down'));

    const result = await cancelStalePendingBookings();

    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ stale: 1, confirmed: 0, cancelled: 0 });
  });

  it('never re-cancels a booking that already moved on (guard updateMany count 0)', async () => {
    prisma.booking.findMany.mockResolvedValue([pendingBooking({ id: 'already-friendly' })]);
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    getStripe().paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });

    const result = await cancelStalePendingBookings();

    expect(result.cancelled).toBe(0);
  });

  it('settles a pay-now booking whose Checkout Session completed but webhook was lost', async () => {
    prisma.booking.findMany.mockResolvedValue([
      pendingBooking({ stripePaymentIntentId: null, stripeCheckoutSessionId: 'cs_complete' }),
    ]);
    getStripe().checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_complete',
      status: 'complete',
      payment_intent: 'pi_complete',
    });

    const result = await cancelStalePendingBookings();

    expect(getStripe().checkout.sessions.retrieve).toHaveBeenCalledWith('cs_complete');
    expect(getStripe().paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(handlePaymentSucceeded).toHaveBeenCalledWith({
      id: 'pi_complete',
      metadata: { bookingIds: 'b-pending-1' },
    });
    expect(result).toEqual({ stale: 1, confirmed: 1, cancelled: 0 });
  });

  it('skips pay-now bookings whose Checkout Session is still open or in flight', async () => {
    prisma.booking.findMany.mockResolvedValue([
      pendingBooking({ stripePaymentIntentId: null, stripeCheckoutSessionId: 'cs_open' }),
    ]);
    getStripe().checkout.sessions.retrieve.mockResolvedValue({ status: 'open' });

    const result = await cancelStalePendingBookings();

    expect(handlePaymentSucceeded).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ stale: 1, confirmed: 0, cancelled: 0 });
  });

  it('cancels a pay-now booking whose Checkout Session ended without payment', async () => {
    prisma.booking.findMany.mockResolvedValue([
      pendingBooking({ stripePaymentIntentId: null, stripeCheckoutSessionId: 'cs_expired' }),
    ]);
    getStripe().checkout.sessions.retrieve.mockResolvedValue({ status: 'expired', payment_intent: null });

    const result = await cancelStalePendingBookings();

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'b-pending-1' }),
        data: expect.objectContaining({
          status: 'CANCELLED',
          paymentStatus: 'FAILED',
          cancellationReason: 'Payment was not completed',
        }),
      }),
    );
    expect(result).toEqual({ stale: 1, confirmed: 0, cancelled: 1 });
  });

  it('skips a pay-now booking whose session cannot be retrieved (retried next sweep)', async () => {
    prisma.booking.findMany.mockResolvedValue([
      pendingBooking({ stripePaymentIntentId: null, stripeCheckoutSessionId: 'cs_down' }),
    ]);
    getStripe().checkout.sessions.retrieve.mockRejectedValue(new Error('network down'));

    const result = await cancelStalePendingBookings();

    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ stale: 1, confirmed: 0, cancelled: 0 });
  });
});