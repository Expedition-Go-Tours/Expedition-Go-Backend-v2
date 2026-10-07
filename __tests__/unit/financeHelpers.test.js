// Unit tests for the shared money predicates in financeHelpers.js — the one
// status clause that decides what a supplier is owed, used by the v2 "eligible
// now" aggregates, the eligibility sweep and (via PAYABLE_BOOKING_STATUSES)
// the finance-v3 invoice selection.
jest.mock('../../src/core/services/prismaClient', () => ({}));

const {
  PAYABLE_BOOKING_STATUSES,
  payoutBookingsWhere,
  eligibleBookingsWhere,
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
