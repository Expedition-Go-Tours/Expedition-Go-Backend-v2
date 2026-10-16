/**
 * Customer reserve-later + payment-reminder emails must state the CHARGE date
 * (payLaterChargeAt = travelDate − 24h), not the activity date. The activity
 * date is still shown, as "Experience date", so the two cannot be confused.
 */
jest.mock('resend', () => {
  const send = jest.fn();
  return { Resend: jest.fn(() => ({ emails: { send } })), __send: send };
});
jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn() },
  tour: { findUnique: jest.fn() },
  booking: { findUnique: jest.fn() },
  $disconnect: jest.fn(),
}));

const { __send } = require('resend');
const fmt = require('../../src/core/services/emailFormatting');
const {
  sendReserveLaterConfirmedEmail,
  sendPaymentReminderEmail,
} = require('../../src/core/services/emailService');

beforeAll(() => {
  process.env.RESEND_API_KEY = 're_testkey';
  process.env.EMAIL_FROM = 'Travio Africa <noreply@travioafrica.com>';
  process.env.CLIENT_URL = 'https://travioafrica.com';
  process.env.SUPPORT_EMAIL = 'support@expeditiongo.com';
});

beforeEach(() => {
  jest.clearAllMocks();
  __send.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
});

const H = 60 * 60 * 1000;
const travelDate = new Date('2026-07-01T10:00:00Z');
const chargeLabel = () => fmt.formatLongDate(new Date(travelDate.getTime() - 24 * H));
const travelLabel = () => fmt.formatLongDate(travelDate);

const booking = () => ({
  id: 'booking-1',
  bookingNumber: 'TB-001',
  customerId: 'cust-1',
  tourId: 'tour-1',
  travelDate,
  selectedTime: '10:00',
  travelers: { adults: 2, children: 0, infants: 0 },
  subtotal: 200,
  taxes: 20,
  grossAmount: 220,
  currency: 'USD',
  platformCommission: 33,
  supplierPayout: 187,
  paymentStatus: 'PENDING',
  paymentTiming: 'later',
  customer: { id: 'cust-1', name: 'John Doe', email: 'john@test.com' },
  tour: {
    id: 'tour-1',
    title: 'Test Tour',
    description: 'A wonderful tour',
    productContent: {},
    bookingAndTickets: {
      cancellationPolicy: { text: 'Free cancellation up to 48 hours before your experience.' },
    },
    supplier: { name: 'Supplier Co', email: 's@t.com', phone: '+1234567890' },
  },
});

describe('reserve-later-confirmed email', () => {
  beforeEach(() => {
    delete process.env.PAY_LATER_CHARGE_BEFORE_HOURS;
  });

  it('states the charge date (travel − 24h) and keeps the activity date separate', async () => {
    await sendReserveLaterConfirmedEmail(booking());
    const { subject, html } = __send.mock.calls[0][0];

    expect(subject).not.toContain('\u2014'); // no em dash
    expect(chargeLabel()).not.toBe(travelLabel());
    // The charge date is emitted (it appears nowhere else in the booking data).
    expect(html).toContain(chargeLabel());
    expect(html).toContain(travelLabel());
    expect(html).toContain('Activity date');
    expect(html).toContain('Payment date');
    // inbox preheader also names the charge date
    expect(html).toContain(`We will charge your card on ${chargeLabel()}`);
  });

  it('renders the tour cancellation policy and resolves every placeholder', async () => {
    await sendReserveLaterConfirmedEmail(booking());
    const { html } = __send.mock.calls[0][0];

    expect(html).toContain('Free cancellation up to 48 hours before your experience.');
    expect(html).not.toContain('{{');
  });

  it('falls back to the default policy when the tour has none', async () => {
    const b = booking();
    b.tour.bookingAndTickets = {};
    await sendReserveLaterConfirmedEmail(b);
    expect(__send.mock.calls[0][0].html).toContain('Free cancellation up to 24 hours before your experience.');
  });

  it('honors a tuned PAY_LATER_CHARGE_BEFORE_HOURS', async () => {
    process.env.PAY_LATER_CHARGE_BEFORE_HOURS = '6';
    try {
      await sendReserveLaterConfirmedEmail(booking());
      const { html } = __send.mock.calls[0][0];
      expect(html).toContain(fmt.formatLongDate(new Date(travelDate.getTime() - 6 * H)));
    } finally {
      delete process.env.PAY_LATER_CHARGE_BEFORE_HOURS;
    }
  });

  it('shows the card on file on the Payment method row', async () => {
    await sendReserveLaterConfirmedEmail({
      ...booking(),
      paymentMethodBrand: 'visa',
      paymentMethodLast4: '4242',
    });
    const { html } = __send.mock.calls[0][0];
    expect(html).toContain('Payment method');
    expect(html).toContain('Visa •••• 4242');
  });

  it('hides the Payment method row when there is no card on file', async () => {
    // Pay-now bookings and pre-backfill rows: the row must disappear, not
    // render an empty label.
    await sendReserveLaterConfirmedEmail(booking());
    const { html } = __send.mock.calls[0][0];
    expect(html).not.toContain('Payment method');
    expect(html).not.toContain('{{paymentMethodLabel}}');
  });
});

describe('payment-reminder email', () => {
  beforeEach(() => {
    delete process.env.PAY_LATER_CHARGE_BEFORE_HOURS;
  });

  it('names the charge date, not the activity date', async () => {
    await sendPaymentReminderEmail(booking());
    const { html } = __send.mock.calls[0][0];

    expect(html).toContain(chargeLabel());
    expect(html).toContain('We will collect');
    expect(html).toContain(`We will collect $220.00 on ${chargeLabel()}`);
  });

  it('lets an explicit paymentDate win (rescheduled charge)', async () => {
    const alt = new Date('2026-06-15T00:00:00Z');
    await sendPaymentReminderEmail(booking(), { paymentDate: alt });
    const { html } = __send.mock.calls[0][0];
    expect(html).toContain(fmt.formatLongDate(alt));
    expect(html).not.toContain(chargeLabel());
  });
});
