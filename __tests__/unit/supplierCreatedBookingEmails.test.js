/**
 * Supplier-created booking emails.
 *
 * Two audiences, two truths:
 *
 *  - The guest booked with the SUPPLIER. They must get the familiar
 *    confirmation layout, but no sentence may imply TravioGhana took their
 *    money, and no account/voucher links are offered because a walk-in guest
 *    has no login.
 *  - The supplier already holds the money. Their record must not show a
 *    platform "payout" (nothing will ever be paid out for this booking) and
 *    must state the commission rate that applies to money they collect.
 *
 * Assertions run against the compiled artifacts the send path delivers, plus
 * one full render per audience so the data wiring is covered too.
 */

const fs = require('fs');
const path = require('path');

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
  bookingCollection: { aggregate: jest.fn() },
  $disconnect: jest.fn(),
}));

jest.mock('../../src/core/services/notificationRecipientService', () => ({
  resolveRecipients: jest.fn(async () => [{ email: 'ops@accrawalks.com', recipientId: null }]),
}));

jest.mock('../../src/core/services/supplierContact', () => ({
  contactAddressForBooking: jest.fn(async () => 'relay-scb@messages.travioghana.com'),
}));

process.env.CLIENT_URL = 'https://travioghana.com';

const { Resend, __send } = require('resend');
const prisma = require('../../src/core/services/prismaClient');

const GENERATED = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');
const guestArtifact = fs.readFileSync(path.join(GENERATED, 'supplier-created-booking-confirmation.html'), 'utf8');
const supplierArtifact = fs.readFileSync(path.join(GENERATED, 'supplier-booking-recorded.html'), 'utf8');

const {
  sendSupplierCreatedBookingEmail,
  sendSupplierBookingRecordedEmail,
} = require('../../src/core/services/emailService');

beforeAll(() => {
  process.env.RESEND_API_KEY = 're_testkey';
  process.env.EMAIL_FROM = 'Travio Ghana <noreply@travioghana.com>';
  process.env.EMAIL_REPLY_TO = 'support@travioghana.com';
  process.env.SUPPORT_EMAIL = 'support@travioghana.com';
  process.env.LOGO_URL = 'https://example.com/logo.png';
});

beforeEach(() => {
  jest.clearAllMocks();
  Resend.mockClear();
  __send.mockResolvedValue({ data: { id: 'msg-123' }, error: null });
  prisma.bookingCollection.aggregate.mockResolvedValue({ _sum: { amount: 150 } });
  // No destination data means "no recommendations" without a listing query.
  prisma.tour.findUnique.mockResolvedValue({ destinationCity: null, city: null, region: null });
  prisma.user.findUnique.mockResolvedValue({ email: 'ops@accrawalks.com' });
});

function buildBooking(over = {}) {
  return {
    id: 'bk_scb_1',
    bookingNumber: 'TRG-2026-0001',
    source: 'GHANA',
    customerId: null,
    guestId: 'guest_1',
    guest: { id: 'guest_1', name: 'Ama Mensah', email: 'ama@example.com', phone: '+233201234567' },
    customer: null,
    grossAmount: 400,
    subtotal: 400,
    taxes: 0,
    currency: 'USD',
    commissionRate: 0.15,
    commissionPolicy: 'APPLY',
    platformCommission: 0,
    supplierPayout: 400,
    paymentStatus: 'PENDING',
    paymentTiming: 'now',
    status: 'PENDING',
    travelDate: new Date('2026-11-04T00:00:00.000Z'),
    selectedTime: '09:00',
    travelers: { adults: 2 },
    leadTravelerName: 'Ama Mensah',
    leadTravelerEmail: 'ama@example.com',
    leadTravelerPhone: '+233201234567',
    specialRequests: 'One vegetarian lunch',
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    optionId: null,
    tour: {
      id: 'tour_1',
      title: 'Accra Walking Tour',
      slug: 'accra-walking-tour',
      description: 'A walk through the old town.',
      photos: [],
      coverPhoto: '',
      productContent: {},
      bookingAndTickets: {},
      categorization: {},
      schedulesAndPricing: { pricingSchedules: { currency: 'USD' } },
      supplier: {
        id: 'sup_1',
        name: 'Accra Walks',
        email: 'ops@accrawalks.com',
        phone: '+233244000000',
      },
    },
    ...over,
  };
}

describe('supplier-created-booking-confirmation artifact', () => {
  it('keeps the booking-confirmed layout the guest already knows', () => {
    expect(guestArtifact).toContain('Your booking is confirmed');
    expect(guestArtifact).toContain('Key facts');
    expect(guestArtifact).toContain('Booking details');
    expect(guestArtifact).toContain('What happens next');
  });

  it('never claims the platform took a payment', () => {
    expect(guestArtifact).toContain('Recorded as collected');
    expect(guestArtifact).toContain('Balance due to the supplier');
    expect(guestArtifact).toContain('{{paidDirectlyNote}}');
    expect(guestArtifact).not.toContain('Amount paid');
    expect(guestArtifact).not.toContain('Paid to {{brandName}}');
    expect(guestArtifact).not.toContain('Payment successful');
  });

  it('offers no account-only links to a guest without an account', () => {
    expect(guestArtifact).not.toContain('{{voucherUrl}}');
    expect(guestArtifact).not.toContain('{{manageUrl}}');
    expect(guestArtifact).not.toContain('{{bookingUrl}}');
    expect(guestArtifact).toContain('{{supplierContactUrl}}');
  });

  it('contains no em dashes and no emoji codepoints', () => {
    expect(guestArtifact).not.toContain('\u2014');
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(guestArtifact)).toBe(false);
  });
});

