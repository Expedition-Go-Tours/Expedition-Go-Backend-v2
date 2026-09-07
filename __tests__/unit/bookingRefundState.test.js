const { bookingRefundState } = require('../../utils/bookingRefundState');

describe('bookingRefundState', () => {
  it('returns null when there is no refund lifecycle', () => {
    expect(bookingRefundState({ status: 'CONFIRMED', paymentStatus: 'SUCCEEDED', disputes: [] })).toBe(null);
    expect(bookingRefundState({ status: 'PENDING', paymentStatus: 'PENDING', paymentTiming: 'later', disputes: [] })).toBe(null);
    expect(bookingRefundState(null)).toBe(null);
  });

  it('marks a booking open when an OPEN/UNDER_REVIEW refund request exists', () => {
    expect(bookingRefundState({ status: 'CONFIRMED', paymentStatus: 'SUCCEEDED', disputes: [{ status: 'OPEN' }] })).toBe('open');
    expect(bookingRefundState({ status: 'CONFIRMED', paymentStatus: 'SUCCEEDED', disputes: [{ status: 'UNDER_REVIEW' }] })).toBe('open');
  });

  it('marks a customer-cancelled, still-paid booking open (refund pending)', () => {
    expect(bookingRefundState({ status: 'CANCELLED', paymentStatus: 'SUCCEEDED', disputes: [] })).toBe('open');
  });

  it('marks closed when money is back (REFUNDED / refundedAt / RESOLVED_CUSTOMER)', () => {
    expect(bookingRefundState({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundedAt: new Date(), disputes: [] })).toBe('closed');
    expect(bookingRefundState({ status: 'REFUNDED', paymentStatus: 'SUCCEEDED', disputes: [] })).toBe('closed');
    expect(bookingRefundState({ status: 'CANCELLED', paymentStatus: 'SUCCEEDED', refundedAt: new Date(), disputes: [] })).toBe('closed');
    expect(bookingRefundState({ status: 'CONFIRMED', paymentStatus: 'SUCCEEDED', disputes: [{ status: 'RESOLVED_CUSTOMER' }] })).toBe('closed');
  });

  it('treats resolved-supplier / withdrawn disputes as no customer refund', () => {
    expect(bookingRefundState({ status: 'CONFIRMED', paymentStatus: 'SUCCEEDED', disputes: [{ status: 'RESOLVED_SUPPLIER' }] })).toBe(null);
    expect(bookingRefundState({ status: 'CONFIRMED', paymentStatus: 'SUCCEEDED', disputes: [{ status: 'WITHDRAWN' }] })).toBe(null);
  });
});
