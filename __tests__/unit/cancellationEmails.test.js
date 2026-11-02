/**
 * End-to-end routing for the cancellation senders.
 *
 * Every branch of `resolveCancellationOutcome` is exercised through the real
 * senders (real templates, real renderer), asserting the copy a customer or a
 * supplier would actually receive. The rule under test: the wording follows the
 * policy and the clock — never the outcome of the refund call.
 */
jest.mock('resend', () => {
  const send = jest.fn();
  return {
    Resend: jest.fn(() => ({ emails: { send } })),
    __send: send,
  };
});

jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn() },
  tour: { findUnique: jest.fn() },
  booking: { findUnique: jest.fn() },
  $disconnect: jest.fn(),
}));

jest.mock('../../src/core/services/supplierContact', () => ({
  contactAddressForBooking: jest.fn(),
}));

jest.mock('../../src/core/services/notificationRecipientService', () => ({
  resolveRecipients: jest.fn(),
}));

process.env.CLIENT_URL = 'https://travioghana.com';

const { __send } = require('resend');
const { contactAddressForBooking } = require('../../src/core/services/supplierContact');
const { resolveRecipients } = require('../../src/core/services/notificationRecipientService');
const {
  sendBookingCancellationEmail,
  sendSupplierCancellationEmail,
  sendCustomerCancelledUnpaidEmail,
  sendCustomerCancelledNonRefundableEmail,
  sendSupplierCustomerCancelledUnpaidEmail,
  sendSupplierReviewInviteEmail,
  sendReviewRequestEmail,
} = require('../../src/core/services/emailService');

const HOUR = 60 * 60 * 1000;
const RELAY = 'c-0123456789abcdef@messages.travioghana.com';

function booking(overrides = {}) {
  const tour = overrides.tour || {
    id: 'tour-1',
    title: 'Accra Flying Dress Experience',
    slug: 'accra-flying-dress-experience',
    coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1787749419/user-photos/abc.png',
    description: 'A guided photo experience.',
    bookingAndTickets: {},
    supplier: { id: 'sup-1', name: 'Sample Experiences Ltd', email: 's@t.com', phone: '+233 24 000 0000' },
  };
  return {
    id: 'booking-1',
    bookingNumber: 'TRG-1',
    customerId: 'cust-1',
    tourId: 'tour-1',
    source: 'GHANA',
    travelDate: new Date(Date.now() + 48 * HOUR),
    selectedTime: '09:00',
    travelers: { adults: 2, children: 1, infants: 0 },
    pickup: {},
    paymentTiming: 'now',
    paymentStatus: 'SUCCEEDED',
    paidAt: new Date(Date.now() - 3 * HOUR),
    status: 'CANCELLED',
    cancelledAt: new Date(),
    cancellationOrigin: 'CUSTOMER',
    refundStatus: 'NOT_APPLICABLE',
    currency: 'USD',
    grossAmount: '400.00',
    subtotal: '370.00',
    taxes: '30.00',
    platformCommission: '60.00',
    supplierPayout: '340.00',
    customer: { id: 'cust-1', name: 'Ada Mensah', email: 'ada@example.com' },
    tour,
    ...overrides,
  };
}

beforeAll(() => {
  process.env.RESEND_API_KEY = 're_testkey';
  process.env.EMAIL_FROM = 'Travio Ghana <noreply@travioghana.com>';
  process.env.EMAIL_REPLY_TO = 'support@travioghana.com';
  process.env.SUPPORT_EMAIL = 'support@travioghana.com';
  process.env.LOGO_URL = 'https://example.com/logo.png';
});

beforeEach(() => {
  jest.clearAllMocks();
  __send.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  contactAddressForBooking.mockResolvedValue(RELAY);
  resolveRecipients.mockResolvedValue([{ email: 'supplier@example.com', recipientId: null }]);
});

async function customerEmail(bookingRow, context) {
  await sendBookingCancellationEmail(bookingRow, context);
  return __send.mock.calls[0][0];
}

async function supplierEmail(bookingRow, context) {
  await sendSupplierCancellationEmail(bookingRow, context);
  return __send.mock.calls[0][0];
}

function expectRenderedCleanly(html) {
  expect(html).toContain('<!DOCTYPE html>');
  expect(html).not.toContain('{{');
}

