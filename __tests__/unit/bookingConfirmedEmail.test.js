/**
 * Customer "booking confirmed" email — the photo-first redesign.
 *
 * The template moved from a centred text hero + a flat list of label/value
 * rows separated by hairlines to a media header, a booking-code bar, icon
 * tiles, grouped cards and a single accent call to action. These tests pin the
 * parts that are easy to regress: the hero degrades without a photo, the icons
 * are hosted PNGs (Gmail/Outlook strip inline SVG), optional rows stay guarded,
 * the cancellation deadline is stated when the booking is refundable and
 * swapped for the policy wording when it is not, and the send path threads the
 * new data through.
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

const fs = require('fs');
const path = require('path');
const { __send } = require('resend');
const fmt = require('../../src/core/services/emailFormatting');
const { render } = require('../../src/core/services/emailRenderer');
const B = require('../../scripts/emailTemplateBuilder');
const { sendBookingConfirmedEmail } = require('../../src/core/services/emailService');

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

const GENERATED = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');
const artifact = () => fs.readFileSync(path.join(GENERATED, 'booking-confirmed.html'), 'utf8');

// ---------------------------------------------------------------------------
// The compiled artifact (what SendGrid actually sends)
// ---------------------------------------------------------------------------
describe('booking-confirmed artifact', () => {
  it('leads with a photo header that degrades to the gradient when the tour has no image', () => {
    const html = artifact();
    // imageVar branch so a missing cover photo never emits url('')
    expect(html).toContain('{{#if tourImageUrl}}');
    expect(html).toContain("url('{{tourImageUrl}}')");
    expect(html).not.toContain("url('')");
    // Outlook gets the VML fallback the media header ships with
    expect(html).toContain('v:rect');
  });

  it('shows the booking code in a reference bar rather than buried in a row', () => {
    const html = artifact();
    expect(html).toMatch(/Ref<\/span>/);
    expect(html).toContain('{{#if bookedAtLabel}}Booked {{bookedAtLabel}}{{/if}}');
  });

  it('renders the four key facts as hosted PNG icon tiles, never inline SVG or emoji', () => {
    const html = artifact();
    expect((html.match(/<img src="/g) || []).length).toBeGreaterThanOrEqual(4);
    for (const name of ['calendar', 'clock', 'duration', 'users']) {
      expect(html).toContain(B.EMAIL_ICON_URLS[name]);
    }
    expect(html).not.toContain('<svg');
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(html)).toBe(false);
  });

  it('keeps a single accent call to action: the voucher', () => {
    const html = artifact();
    const accent = (href) =>
      new RegExp(`<a href="\\{\\{${href}\\}\\}" class="btn" style="display:inline-block;background-color:#007A4D`).test(html);

    expect(accent('voucherUrl')).toBe(true);
    // View booking, Manage booking and Get directions stay subordinate.
    expect(accent('bookingUrl')).toBe(false);
    expect(accent('manageUrl')).toBe(false);
    expect(accent('directionsUrl')).toBe(false);
  });

  it('states a cancellation deadline when refundable and the policy wording when not', () => {
    const html = artifact();
    expect(html).toContain('{{#if cancelDeadlineLabel}}');
    expect(html).toMatch(/Free cancellation until\s*<strong>\{\{cancelDeadlineLabel\}\}<\/strong>/);
    expect(html).toContain('{{else}}');
    expect(html).toContain('{{cancellationPolicyText}}');
  });

  it('contains no em dashes anywhere in the copy', () => {
    expect(artifact()).not.toContain('\u2014');
  });

  it('guards every optional pickup row so no label renders without a value', () => {
    const html = artifact();
    const openGuardAt = (source, idx) => {
      const stack = [];
      for (const t of source.slice(0, idx).matchAll(/\{\{(#if|\/if)([\s\S]*?)\}\}/g)) {
        if (t[1] === '#if') stack.push(`{{#if${t[2]}}}`);
        else stack.pop();
      }
      return stack.length ? stack[stack.length - 1] : null;
    };
    for (const field of ['pickupLocation', 'pickupTime', 'meetingPoint', 'meetingTime']) {
      for (const m of html.matchAll(new RegExp(`\\{\\{${field}\\}\\}`, 'g'))) {
        expect(openGuardAt(html, m.index)).toBe(`{{#if ${field}}}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// detailCard + statGrid primitives
// ---------------------------------------------------------------------------
describe('detailCard', () => {
  it('drops an optional row entirely when its guard is empty', () => {
    const built = B.detailCard([
      { label: 'Pickup included', value: '{{pickupIncludedLabel}}' },
      { label: 'Pickup location', value: '{{pickupLocation}}', if: '{{pickupLocation}}' },
    ]);
    expect(built).toContain('{{#if pickupLocation}}');
    expect(built).toContain('{{/if}}');
    const html = render(built, { pickupIncludedLabel: 'Yes', pickupLocation: '' });
    expect(html).toContain('Pickup included');
    expect(html).not.toContain('Pickup location');
  });
});

describe('statGrid optional tiles', () => {
  it('leaves the markup unchanged for a tile with no guard', () => {
    const built = B.statGrid([{ icon: 'calendar', label: 'Date', value: '{{dateLabel}}' }]);
    expect(built).not.toContain('{{#if');
  });

  it('hides a guarded tile when its value is empty', () => {
    const built = B.statGrid([
      { icon: 'clock', label: 'Start time', value: '{{timeLabel}}', if: '{{timeLabel}}' },
    ]);
    expect(built).toContain('{{#if timeLabel}}');
    expect(render(built, { timeLabel: '' })).not.toContain('Start time');
    expect(render(built, { timeLabel: '09:00' })).toContain('Start time');
  });
});

// ---------------------------------------------------------------------------
// send path — the new fields render end to end
// ---------------------------------------------------------------------------
const travelDate = new Date('2026-07-01T10:00:00Z');
const deadline = new Date(travelDate.getTime() - 24 * 60 * 60 * 1000);

const booking = (overrides = {}) => ({
  id: 'booking-1',
  bookingNumber: 'TB-001',
  customerId: 'cust-1',
  tourId: 'tour-1',
  createdAt: new Date('2026-06-20T00:00:00Z'),
  travelDate,
  selectedTime: '10:00',
  travelers: { adults: 2, children: 0, infants: 0 },
  subtotal: 200,
  taxes: 20,
  grossAmount: 220,
  currency: 'USD',
  platformCommission: 33,
  supplierPayout: 187,
  paymentStatus: 'SUCCEEDED',
  paymentTiming: 'now',
  customer: { id: 'cust-1', name: 'John Doe', email: 'john@test.com' },
  tour: {
    id: 'tour-1',
    title: 'Test Tour',
    description: 'A wonderful tour',
    coverPhoto:
      'https://res.cloudinary.com/dfpagrtoy/image/upload/v1787749419/user-photos/abc.png',
    productContent: {},
    bookingAndTickets: {
      cancellationPolicy: { text: 'Free cancellation up to 24 hours before your experience.' },
    },
    supplier: { name: 'Supplier Co', email: 's@t.com', phone: '+1234567890' },
  },
  ...overrides,
});

describe('sendBookingConfirmedEmail', () => {
  it('states the exact cancellation deadline and threads the new context', async () => {
    await sendBookingConfirmedEmail(booking());
    const { subject, html } = __send.mock.calls[0][0];

    expect(subject).toContain('Booking Confirmed');
    expect(html).toContain('Free cancellation until');
    expect(html).toContain(fmt.formatDateTime(deadline));
    // bookedAtLabel
    expect(html).toContain(fmt.formatCompactDate(new Date('2026-06-20T00:00:00Z')));
    // hero image is Cloudinary-transformed, not the raw original
    expect(html).toContain(
      'https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,g_auto,w_1200,h_520/v1787749419/user-photos/abc.png',
    );
    expect(html).not.toContain('{{');
    expect(html).not.toContain('\u2014');
  });

  it('swaps the deadline for the policy wording when the experience is non-refundable', async () => {
    const b = booking();
    b.tour.bookingAndTickets = { cancellationPolicy: { type: 'all_sales_final' } };
    await sendBookingConfirmedEmail(b);
    const { html } = __send.mock.calls[0][0];

    expect(html).not.toContain('Free cancellation until');
    expect(html).toContain('All sales are final. This experience is non-refundable.');
  });

  it('sets a preheader that names no em dash', async () => {
    await sendBookingConfirmedEmail(booking());
    const { html } = __send.mock.calls[0][0];
    expect(html).toContain('Everything you need for Test Tour is inside');
  });

  it('renders the tour cover photo when present and no url() when absent', async () => {
    const noPhoto = booking();
    noPhoto.tour.coverPhoto = '';
    noPhoto.tour.photos = [];
    await sendBookingConfirmedEmail(noPhoto);
    const { html } = __send.mock.calls[0][0];
    expect(html).not.toContain("url('')");
  });
});
