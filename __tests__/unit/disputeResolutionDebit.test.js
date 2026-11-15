/**
 * Money-safety rules for the older `Dispute` refund-request resolution path.
 *
 * `resolveDispute` used to refund the customer, mark the payout CANCELLED and
 * move on — even when the supplier had already been credited for the booking.
 * These tests lock down the missing supplier debit, the full/partial split and
 * the provider replay guard.
 */

jest.mock('../../src/core/services/prismaClient', () => {
  const tx = {
    dispute: { update: jest.fn() },
    booking: { update: jest.fn() },
    supplierCharge: { create: jest.fn() },
  };
  return {
    __tx: tx,
    dispute: { findFirst: jest.fn() },
    $transaction: jest.fn((fn) => fn(tx)),
  };
});

jest.mock('../../src/core/services/financeHelpers', () => {
  const actual = jest.requireActual('../../src/core/services/financeHelpers');
  return {
    ...actual,
    cancelBookingFunds: jest.fn(() => Promise.resolve()),
    unfreezeBookingAfterDispute: jest.fn(() => Promise.resolve()),
  };
});

jest.mock('../../src/core/services/invoiceService', () => ({
  approveInvoice: jest.fn(),
  markInvoicePaid: jest.fn(),
  detachBookingFromInvoices: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/payments', () => ({
  refundBookingPayment: jest.fn(),
}));

jest.mock('../../src/core/services/stripeHelpers', () => ({
  findExistingRefund: jest.fn(async () => null),
}));

jest.mock('../../src/core/services/discordNotifier', () => ({
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

const prisma = require('../../src/core/services/prismaClient');
const { refundBookingPayment } = require('../../src/core/services/payments');
const { findExistingRefund } = require('../../src/core/services/stripeHelpers');
const {
  cancelBookingFunds,
  unfreezeBookingAfterDispute,
} = require('../../src/core/services/financeHelpers');
const { detachBookingFromInvoices } = require('../../src/core/services/invoiceService');
const controller = require('../../src/core/domain/adminFinanceController');

const tx = prisma.__tx;

function res() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function req(body = {}) {
  return {
    params: { id: 'd1' },
    body: { outcome: 'CUSTOMER', resolution: 'Approved by support', ...body },
    user: { id: 'admin1' },
  };
}

function booking(overrides = {}) {
  return {
    id: 'b1',
    bookingNumber: 'TRG-1',
    grossAmount: 100,
    refundAmount: 0,
    supplierPayout: 80,
    payoutStatus: 'ELIGIBLE',
    currency: 'USD',
    paymentStatus: 'SUCCEEDED',
    paymentProvider: 'STRIPE',
    stripePaymentIntentId: 'pi_1',
    paypalCaptureId: null,
    travelDate: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
    cancelledAt: null,
    tour: { supplierId: 'sup1' },
    ...overrides,
  };
}

function dispute(bookingOverrides = {}, overrides = {}) {
  return {
    id: 'd1',
    disputeNumber: 'DS-20260101-ABCD',
    supplierId: 'sup1',
    booking: booking(bookingOverrides),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.dispute.findFirst.mockResolvedValue(dispute());
  tx.supplierCharge.create.mockResolvedValue({ id: 'ch1' });
  refundBookingPayment.mockResolvedValue({ id: 're_1', status: 'succeeded', amount: 10000 });
  findExistingRefund.mockResolvedValue(null);
});

describe('resolveDispute — supplier debit', () => {
  it('debits the supplier for a full refund after the payout already left', async () => {
    prisma.dispute.findFirst.mockResolvedValue(dispute({ payoutStatus: 'PAID' }));

    const next = jest.fn();
    await controller.resolveDispute(req({ refundAmount: 100 }), res(), next);

    expect(next).not.toHaveBeenCalled();
    expect(tx.supplierCharge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supplierId: 'sup1',
        bookingId: 'b1',
        amount: 80,
        reason: 'SUPPLIER_REFUND',
        status: 'OPEN',
      }),
    });
    // The payout is history; cancelling it would erase what was already paid.
    expect(cancelBookingFunds).not.toHaveBeenCalled();
    expect(detachBookingFromInvoices).not.toHaveBeenCalled();
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'REFUNDED' }),
      }),
    );
  });

  it('charges nothing and cancels an unpaid payout on a full refund', async () => {
    prisma.dispute.findFirst.mockResolvedValue(dispute({ payoutStatus: 'DISPUTED' }));

    const next = jest.fn();
    await controller.resolveDispute(req({ refundAmount: 100 }), res(), next);

    expect(next).not.toHaveBeenCalled();
    expect(tx.supplierCharge.create).not.toHaveBeenCalled();
    expect(cancelBookingFunds).toHaveBeenCalledWith(tx, 'b1');
    expect(detachBookingFromInvoices).toHaveBeenCalledWith(tx, 'b1');
  });

  it('keeps a partial refund payable and debits the proportional share', async () => {
    prisma.dispute.findFirst.mockResolvedValue(dispute({ payoutStatus: 'PAID' }));

    const next = jest.fn();
    await controller.resolveDispute(req({ refundAmount: 40 }), res(), next);

    expect(next).not.toHaveBeenCalled();
    expect(tx.supplierCharge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 32 }),
    });
    expect(unfreezeBookingAfterDispute).toHaveBeenCalledWith(tx, 'b1');
    // A partial refund is goodwill: the trip still runs, so the booking must
    // stay payable rather than be cancelled / marked REFUNDED.
    const update = tx.booking.update.mock.calls[0][0];
    expect(update.data.status).toBeUndefined();
    expect(update.data.paymentStatus).toBeUndefined();
    expect(update.data.refundAmount).toBe(40);
  });

  it('defaults to the refundable balance, not a previously refunded slice', async () => {
    prisma.dispute.findFirst.mockResolvedValue(dispute({ refundAmount: 30 }));

    const next = jest.fn();
    await controller.resolveDispute(req({}), res(), next);

    expect(next).not.toHaveBeenCalled();
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1' }),
      7000,
      expect.any(Object),
    );
  });

  it('never refunds more than what is left', async () => {
    prisma.dispute.findFirst.mockResolvedValue(dispute({ refundAmount: 90 }));

    const next = jest.fn();
    await controller.resolveDispute(req({ refundAmount: 50 }), res(), next);

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });
});

describe('resolveDispute — provider replay guard', () => {
  it('reuses a refund already issued for this request', async () => {
    findExistingRefund.mockResolvedValue({ id: 're_existing', amount: 10000, status: 'succeeded' });

    const next = jest.fn();
    await controller.resolveDispute(req({ refundAmount: 100 }), res(), next);

    expect(next).not.toHaveBeenCalled();
    expect(findExistingRefund).toHaveBeenCalledWith('pi_1', expect.any(Function));
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it('refuses when a different amount was already refunded for this request', async () => {
    findExistingRefund.mockResolvedValue({ id: 're_existing', amount: 5000, status: 'succeeded' });

    const next = jest.fn();
    await controller.resolveDispute(req({ refundAmount: 100 }), res(), next);

    expect(next.mock.calls[0][0].statusCode).toBe(409);
    expect(refundBookingPayment).not.toHaveBeenCalled();
    expect(tx.supplierCharge.create).not.toHaveBeenCalled();
  });
});
