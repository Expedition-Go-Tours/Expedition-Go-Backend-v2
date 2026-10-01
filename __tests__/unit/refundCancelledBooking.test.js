/**
 * `refundCancelledBooking` decides whether a cancellation refunds one
 * PaymentIntent or several — the seam the two storefront cancels now share.
 *
 * It exists because cancellations are no longer scoped to the storefront that
 * took the booking: a booking paid partly by a modification top-up could be
 * cancelled from the other site, and the site that only knew about the primary
 * charge would refund it and leave the top-up captured — the customer short by
 * the difference and us holding money for a trip nobody is taking.
 *
 * The two branches are told apart by what reaches `createRefund`: exactly one
 * call against the primary intent, or calls against every intent the booking
 * was paid with.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  bookingChange: { findFirst: jest.fn(), findMany: jest.fn() },
}));
jest.mock('../../src/core/services/stripeHelpers', () => ({
  createRefund: jest.fn(),
  getStripe: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const { createRefund, getStripe } = require('../../src/core/services/stripeHelpers');
const { refundCancelledBooking } = require('../../src/core/services/bookingModify');

const BOOKING = { id: 'b1', stripePaymentIntentId: 'pi_primary' };

/** Every intent reports the same captured amount so the split is predictable. */
function stripeCapturing(captured) {
  getStripe.mockReturnValue({
    paymentIntents: { retrieve: jest.fn().mockResolvedValue({ amount_captured: captured }) },
  });
}

describe('refundCancelledBooking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.bookingChange.findFirst.mockResolvedValue(null);
    prisma.bookingChange.findMany.mockResolvedValue([]);
    createRefund.mockResolvedValue({ id: 're_1' });
    stripeCapturing(10000);
  });

  it('refunds the primary intent alone when nothing was topped up', async () => {
    await refundCancelledBooking(BOOKING, 4000);

    expect(prisma.bookingChange.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: 'b1', status: 'APPLIED', paymentIntentId: { not: null } },
      }),
    );
    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(createRefund).toHaveBeenCalledWith('pi_primary', 4000);
  });

  it('spreads the refund across the top-up as well when one exists', async () => {
    prisma.bookingChange.findFirst.mockResolvedValue({ id: 'change-1' });
    prisma.bookingChange.findMany.mockResolvedValue([{ paymentIntentId: 'pi_topup' }]);

    await refundCancelledBooking(BOOKING, 15000);

    const refunded = createRefund.mock.calls.map(([intentId]) => intentId);
    // Both intents: 10000 captured on the primary, the remainder off the top-up.
    expect(refunded).toEqual(['pi_primary', 'pi_topup']);
    expect(createRefund.mock.calls[0][1]).toBe(10000);
    expect(createRefund.mock.calls[1][1]).toBe(5000);
  });

  it('does not spread when the top-up query fails — it falls back to the primary', async () => {
    prisma.bookingChange.findFirst.mockRejectedValue(new Error('db down'));

    await refundCancelledBooking(BOOKING, 4000);

    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(createRefund).toHaveBeenCalledWith('pi_primary', 4000);
  });

  it('decides from the APPLIED lookup, not from what findMany would return', async () => {
    // refundAcrossSources lists top-ups with findMany; it is only reached when
    // the APPLIED lookup above finds one, so a top-up sitting in findMany must
    // not by itself send the refund down the multi-intent path.
    prisma.bookingChange.findFirst.mockResolvedValue(null);
    prisma.bookingChange.findMany.mockResolvedValue([{ paymentIntentId: 'pi_discarded' }]);

    await refundCancelledBooking(BOOKING, 4000);

    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(createRefund).toHaveBeenCalledWith('pi_primary', 4000);
  });
});
