/**
 * PayPal refund reconciliation.
 *
 * A refund instruction can come back PENDING. Nothing else in the system will
 * ever look at it again unless this sweep does, so its job is to finish what
 * the provider started — and to never touch a Stripe row.
 */

const prisma = require('../../../src/core/services/prismaClient');
const { getRefund } = require('../../../src/core/services/payments/paypalPayments');
const {
  reconcilePendingPaypalRefunds,
  reconcileBookingRefunds,
  reconcileUnclaimedRefunds,
} = require('../../../src/core/services/payments/paypalReconciliation');

jest.mock('../../../src/core/services/prismaClient', () => ({
  booking: { findMany: jest.fn(), update: jest.fn() },
  bookingPaymentReconciliation: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
}));

jest.mock('../../../src/core/services/payments/paypalPayments', () => ({
  getRefund: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PAYPAL_CLIENT_ID = 'client-id';
  process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.booking.update.mockResolvedValue({});
  prisma.bookingPaymentReconciliation.findMany.mockResolvedValue([]);
  prisma.bookingPaymentReconciliation.update.mockResolvedValue({});
  prisma.bookingPaymentReconciliation.updateMany.mockResolvedValue({ count: 0 });
});

describe('reconcileBookingRefunds', () => {
  it('only looks at PayPal refunds that are still pending', async () => {
    await reconcileBookingRefunds();

    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentProvider: 'PAYPAL',
          paypalRefundId: { not: null },
          paypalRefundStatus: { in: ['PENDING', 'PROCESSING'] },
        },
      })
    );
  });

  it('marks a completed refund as REFUNDED', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 'booking_1', bookingNumber: 'TRG-1-1', paypalRefundId: 'REF-1', paypalRefundStatus: 'PENDING' },
    ]);
    getRefund.mockResolvedValue({
      normalized: { refundId: 'REF-1', status: 'SUCCEEDED', amountMinor: 12000 },
    });

    const result = await reconcileBookingRefunds();

    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking_1' },
      data: {
        paypalRefundStatus: 'COMPLETED',
        paymentStatus: 'REFUNDED',
        refundedAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ checked: 1, updated: 1 });
  });

  it('keeps a pending refund pending without churning the row', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 'booking_1', paypalRefundId: 'REF-1', paypalRefundStatus: 'PENDING' },
    ]);
    getRefund.mockResolvedValue({ normalized: { status: 'PENDING' } });

    const result = await reconcileBookingRefunds();

    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
  });

  it('records a failed refund without marking it refunded', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 'booking_1', paypalRefundId: 'REF-1', paypalRefundStatus: 'PENDING' },
    ]);
    getRefund.mockResolvedValue({ normalized: { status: 'FAILED' } });

    await reconcileBookingRefunds();

    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking_1' },
      data: { paypalRefundStatus: 'FAILED' },
    });
  });

  it('continues past a provider error', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 'booking_1', paypalRefundId: 'REF-1', paypalRefundStatus: 'PENDING' },
      { id: 'booking_2', paypalRefundId: 'REF-2', paypalRefundStatus: 'PENDING' },
    ]);
    getRefund
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ normalized: { status: 'SUCCEEDED' } });

    const result = await reconcileBookingRefunds();

    expect(result).toEqual({ checked: 2, updated: 1 });
  });
});

describe('reconcileUnclaimedRefunds', () => {
  it('only looks at PayPal reconciliation rows', async () => {
    await reconcileUnclaimedRefunds();
    expect(prisma.bookingPaymentReconciliation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentProvider: 'PAYPAL',
          status: 'REFUND_PENDING',
          paypalRefundId: { not: null },
        },
      })
    );
  });

  it('marks a completed unclaimed refund as REFUNDED', async () => {
    prisma.bookingPaymentReconciliation.findMany.mockResolvedValue([
      { id: 'row_1', paypalRefundId: 'REF-1', status: 'REFUND_PENDING' },
    ]);
    getRefund.mockResolvedValue({ normalized: { status: 'SUCCEEDED' } });

    const result = await reconcileUnclaimedRefunds();

    expect(prisma.bookingPaymentReconciliation.update).toHaveBeenCalledWith({
      where: { id: 'row_1' },
      data: { status: 'REFUNDED', refundedAt: expect.any(Date), failureCode: null },
    });
    expect(result.updated).toBe(1);
  });

  it('flags a failed refund for finance', async () => {
    prisma.bookingPaymentReconciliation.findMany.mockResolvedValue([
      { id: 'row_1', paypalRefundId: 'REF-1', status: 'REFUND_PENDING' },
    ]);
    getRefund.mockResolvedValue({ normalized: { status: 'FAILED' } });

    await reconcileUnclaimedRefunds();

    expect(prisma.bookingPaymentReconciliation.update).toHaveBeenCalledWith({
      where: { id: 'row_1' },
      data: {
        status: 'REFUND_FAILED',
        refundedAt: null,
        failureCode: 'REFUND_PROVIDER_FAILED',
      },
    });
  });
});

describe('reconcilePendingPaypalRefunds', () => {
  it('runs both passes and reports the totals', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 'booking_1', paypalRefundId: 'REF-1', paypalRefundStatus: 'PENDING' },
    ]);
    prisma.bookingPaymentReconciliation.findMany.mockResolvedValue([
      { id: 'row_1', paypalRefundId: 'REF-2', status: 'REFUND_PENDING' },
    ]);
    getRefund.mockResolvedValue({ normalized: { status: 'SUCCEEDED' } });

    const result = await reconcilePendingPaypalRefunds();

    expect(result).toEqual({ bookings: 1, unclaimed: 1, checked: 2 });
  });

  it('skips the queries entirely when PayPal is not configured', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;

    const result = await reconcilePendingPaypalRefunds();

    expect(result).toMatchObject({ checked: 0 });
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(prisma.bookingPaymentReconciliation.findMany).not.toHaveBeenCalled();
  });

  it('survives one pass failing', async () => {
    prisma.booking.findMany.mockRejectedValue(new Error('db down'));
    prisma.bookingPaymentReconciliation.findMany.mockResolvedValue([]);

    await expect(reconcilePendingPaypalRefunds()).resolves.toEqual({
      bookings: 0,
      unclaimed: 0,
      checked: 0,
    });
  });
});
