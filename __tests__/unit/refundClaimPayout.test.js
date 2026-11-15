/**
 * Money-safety rules for the completed-trip refund claim.
 *
 * Three failures this locks down:
 *  - a claim must freeze the supplier payout while it is open;
 *  - a supplier cannot approve a claim on their own booking;
 *  - releasing a claim whose payout already left must debit the supplier,
 *    exactly once, with a deterministic provider idempotency key.
 */

jest.mock('../../src/core/services/prismaClient', () => {
  const transactionClient = {
    $queryRaw: jest.fn(),
    refundClaim: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    booking: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    dispute: { findFirst: jest.fn() },
    supplierCharge: { create: jest.fn() },
  };
  return {
    __tx: transactionClient,
    $transaction: jest.fn((fn) => fn(transactionClient)),
    refundClaim: { findFirst: jest.fn(), updateMany: jest.fn(), create: jest.fn(), findMany: jest.fn() },
    booking: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    teamMember: { findFirst: jest.fn() },
  };
});

jest.mock('../../src/core/services/payments', () => ({
  refundBookingPayment: jest.fn(),
}));

jest.mock('../../src/core/services/stripeHelpers', () => ({
  getStripe: jest.fn(() => ({
    refunds: { list: jest.fn(async () => ({ data: [] })) },
  })),
}));

jest.mock('../../src/core/services/financeHelpers', () => ({
  freezeBookingForDispute: jest.fn(() => Promise.resolve()),
  unfreezeBookingAfterDispute: jest.fn(() => Promise.resolve()),
  cancelBookingFunds: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  resolveEmailBrand: jest.fn(() => 'ghana'),
}));

jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/ga4Measurement', () => ({
  sendRefund: jest.fn(() => Promise.resolve({ ok: true })),
}));

const prisma = require('../../src/core/services/prismaClient');
const { refundBookingPayment } = require('../../src/core/services/payments');
const {
  freezeBookingForDispute,
  unfreezeBookingAfterDispute,
  cancelBookingFunds,
} = require('../../src/core/services/financeHelpers');
const controller = require('../../src/core/domain/refundClaimController');

const tx = prisma.__tx;

function res() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function adminBooking(overrides = {}) {
  return {
    id: 'b1',
    customerId: 'cust1',
    bookingNumber: 'TRG-1',
    status: 'COMPLETED',
    grossAmount: 100,
    refundAmount: 0,
    supplierPayout: 80,
    payoutStatus: 'ELIGIBLE',
    currency: 'USD',
    refundedAt: null,
    paymentStatus: 'SUCCEEDED',
    paymentProvider: 'STRIPE',
    stripePaymentIntentId: 'pi_1',
    paypalCaptureId: null,
    clientOrigin: 'https://travio.test',
    source: 'MARKETPLACE',
    tour: { title: 'City Tour', supplierId: 'sup1' },
    ...overrides,
  };
}

function adminClaim(booking = adminBooking()) {
  return {
    id: 'rc1',
    claimNumber: 'RC-20260101-ABCD',
    bookingId: 'b1',
    supplierId: 'sup1',
    status: 'SUPPLIER_APPROVED',
    booking,
  };
}

function adminReq(body = {}) {
  return { params: { id: 'rc1' }, body, user: { id: 'admin1', email: 'admin@travio.test' } };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.findUnique.mockResolvedValue({
    id: 'b1',
    bookingNumber: 'TRG-1',
    currency: 'USD',
    grossAmount: 100,
    gaClientId: 'ga1',
    analyticsConsent: true,
  });
  prisma.booking.findFirst.mockResolvedValue(adminBooking());
  prisma.user.findUnique.mockResolvedValue({ email: 'customer@example.com', name: 'Customer' });
  prisma.teamMember.findFirst.mockResolvedValue(null);
  tx.refundClaim.findUnique.mockResolvedValue({ status: 'SUPPLIER_APPROVED' });
  tx.booking.findUnique.mockResolvedValue(adminBooking());
  tx.dispute.findFirst.mockResolvedValue(null);
  tx.refundClaim.update.mockResolvedValue({});
  tx.booking.update.mockResolvedValue({});
  tx.refundClaim.create.mockImplementation(async ({ data }) => ({ id: 'rc1', ...data }));
  tx.supplierCharge.create.mockResolvedValue({ id: 'ch1' });
  prisma.refundClaim.updateMany.mockResolvedValue({ count: 1 });
  refundBookingPayment.mockResolvedValue({ id: 're_1', status: 'succeeded' });
});