describe('supplier-booking-recorded artifact', () => {
  it('shows what was collected and what is still owed by the guest', () => {
    expect(supplierArtifact).toContain('Recorded as collected');
    expect(supplierArtifact).toContain('Still to collect from the guest');
    expect(supplierArtifact).toContain('{{collectedLabel}}');
  });

  it('does not show a platform payout the supplier will never receive', () => {
    expect(supplierArtifact).not.toContain('Your payout');
    expect(supplierArtifact).not.toContain('{{payoutAmountLabel}}');
    expect(supplierArtifact).not.toContain('Platform commission');
    expect(supplierArtifact).toContain('{{commissionRateLabel}}');
  });

  it('contains no em dashes and no emoji codepoints', () => {
    expect(supplierArtifact).not.toContain('\u2014');
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(supplierArtifact)).toBe(false);
  });
});

describe('sendSupplierCreatedBookingEmail', () => {
  it('addresses the guest and states that the supplier takes the money', async () => {
    const booking = buildBooking();
    // A guest booking has no customer account, so the email layer re-reads the
    // row by id; hand it back the same fixture.
    prisma.booking.findUnique.mockResolvedValue(booking);

    const result = await sendSupplierCreatedBookingEmail(booking);
    expect(result.success).toBe(true);

    expect(__send).toHaveBeenCalledTimes(1);
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('ama@example.com');
    expect(payload.subject).toContain('Accra Walks');
    expect(payload.subject).toContain('TRG-2026-0001');
    expect(payload.html).toContain('Ama Mensah');
    expect(payload.html).toContain('$150.00');
    expect(payload.html).toContain('$250.00');
    expect(payload.html).toContain('has not taken any payment');
    expect(payload.html).not.toContain('Amount paid');
    expect(payload.html).not.toContain('Your payout');
    // A corrected row is REVERSED; only rows that still stand may be summed.
    expect(prisma.bookingCollection.aggregate).toHaveBeenCalledWith({
      where: { bookingId: 'bk_scb_1', status: 'RECORDED' },
      _sum: { amount: true },
    });
  });

  it('sends nothing when the guest has no email address', async () => {
    const booking = buildBooking({
      guest: { id: 'guest_1', name: 'Ama Mensah', email: '', phone: '+233201234567' },
    });
    prisma.booking.findUnique.mockResolvedValue(booking);

    const result = await sendSupplierCreatedBookingEmail(booking);
    expect(result).toBeNull();
    expect(__send).not.toHaveBeenCalled();
  });
});

describe('sendSupplierBookingRecordedEmail', () => {
  it('gives the supplier their own record, with the guest contact and the rate', async () => {
    const booking = buildBooking();
    prisma.booking.findUnique.mockResolvedValue(booking);

    const result = await sendSupplierBookingRecordedEmail(booking);
    expect(result.success).toBe(true);

    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('ops@accrawalks.com');
    expect(payload.subject).toContain('Booking recorded');
    expect(payload.html).toContain('Ama Mensah');
    // The supplier typed this address for their own booking: showing it is the
    // point, so the relay mask is deliberately not applied here.
    expect(payload.html).toContain('ama@example.com');
    expect(payload.html).toContain('Commission of 15%');
    expect(payload.html).toContain('$150.00');
    expect(payload.html).not.toContain('Your payout');
  });

  it('relays a registered customer\'s address instead of exposing it', async () => {
    const booking = buildBooking({
      guest: null,
      guestId: null,
      customerId: 'cus_1',
      customer: { id: 'cus_1', name: 'Ama Mensah', email: 'ama@example.com', phone: '+233201234567' },
    });
    prisma.booking.findUnique.mockResolvedValue(booking);

    await sendSupplierBookingRecordedEmail(booking);
    const payload = __send.mock.calls[0][0];
    expect(payload.html).toContain('relay-scb@messages.travioghana.com');
    expect(payload.html).not.toContain('ama@example.com');
  });

  it('says commission is waived when the booking froze a waiver', async () => {
    const booking = buildBooking({ commissionPolicy: 'WAIVE', commissionRate: 0 });
    prisma.booking.findUnique.mockResolvedValue(booking);

    await sendSupplierBookingRecordedEmail(booking);
    const payload = __send.mock.calls[0][0];
    expect(payload.html).toContain('Commission is waived on this booking.');
    expect(payload.html).not.toContain('Commission of');
  });
});
