/**
 * Booking-completion notifications.
 *
 * Completing a paid booking does two things: it nudges the customer to leave a
 * review, and it hands the supplier the same review link to forward. These
 * tests pin the guards (only paid bookings, only when a tour/link exists) and
 * that the single `notifyBookingCompleted` entry point fans out to both.
 */
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));

const { enqueueNotification, enqueueEmail } = require('../../src/core/services/queue');
const {
  enqueueReviewRequest,
  enqueueSupplierReviewInvite,
  notifyBookingCompleted,
} = require('../../src/core/services/reviewRequestNotify');

const booking = (overrides = {}) => ({
  id: 'b1',
  customerId: 'u1',
  paymentStatus: 'SUCCEEDED',
  source: 'GHANA',
  clientOrigin: null,
  tourId: 't1',
  tour: { id: 't1', slug: 'accra-dress', title: 'Accra Flying Dress' },
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('enqueueReviewRequest', () => {
  it('notifies the customer for a paid booking and sends no email', () => {
    enqueueReviewRequest(booking());
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'REVIEW_REQUEST' }),
    );
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('skips unpaid bookings', () => {
    enqueueReviewRequest(booking({ paymentStatus: 'PENDING' }));
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('skips a booking with no customer', () => {
    enqueueReviewRequest(booking({ customerId: null }));
    expect(enqueueNotification).not.toHaveBeenCalled();
  });
});

describe('enqueueSupplierReviewInvite', () => {
  it('queues the supplier review-invite email for a paid booking', () => {
    enqueueSupplierReviewInvite(booking());
    expect(enqueueEmail).toHaveBeenCalledWith({ type: 'supplier-review-invite', bookingId: 'b1' });
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('skips unpaid bookings', () => {
    enqueueSupplierReviewInvite(booking({ paymentStatus: 'PENDING' }));
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('skips when there is no tour to link to', () => {
    enqueueSupplierReviewInvite({ id: 'b1', paymentStatus: 'SUCCEEDED' });
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('accepts an explicit tour argument in place of booking.tour', () => {
    enqueueSupplierReviewInvite({ id: 'b1', paymentStatus: 'SUCCEEDED' }, { id: 't9', slug: 'x' });
    expect(enqueueEmail).toHaveBeenCalledWith({ type: 'supplier-review-invite', bookingId: 'b1' });
  });
});

describe('notifyBookingCompleted', () => {
  it('fans out to both the customer nudge and the supplier link once', () => {
    notifyBookingCompleted(booking());
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledWith({ type: 'supplier-review-invite', bookingId: 'b1' });
  });

  it('does nothing for an unpaid booking', () => {
    notifyBookingCompleted(booking({ paymentStatus: 'PENDING' }));
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });
});
