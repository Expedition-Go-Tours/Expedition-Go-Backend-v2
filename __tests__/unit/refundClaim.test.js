/**
 * Eligibility gate for customer refund claims on completed trips.
 * Pure logic — no DB or network — so it stays fast and focused.
 */

const { assertClaimable, CLAIM_WINDOW_DAYS } = require('../../controllers/refundClaimController');
const AppError = require('../../utils/appError');

const CLAIM_WINDOW_MS = CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function booking(overrides = {}) {
  return {
    id: 'b1',
    status: 'COMPLETED',
    paymentStatus: 'SUCCEEDED',
    grossAmount: 100,
    currency: 'USD',
    refundedAt: null,
    travelDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    ...overrides,
  };
}

describe('assertClaimable (completed-trip refund claim)', () => {
  it('allows a paid COMPLETED booking inside the window', () => {
    expect(assertClaimable(booking(), {})).toBeTruthy();
  });

  it('rejects bookings that have not completed', () => {
    expect(() => assertClaimable(booking({ status: 'CONFIRMED' }), {}))
      .toThrow(AppError);
  });

  it('rejects unpaid bookings', () => {
    expect(() => assertClaimable(booking({ paymentStatus: 'PENDING' }), {}))
      .toThrow(AppError);
  });

  it('rejects bookings already refunded', () => {
    expect(() => assertClaimable(booking({ refundedAt: new Date() }), {}))
      .toThrow(AppError);
    expect(() => assertClaimable(booking({ paymentStatus: 'REFUNDED' }), {}))
      .toThrow(AppError);
  });

  it('rejects bookings older than the claim window', () => {
    const oldTravel = new Date(Date.now() - CLAIM_WINDOW_MS - 1000).toISOString();
    expect(() => assertClaimable(booking({ travelDate: oldTravel }), {}))
      .toThrow(AppError);
  });

  it('allows a booking exactly on the window boundary', () => {
    const edgeTravel = new Date(Date.now() - CLAIM_WINDOW_MS + 1000).toISOString();
    expect(assertClaimable(booking({ travelDate: edgeTravel }), {})).toBeTruthy();
  });
});