describe('submitRefundClaim — payout freeze', () => {
  it('freezes the supplier share while the claim is open', async () => {
    tx.booking.findFirst.mockResolvedValue(
      adminBooking({
        status: 'COMPLETED',
        paymentStatus: 'SUCCEEDED',
        travelDate: new Date(Date.now() - 24 * 3600 * 1000),
        disputes: [],
        refundClaims: [],
      }),
    );
    prisma.refundClaim.create.mockImplementation(async ({ data }) => ({ id: 'rc1', ...data }));

    const next = jest.fn();
    await controller.submitRefundClaim(
      {
        user: { id: 'cust1', email: 'customer@example.com' },
        params: { id: 'b1' },
        body: { reason: 'GUIDE_ISSUE', type: 'FULL' },
      },
      res(),
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(freezeBookingForDispute).toHaveBeenCalledWith(tx, 'b1');
  });
});

describe('supplierApprove — independent review', () => {
  it('refuses when the customer is the supplier themselves', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(
      adminClaim(adminBooking({ customerId: 'sup1' })),
    );

    const next = jest.fn();
    await controller.supplierApprove(
      { params: { id: 'rc1' }, supplierId: 'sup1', user: { id: 'sup1', email: 'owner@sup.test' } },
      res(),
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(prisma.refundClaim.updateMany).not.toHaveBeenCalled();
  });

  it('refuses when the customer sits on the supplier team by email', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(adminClaim());
    prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm1' });

    const next = jest.fn();
    await controller.supplierApprove(
      { params: { id: 'rc1' }, supplierId: 'sup1', user: { id: 'owner1', email: 'owner@sup.test' } },
      res(),
      next,
    );

    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(prisma.refundClaim.updateMany).not.toHaveBeenCalled();
  });

  it('approves for an unrelated customer', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(adminClaim());
    tx.refundClaim.updateMany.mockResolvedValue({ count: 1 });

    const next = jest.fn();
    await controller.supplierApprove(
      { params: { id: 'rc1' }, supplierId: 'sup1', user: { id: 'owner1', email: 'owner@sup.test' } },
      res(),
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(prisma.refundClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rc1', supplierId: 'sup1', status: 'SUBMITTED' } }),
    );
  });
});

describe('adminRelease — who pays', () => {
  it('debits the supplier when the payout already left', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(
      adminClaim(adminBooking({ payoutStatus: 'PAID' })),
    );
    tx.booking.findUnique.mockResolvedValue(adminBooking({ payoutStatus: 'PAID' }));

    const next = jest.fn();
    const response = res();
    await controller.adminRelease(adminReq({ releasedAmount: 100 }), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1' }),
      10000,
      expect.objectContaining({ idempotencyKey: 'refund_claim_rc1' }),
    );
    expect(tx.supplierCharge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supplierId: 'sup1',
        bookingId: 'b1',
        amount: 80,
        reason: 'CUSTOMER_REFUND_CLAIM',
        status: 'OPEN',
      }),
    });
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REFUNDED', paymentStatus: 'REFUNDED' }),
      }),
    );
    // The payout is history now; cancelling it would erase what was paid.
    expect(cancelBookingFunds).not.toHaveBeenCalled();
  });

  it('charges nothing and cancels an unpaid payout on a full refund', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(
      adminClaim(adminBooking({ payoutStatus: 'DISPUTED' })),
    );
    tx.booking.findUnique.mockResolvedValue(adminBooking({ payoutStatus: 'DISPUTED' }));

    const next = jest.fn();
    await controller.adminRelease(adminReq({ releasedAmount: 100 }), res(), next);

    expect(next).not.toHaveBeenCalled();
    expect(tx.supplierCharge.create).not.toHaveBeenCalled();
    expect(cancelBookingFunds).toHaveBeenCalledWith(tx, 'b1');
  });

  it('keeps a partial refund payable and debits the proportional share', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(
      adminClaim(adminBooking({ payoutStatus: 'PAID' })),
    );
    tx.booking.findUnique.mockResolvedValue(adminBooking({ payoutStatus: 'PAID' }));

    const next = jest.fn();
    await controller.adminRelease(adminReq({ releasedAmount: 50 }), res(), next);

    expect(next).not.toHaveBeenCalled();
    expect(tx.supplierCharge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 40 }),
    });
    expect(unfreezeBookingAfterDispute).toHaveBeenCalledWith(tx, 'b1');
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: expect.objectContaining({ refundAmount: 50 }),
    });
  });

  it('refuses to release while a dispute is still open', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(adminClaim());
    tx.dispute.findFirst.mockResolvedValue({ id: 'd1', disputeNumber: 'DR-1' });

    const next = jest.fn();
    await controller.adminRelease(adminReq({ releasedAmount: 100 }), res(), next);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(409);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it('never releases more than what is left to refund', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(adminClaim(adminBooking({ refundAmount: 90 })));
    tx.booking.findUnique.mockResolvedValue(adminBooking({ refundAmount: 90 }));

    const next = jest.fn();
    await controller.adminRelease(adminReq({ releasedAmount: 50 }), res(), next);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it('reuses a refund that already exists for this claim instead of paying twice', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(adminClaim());
    const { getStripe } = require('../../src/core/services/stripeHelpers');
    getStripe.mockReturnValueOnce({
      refunds: {
        list: jest.fn(async () => ({
          data: [{ id: 're_existing', amount: 10000, status: 'succeeded', metadata: { claimId: 'rc1' } }],
        })),
      },
    });

    const next = jest.fn();
    await controller.adminRelease(adminReq({ releasedAmount: 100 }), res(), next);

    expect(next).not.toHaveBeenCalled();
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it('refuses when a different amount was already refunded for this claim', async () => {
    prisma.refundClaim.findFirst.mockResolvedValue(adminClaim());
    const { getStripe } = require('../../src/core/services/stripeHelpers');
    getStripe.mockReturnValueOnce({
      refunds: {
        list: jest.fn(async () => ({
          data: [{ id: 're_existing', amount: 5000, status: 'succeeded', metadata: { claimId: 'rc1' } }],
        })),
      },
    });

    const next = jest.fn();
    await controller.adminRelease(adminReq({ releasedAmount: 100 }), res(), next);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(409);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });
});
