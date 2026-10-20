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

// Must run BEFORE the requires below: config/emailUrls.js reads CLIENT_URL once
// at module load, so assigning it later (e.g. in beforeAll) has no effect and
// the customer deep links silently fall back to the default origin. Without
// this the test only passed when the ambient environment already set
// CLIENT_URL (local .env); CI leaves it unset and the links resolved to
// http://localhost:5173.
process.env.CLIENT_URL = 'https://travioafrica.com';

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
  it('leads with a photo header that degrades to the scrim when the tour has no image', () => {
    const html = artifact();
    // The photo rides the HTML background attribute behind {{#if}}, so a
    // missing cover never emits background="". CSS url() is banned outright:
    // Gmail rewrites inline background-image (it strips the comma between
    // multiple values, turning gradient+url() into invalid CSS) and can
    // delete the whole style attribute — caniemail #343/#395.
    expect(html).toContain('{{#if tourImageUrl}} background="{{tourImageUrl}}"{{/if}}');
    expect(html).not.toContain(' background=""');
    expect(html).not.toContain("url('");
    // The scrim gradient comes from the stylesheet, with the inline rgba()
    // tint as the fallback for clients that drop <style> entirely.
    expect(html).toContain('class="media-header-scrim"');
    expect(html).toContain('background-color:rgba(0,31,63,0.45)');
    expect(html).toMatch(/\.media-header-scrim \{ background-image:linear-gradient\(/);
    // Outlook gets the VML fallback the media header ships with
    expect(html).toContain('v:rect');
  });

  it('shows the booking code in a reference bar rather than buried in a row', () => {
    const html = artifact();
    expect(html).toMatch(/Ref<\/span>/);
    expect(html).toContain('{{#if bookedAtLabel}}Booked {{bookedAtLabel}}{{/if}}');
  });

  it('ships the mobile shell gutter (8px wrapper, 16px inset) in the compiled artifact', () => {
    const html = artifact();
    expect(html).toContain('class="shell-pad"');
    expect(html).toContain('.shell-pad { padding-left:8px !important; padding-right:8px !important; }');
    expect(html).toContain('.pad { padding-left:16px !important; padding-right:16px !important; }');
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
// Booked-tour link, lead traveller and the Similar activities rail
// ---------------------------------------------------------------------------
describe('booking-confirmed — booked-tour link, lead traveller, recommendations', () => {
  it('links back to the booked experience via the canonical tour URL', () => {
    const html = artifact();
    expect(html).toContain('View the experience');
    expect(html).toContain('href="{{tourUrl}}"');
  });

  it('shows a lead-traveller contact card keyed off the lead initials, not the account', () => {
    const html = artifact();
    expect(html).toContain('Lead traveller');
    expect(html).toContain('{{leadTravelerName}}');
    expect(html).toContain('{{leadTravelerInitials}}');
  });

  it('renders a Similar activities rail, guarded so it collapses when empty', () => {
    const html = artifact();
    expect(html).toContain('Similar activities');
    expect(html).toContain('{{#if similarTours}}');
    expect(html).toContain('{{#each similarTours}}');
    expect(html).toContain('{{ratingLabel}}');
    expect(html).toContain('{{reviewCountLabel}}');
    expect(html).toContain('{{priceLabel}}');
  });

  it('keeps View the experience a secondary action, not a second accent CTA', () => {
    const html = artifact();
    const accent = (href) =>
      new RegExp(`<a href="\\{\\{${href}\\}\\}" class="btn" style="display:inline-block;background-color:#007A4D`).test(html);
    expect(accent('tourUrl')).toBe(false);
    expect(accent('voucherUrl')).toBe(true);
  });
});

describe('recommendations primitive', () => {
  it('renders nothing at all (heading included) when the list is empty or missing', () => {
    const built = B.recommendations('Similar activities');
    expect(render(built, { similarTours: [] })).toBe('');
    expect(render(built, {})).toBe('');
  });

  it('renders a linked card with a star rating and a from-price per tour', () => {
    const built = B.recommendations('Similar activities');
    const html = render(built, {
      similarTours: [
        {
          url: 'https://x/tour/1/harbour-kayak',
          imageUrl: 'https://img/1.png',
          title: 'Harbour Kayak',
          place: 'Accra, Ghana',
          hasRating: true,
          ratingLabel: '4.9',
          reviewCountLabel: '214 reviews',
          hasPrice: true,
          priceLabel: '$38.00',
        },
      ],
    });
    expect(html).toContain('Similar activities');
    expect(html).toContain('Harbour Kayak');
    expect(html).toContain('href="https://x/tour/1/harbour-kayak"');
    expect(html).toContain('https://img/1.png');
    expect(html).toContain('4.9');
    expect(html).toContain('214 reviews');
    expect(html).toContain('$38.00');
  });

  it('omits the rating row and price when a tour has neither', () => {
    const built = B.recommendations('Similar activities');
    const html = render(built, {
      similarTours: [{ url: 'u', title: 'Plain Tour', hasRating: false, hasPrice: false }],
    });
    expect(html).toContain('Plain Tour');
    expect(html).not.toContain('reviews');
    expect(html).not.toContain('From ');
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
    // hero image is Cloudinary-transformed (crop + jpg/q_auto) for delivery,
    // not the raw original — and it rides the HTML background attribute,
    // never CSS url(), which Gmail's sanitiser rewrites or strips
    expect(html).toContain(
      ' background="https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,g_auto,w_1200,h_520,f_jpg,q_auto/v1787749419/user-photos/abc.png"',
    );
    expect(html).not.toContain("url('");
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

  it('renders no photo attribute and no url() when the tour has no cover', async () => {
    const noPhoto = booking();
    noPhoto.tour.coverPhoto = '';
    noPhoto.tour.photos = [];
    await sendBookingConfirmedEmail(noPhoto);
    const { html } = __send.mock.calls[0][0];
    // The {{#if}} swallows the attribute entirely — no empty background=""
    // and no CSS url() for Gmail to choke on
    expect(html).not.toContain(' background=""');
    expect(html).not.toContain("url('");
  });

  it('threads same-city recommendations into the rendered email', async () => {
    const prisma = require('../../src/core/services/prismaClient');
    prisma.tour.findUnique.mockResolvedValueOnce({
      destinationCity: 'Accra',
      city: 'Accra',
      region: 'Greater Accra',
    });
    // The default brand for an origin-less booking is "africa", whose listing
    // model is travioAfricaTour. The mock has no such model by default, so add
    // it for this test only (fxOne so it never leaks into later tests).
    prisma.travioAfricaTour = {
      findMany: jest.fn().mockResolvedValueOnce([
        {
          tour: {
            id: 'tour-2',
            title: 'Jamestown Walking Tour',
            slug: 'jamestown-walking-tour',
            coverPhoto:
              'https://res.cloudinary.com/dfpagrtoy/image/upload/v1790968229/user-photos/sim2.jpg',
            photos: [],
            city: 'Accra',
            region: 'Greater Accra',
            country: 'Ghana',
            averageRating: 4.6,
            reviewCount: 10,
            combinedRating: 4.9,
            combinedReviewCount: 214,
            schedulesAndPricing: {
              pricingSchedules: { currency: 'USD' },
              travelerDetails: {
                pricingModel: 'perPerson',
                pricingApproach: 'sameForEveryone',
                uniformPrice: 38,
              },
            },
          },
        },
      ]),
    };

    await sendBookingConfirmedEmail(booking());
    const { html } = __send.mock.calls[0][0];

    expect(html).toContain('Similar activities');
    expect(html).toContain('Jamestown Walking Tour');
    expect(html).toContain('4.9');
    expect(html).toContain('214 reviews');
    expect(html).toContain('$38.00');
    expect(html).toContain('https://travioafrica.com/tour/tour-2/jamestown-walking-tour');
    // Card images render at 120x120; the 1200px+ original must never ship —
    // request the card's box (2x retina) in a universal encoding instead.
    expect(html).toContain(
      'https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,g_auto,w_240,h_240,f_jpg,q_auto/v1790968229/user-photos/sim2.jpg',
    );
    expect(html).not.toContain(
      'https://res.cloudinary.com/dfpagrtoy/image/upload/v1790968229/user-photos/sim2.jpg"',
    );
  });
});