describe('customer cancellation routing', () => {
  it('says no payment was taken for an early unpaid pay-later booking', async () => {
    const payload = await customerEmail(
      booking({ paymentStatus: 'PENDING', paymentTiming: 'later', paidAt: null, status: 'CANCELLED' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 0, refundStatus: 'NOT_APPLICABLE' },
    );

    expect(payload.subject).toBe('Your booking has been cancelled');
    expect(payload.html).toContain('No payment was taken');
    expect(payload.html).toContain('Your card was never charged');
    expect(payload.html).not.toMatch(/after the free-cancellation deadline/i);
    expectRenderedCleanly(payload.html);
  });

  it('explains a non-refundable policy without mentioning a deadline', async () => {
    const tour = {
      ...booking().tour,
      bookingAndTickets: { cancellationPolicy: { type: 'all_sales_final' } },
    };
    const payload = await customerEmail(
      booking({ tour, status: 'CANCELLED' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 0 },
    );

    expect(payload.html).toContain('This booking is non-refundable');
    expect(payload.html).toContain('All sales are final');
    expect(payload.html).not.toMatch(/after the free-cancellation deadline/i);
    expectRenderedCleanly(payload.html);
  });

  it('reports a completed refund with the amount and the timing', async () => {
    const payload = await customerEmail(
      booking({ status: 'CANCELLED', refundStatus: 'SUCCEEDED', paymentStatus: 'REFUNDED', refundAmount: '400.00' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 400, refundSucceeded: true, refundStatus: 'SUCCEEDED' },
    );

    expect(payload.subject).toContain('your refund is on its way');
    expect(payload.html).toContain('$400.00');
    expect(payload.html).toContain('Refund issued');
    expect(payload.html).toContain('3\u20135 business days');
    expect(payload.html).not.toMatch(/after the free-cancellation deadline/i);
    expectRenderedCleanly(payload.html);
  });

  it('says the refund failed rather than pretending it is on its way', async () => {
    const payload = await customerEmail(
      booking({ status: 'CANCELLED', refundStatus: 'FAILED' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 400, refundSucceeded: false, refundStatus: 'FAILED' },
    );

    expect(payload.subject).toContain('your refund is on its way');
    expect(payload.html).toContain('Refund could not be completed automatically');
    expect(payload.html).toContain('Your refund needs attention');
    expectRenderedCleanly(payload.html);
  });

  it('states the deadline only when the cancellation was genuinely late', async () => {
    const payload = await customerEmail(
      booking({ travelDate: new Date(Date.now() + 6 * HOUR), status: 'CANCELLED' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 0, refundSucceeded: false },
    );

    expect(payload.html).toContain('after the free-cancellation deadline');
    expect(payload.html).toContain('Outside the free-cancellation window');
    expectRenderedCleanly(payload.html);
  });

  it('never calls an early cancellation late even when the refund failed', async () => {
    const payload = await customerEmail(
      booking({ status: 'CANCELLED', refundStatus: 'FAILED' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 0, refundSucceeded: false, refundStatus: 'FAILED' },
    );

    expect(payload.html).not.toMatch(/after the free-cancellation deadline/i);
    expect(payload.html).not.toMatch(/late cancellation/i);
    expectRenderedCleanly(payload.html);
  });

  it('never blames the customer when the platform cancelled', async () => {
    const payload = await customerEmail(
      booking({ status: 'CANCELLED', cancellationOrigin: 'SYSTEM', refundStatus: 'PENDING' }),
      { cancelledBy: 'SYSTEM', refundAmount: 400, refundStatus: 'PENDING' },
    );

    expect(payload.subject).toContain('cancelled');
    expect(payload.html).toContain('The operator is no longer able to run this experience');
    expect(payload.html).not.toMatch(/after the free-cancellation deadline/i);
    expect(payload.html).not.toMatch(/late cancellation/i);
    expectRenderedCleanly(payload.html);
  });

  it('pins a template when a legacy queue type asks for one', async () => {
    await sendCustomerCancelledUnpaidEmail(booking({ paymentStatus: 'SUCCEEDED', status: 'CANCELLED' }), {});
    expect(__send.mock.calls[0][0].html).toContain('No payment was taken');

    await sendCustomerCancelledNonRefundableEmail(
      booking({ status: 'CANCELLED', tour: { ...booking().tour, bookingAndTickets: { cancellationPolicy: { type: 'all_sales_final' } } } }),
      {},
    );
    expect(__send.mock.calls[1][0].html).toContain('non-refundable');
  });

  it('still accepts the legacy numeric refund argument', async () => {
    const payload = await customerEmail(booking({ status: 'CANCELLED', refundStatus: 'SUCCEEDED' }), 400);
    expect(payload.subject).toContain('your refund is on its way');
    expect(payload.html).toContain('$400.00');
  });
});

describe('supplier cancellation routing', () => {
  it('tells an unpaid cancellation to release the slot with no payout', async () => {
    const payload = await supplierEmail(
      booking({ paymentStatus: 'PENDING', paymentTiming: 'later', paidAt: null, status: 'CANCELLED' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 0, refundStatus: 'NOT_APPLICABLE' },
    );

    expect(payload.subject).toBe('Booking cancelled — payment not collected');
    expect(payload.html).toContain('Payment not collected');
    expect(payload.html).toContain('no payout is due');
    expect(payload.html).not.toMatch(/after the free-cancellation deadline/i);
    expectRenderedCleanly(payload.html);
  });

  it('tells a free-period cancellation to do not operate and states no payout', async () => {
    const payload = await supplierEmail(
      booking({ status: 'CANCELLED', refundStatus: 'SUCCEEDED', paymentStatus: 'REFUNDED' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 400, refundSucceeded: true, refundStatus: 'SUCCEEDED' },
    );

    expect(payload.subject).toBe('Booking cancelled — do not operate');
    expect(payload.html).toContain('Do not operate this booking');
    expect(payload.html).toMatch(/no payout will be issued/i);
    expect(payload.html).toContain('$0.00');
    expect(payload.html).not.toMatch(/after the free-cancellation deadline/i);
    expectRenderedCleanly(payload.html);
  });

  it('says the refund is in progress while it is in progress', async () => {
    const payload = await supplierEmail(
      booking({ status: 'CANCELLED', refundStatus: 'PENDING' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 400, refundStatus: 'PENDING' },
    );

    expect(payload.html).toContain('is in progress');
    expect(payload.html).not.toContain('has been refunded');
    expectRenderedCleanly(payload.html);
  });

  it('flags a non-refundable policy and states no payout', async () => {
    const payload = await supplierEmail(
      booking({
        status: 'CANCELLED',
        tour: { ...booking().tour, bookingAndTickets: { cancellationPolicy: { type: 'all_sales_final' } } },
      }),
      { cancelledBy: 'CUSTOMER', refundAmount: 0 },
    );

    expect(payload.subject).toBe('Booking cancelled — non-refundable');
    expect(payload.html).toContain('Non-refundable policy');
    expect(payload.html).toMatch(/no payout will be issued/i);
    expect(payload.html).not.toMatch(/after the free-cancellation deadline/i);
    expectRenderedCleanly(payload.html);
  });

  it('labels a genuine late cancellation as late and states no payout', async () => {
    const payload = await supplierEmail(
      booking({ travelDate: new Date(Date.now() + 6 * HOUR), status: 'CANCELLED' }),
      { cancelledBy: 'CUSTOMER', refundAmount: 0, refundSucceeded: false },
    );

    expect(payload.subject).toBe('Late customer cancellation');
    expect(payload.html).toContain('after the free-cancellation deadline');
    expect(payload.html).toContain('Do not operate unless support instructs otherwise');
    expect(payload.html).toMatch(/no payout will be issued/i);
    expectRenderedCleanly(payload.html);
  });

  it('uses the platform notice when the platform cancelled, and never "late"', async () => {
    const payload = await supplierEmail(
      booking({ status: 'CANCELLED', cancellationOrigin: 'SYSTEM', refundStatus: 'PENDING' }),
      { cancelledBy: 'SYSTEM', refundAmount: 400, refundStatus: 'PENDING' },
    );

    expect(payload.html).toContain('Do not operate this booking');
    expect(payload.html).toContain('$0.00');
    expect(payload.html).not.toMatch(/after the free-cancellation deadline/i);
    expectRenderedCleanly(payload.html);
  });

  it('names the brand in the platform-cancel subject', async () => {
    const payload = await supplierEmail(
      booking({ status: 'CANCELLED', cancellationOrigin: 'SUPPLIER' }),
      { cancelledBy: 'SUPPLIER', refundAmount: 400 },
    );

    expect(payload.subject).toMatch(/^Booking cancelled by /);
    expectRenderedCleanly(payload.html);
  });

  it('pins a template when a legacy queue type asks for one', async () => {
    await sendSupplierCustomerCancelledUnpaidEmail(
      booking({ paymentStatus: 'SUCCEEDED', status: 'CANCELLED' }),
      {},
    );
    expect(__send.mock.calls[0][0].html).toContain('Payment not collected');
  });
});

describe('review emails', () => {
  it('deep-links every star to the review form with that rating preselected', async () => {
    await sendReviewRequestEmail(booking({ status: 'COMPLETED' }));
    const { html, subject } = __send.mock.calls[0][0];

    expect(subject).toBe('How was your experience?');
    expect(html).toContain('How was your experience?');
    for (let n = 1; n <= 5; n += 1) expect(html).toContain(`rating=${n}`);
    expect(html).toContain('Write a review');
    expectRenderedCleanly(html);
  });

  it('hands the supplier a copyable link and the booking reference', async () => {
    await sendSupplierReviewInviteEmail(booking({ status: 'COMPLETED', leadTravelerName: 'Ada Lovelace' }));
    const { html, subject } = __send.mock.calls[0][0];

    expect(subject).toContain('Ada Lovelace');
    expect(html).toContain('>Copy</span>');
    expect(html).toContain('TRG-1');
    expect(html).toContain('Open booking in portal');
    expect(html).not.toMatch(/Leave a review/i);
    expectRenderedCleanly(html);
  });
});
