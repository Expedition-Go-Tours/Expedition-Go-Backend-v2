// Unit tests for the shared money predicates in financeHelpers.js — the one
// status clause that decides what a supplier is owed, used by the v2 "eligible
// now" aggregates, the eligibility sweep and (via PAYABLE_BOOKING_STATUSES)
// the finance-v3 invoice selection.
jest.mock('../../src/core/services/prismaClient', () => ({}));

const {
  PAYABLE_BOOKING_STATUSES,
  payoutBookingsWhere,
  eligibleBookingsWhere,
  detachBookingFromActiveRequests,
} = require('../../src/core/services/financeHelpers');

describe('PAYABLE_BOOKING_STATUSES', () => {
  it('includes NO_SHOW — non-refundable, supplier performed (GYG T&C §3.9(ii))', () => {
    expect(PAYABLE_BOOKING_STATUSES).toEqual(['CONFIRMED', 'COMPLETED', 'NO_SHOW']);
  });

  it('never pays refunded, cancelled or unconfirmed money', () => {
    expect(PAYABLE_BOOKING_STATUSES).not.toContain('CANCELLED');
    expect(PAYABLE_BOOKING_STATUSES).not.toContain('REFUNDED');
    expect(PAYABLE_BOOKING_STATUSES).not.toContain('PENDING');
  });
});

describe('payoutBookingsWhere', () => {
  it('keeps every money guard while paying no-shows', () => {
    expect(payoutBookingsWhere({ supplierId: 'sup-1' })).toEqual({
      isSimulated: false,
      payoutStatus: 'ELIGIBLE',
      paymentStatus: 'SUCCEEDED',
      status: { in: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] },
      // A supplier-created booking is cash the supplier already holds: it must
      // never enter the payout pipeline, or they are paid twice.
      origin: { not: 'SUPPLIER_CREATED' },
      tour: { supplierId: 'sup-1' },
    });
  });

  it('supports batch aggregates and an explicit payoutStatus', () => {
    const where = payoutBookingsWhere({ supplierIds: ['a', 'b'], payoutStatus: 'PENDING' });
    expect(where.payoutStatus).toBe('PENDING');
    expect(where.tour).toEqual({ supplierId: { in: ['a', 'b'] } });
    expect(where.status.in).toContain('NO_SHOW');
  });

  it('omits the tour scope when no supplier is given', () => {
    expect(payoutBookingsWhere()).not.toHaveProperty('tour');
  });

  it('eligibleBookingsWhere is the claimable default (ELIGIBLE, one supplier)', () => {
    expect(eligibleBookingsWhere('sup-1')).toEqual(payoutBookingsWhere({ supplierId: 'sup-1' }));
    expect(eligibleBookingsWhere('sup-1').payoutStatus).toBe('ELIGIBLE');
  });
});

describe('detachBookingFromActiveRequests', () => {
  const item = (bookingCount) => ({
    id: 'item1',
    supplierPayout: 80,
    payoutRequest: { id: 'pr1', bookingCount, status: 'PROCESSING' },
  });

  const txFor = (bookingCount) => ({
    payoutRequestItem: {
      findMany: jest.fn(async () => [item(bookingCount)]),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      delete: jest.fn(async () => ({})),
    },
    payoutRequest: { update: jest.fn(async () => ({})) },
    supplierCharge: { updateMany: jest.fn(async () => ({ count: 1 })) },
  });

  it('returns charges to the open pool when the whole request is cancelled', async () => {
    const tx = txFor(1);
    await detachBookingFromActiveRequests(tx, 'b1');

    expect(tx.payoutRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    expect(tx.payoutRequestItem.deleteMany).toHaveBeenCalledWith({ where: { payoutRequestId: 'pr1' } });
    // A cancelled request never pays. Charges it had already netted off must
    // stay collectable from the next payout, or the supplier keeps them.
    expect(tx.supplierCharge.updateMany).toHaveBeenCalledWith({
      where: { payoutRequestId: 'pr1', status: 'SETTLED' },
      data: { status: 'OPEN', payoutRequestId: null, settledAt: null },
    });
  });

  it('keeps settled charges on a request that still has other bookings', async () => {
    const tx = txFor(2);
    await detachBookingFromActiveRequests(tx, 'b1');

    expect(tx.payoutRequestItem.delete).toHaveBeenCalledWith({ where: { id: 'item1' } });
    expect(tx.payoutRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { amount: { decrement: 80 }, bookingCount: { decrement: 1 } },
      }),
    );
    // The surviving request still collects those charges; releasing them here
    // would deduct them a second time on the next payout.
    expect(tx.supplierCharge.updateMany).not.toHaveBeenCalled();
  });
});
