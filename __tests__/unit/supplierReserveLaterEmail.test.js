/**
 * Supplier reserve-now-pay-later email.
 *
 * This is the sanctioned pre-charge supplier email (see the a3195e7 exception
 * documented at the enqueue sites). It must state the CHARGE date
 * (payLaterChargeAt = travelDate − 24h), never imply the card has been charged,
 * and degrade the hero image gracefully when a tour has no photo.
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
jest.mock('../../src/core/services/notificationRecipientService', () => ({
  resolveRecipients: jest.fn(() => Promise.resolve([{ email: 'supplier@test.com', recipientId: null }])),
}));

// Set BEFORE the requires below: config/emailUrls.js reads CLIENT_URL once at
// module load, so a later assignment (beforeAll) has no effect and the deep
// links silently fall back to the default origin.
process.env.CLIENT_URL = 'https://travioafrica.com';

const { __send } = require('resend');
const fmt = require('../../src/core/services/emailFormatting');
const { sendSupplierReserveLaterEmail } = require('../../src/core/services/emailService');

beforeAll(() => {
  process.env.RESEND_API_KEY = 're_testkey';
  process.env.EMAIL_FROM = 'Travio Africa <noreply@travioafrica.com>';
  process.env.SUPPORT_EMAIL = 'support@expeditiongo.com';
});

beforeEach(() => {
  jest.clearAllMocks();
  __send.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
});

const H = 60 * 60 * 1000;
const travelDate = new Date('2026-07-01T10:00:00Z');
const chargeLabel = () => fmt.formatLongDate(new Date(travelDate.getTime() - 24 * H));
const CLOUDINARY = 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1787749419/user-photos/abc.png';

const booking = (overrides = {}) => ({
  id: 'booking-1',
  bookingNumber: 'TRG-001',
  customerId: 'cust-1',
  tourId: 'tour-1',
  travelDate,
  createdAt: new Date('2026-06-09T12:00:00Z'),
  selectedTime: '09:00',
  travelers: { adults: 2, children: 0, infants: 0 },
  subtotal: 350,
  taxes: 35,
  grossAmount: 385,
  currency: 'USD',
  platformCommission: 57.75,
  supplierPayout: 327.25,
  paymentStatus: 'PENDING',
  paymentTiming: 'later',
  specialRequests: '',
  customer: { id: 'cust-1', name: 'Pascaline A', email: 'cust@test.com' },
  tour: {
    id: 'tour-1',
    title: 'Accra Flying Dress Experience',
    description: 'A wonderful tour',
    productContent: {},
    photos: [CLOUDINARY],
    coverPhoto: null,
    bookingAndTickets: {
      cancellationPolicy: { text: 'Free cancellation up to 48 hours before your experience.' },
    },
    supplier: { id: 'sup-1', name: 'Expedition Go Travel and Tours Ltd', email: 'supplier@test.com' },
  },
  ...overrides,
});

const htmlOf = (call = 0) => __send.mock.calls[call][0].html;

describe('supplier reserve-later email', () => {
  beforeEach(() => {
    delete process.env.PAY_LATER_CHARGE_BEFORE_HOURS;
  });

  it('addresses the supplier and names the charge date, not the activity date', async () => {
    await sendSupplierReserveLaterEmail(booking());
    const payload = __send.mock.calls[0][0];

    expect(payload.to).toBe('supplier@test.com');
    expect(payload.subject).not.toContain('\u2014');
    expect(payload.subject).toContain('payment pending');
    expect(payload.subject).toContain('TRG-001');

    expect(chargeLabel()).not.toBe(fmt.formatLongDate(travelDate));
    expect(payload.html).toContain(chargeLabel());
    expect(payload.html).toContain('not been charged yet');
    expect(payload.html).toContain(fmt.formatLongDate(travelDate)); // activity date still shown
  });

  it('renders every placeholder and carries no em dashes', async () => {
    await sendSupplierReserveLaterEmail(booking());
    const html = htmlOf();

    expect(html).not.toContain('{{');
    expect(html).not.toContain('\u2014');
    expect(html).toContain('Free cancellation up to 48 hours before your experience.');
    // "Reserved 9 Jun 2026" reference bar (compact format)
    expect(html).toContain(`Reserved ${fmt.formatCompactDate(new Date('2026-06-09T12:00:00Z'))}`);
  });

  it('inserts a Cloudinary crop into the hero image', async () => {
    await sendSupplierReserveLaterEmail(booking());
    expect(htmlOf()).toContain(
      "url('https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,g_auto,w_1200,h_520/v1787749419/user-photos/abc.png')"
    );
  });

  it('leaves a non-Cloudinary hero untouched', async () => {
    await sendSupplierReserveLaterEmail(booking({ tour: { ...booking().tour, photos: ['https://example.com/a.png'] } }));
    expect(htmlOf()).toContain("url('https://example.com/a.png')");
  });

  it('does not double-transform a Cloudinary URL that already has a transform', async () => {
    const url = 'https://res.cloudinary.com/dfpagrtoy/image/upload/w_100,c_fill,f_auto/v123/user-photos/a.png';
    await sendSupplierReserveLaterEmail(booking({ tour: { ...booking().tour, photos: [url] } }));
    expect(htmlOf()).toContain(`url('${url}')`);
    expect(htmlOf()).not.toContain('c_fill,g_auto,w_1200,h_520');
  });

  it('prefers coverPhoto over photos', async () => {
    await sendSupplierReserveLaterEmail(booking({
      tour: { ...booking().tour, coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/cover.png' },
    }));
    expect(htmlOf()).toContain('/upload/c_fill,g_auto,w_1200,h_520/v1/cover.png');
  });

  it('degrades to the gradient (no empty url) when the tour has no photo', async () => {
    await sendSupplierReserveLaterEmail(booking({
      tour: { ...booking().tour, photos: [], coverPhoto: null },
    }));
    const html = htmlOf();

    // The {{else}} branch must win: gradient only, never url('') which would
    // make mail clients drop the whole background-image declaration.
    expect(html).not.toContain("url('')");
    expect(html).toContain('background-image:linear-gradient(180deg, rgba(0,31,63,0.08)');
    expect(html).not.toContain('{{');
  });
});
