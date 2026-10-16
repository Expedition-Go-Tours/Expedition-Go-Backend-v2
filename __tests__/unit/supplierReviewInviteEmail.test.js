/**
 * Supplier "activity completed → send the guest the review link" email.
 *
 * When a paid booking transitions to COMPLETED the supplier is handed the
 * customer's own review link to forward (WhatsApp / SMS / email). These tests
 * pin: the link is the hero (a copy-friendly block, not a fake CTA button), it
 * is personalised with the real booking, missing fields never leave dangling
 * labels, and the send path resolves the addressee + review URL correctly.
 *
 * Assertions run against the compiled artifact the send path delivers, plus the
 * live sender for the data plumbing.
 */
jest.mock('resend', () => {
  const send = jest.fn();
  return { Resend: jest.fn(() => ({ emails: { send } })), __send: send };
});
jest.mock('../../src/core/services/prismaClient', () => ({}));
jest.mock('../../src/core/services/notificationRecipientService', () => ({
  resolveRecipients: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { __send } = require('resend');
const { resolveRecipients } = require('../../src/core/services/notificationRecipientService');
const { render } = require('../../src/core/services/emailRenderer');
const { TEMPLATE_DEFS } = require('../../scripts/buildEmailTemplates');
const { sendSupplierReviewInviteEmail } = require('../../src/core/services/emailService');

const GENERATED = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');
const artifact = () => fs.readFileSync(path.join(GENERATED, 'supplier-review-invite.html'), 'utf8');
const def = TEMPLATE_DEFS.find((d) => d.key === 'supplier-review-invite');

beforeAll(() => {
  process.env.RESEND_API_KEY = 're_testkey';
  process.env.EMAIL_FROM = 'Travio Ghana <noreply@travioghana.com>';
});

beforeEach(() => {
  jest.clearAllMocks();
  __send.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  resolveRecipients.mockResolvedValue([{ email: 'supplier@example.com', recipientId: null }]);
});

// ---------------------------------------------------------------------------
// The compiled artifact
// ---------------------------------------------------------------------------
describe('supplier-review-invite artifact', () => {
  it('makes the review link the hero: a copy block, not a review-submit button', () => {
    const html = artifact();
    expect(html).toContain('{{reviewUrl}}');
    // Copy affordance beside a fully-visible, wrapping URL.
    expect(html).toContain('>Copy</span>');
    expect(html).toContain('word-break:break-all');
    expect(html).toContain('dm-accent-soft');
    // The supplier cannot submit the guest's review, so there must be no
    // primary "leave a review" CTA.
    expect(html).not.toContain('Open review page');
    expect(html).not.toContain('Leave a review');
  });

  it('personalises with the guest name, not the account placeholder', () => {
    const html = artifact();
    expect(html).toContain('{{guestName}}');
    // The copy addresses the supplier by name and never the literal account var.
    expect(html).toContain('Hi {{supplierName}}');
  });

  it('points the secondary action at the supplier booking, not the review page', () => {
    const html = artifact();
    expect(html).toContain('View booking');
    expect(html).toContain('href="{{supplierBookingUrl}}"');
  });

  it('uses the real tour photo header with a graceful image fallback', () => {
    const html = artifact();
    expect(html).toContain('{{#if tourImageUrl}}');
    expect(html).not.toContain("url('')");
  });

  it('never carries the customer-facing Similar activities rail', () => {
    const html = artifact();
    expect(html).not.toContain('Similar activities');
    expect(html).not.toContain('{{#each similarTours}}');
  });

  it('contains no em dashes and no emoji codepoints', () => {
    const html = artifact();
    expect(html).not.toContain('\u2014');
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(html)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing-data guards (no dangling labels or awkward punctuation)
// ---------------------------------------------------------------------------
describe('supplier-review-invite missing-data guards', () => {
  const full = {
    brandName: 'Travio Ghana',
    supplierName: 'Expedition Go',
    guestName: 'Ada',
    tourTitle: 'Accra Flying Dress Experience',
    dateLabel: 'Wed, 4 Nov 2026',
    bookingNumber: 'TRG-1',
    reviewUrl: 'https://travioghana.com/review/accra?bookingId=b1',
    supplierBookingUrl: 'https://supplier.travioghana.com/bookings?bookingId=b1',
  };

  it('states the date inline when present and drops the preposition when absent', () => {
    const withDate = render(def.build(), full);
    expect(withDate).toContain('with Ada on Wed, 4 Nov 2026 has been marked as completed');

    const noDate = render(def.build(), { ...full, dateLabel: '' });
    expect(noDate).toContain('with Ada has been marked as completed');
    expect(noDate).not.toContain('on  has been');
  });

  it('renders the reference bar only when a booking number exists', () => {
    expect(render(def.build(), full)).toMatch(/Ref<\/span>/);
    expect(render(def.build(), { ...full, bookingNumber: '' })).not.toMatch(/Ref<\/span>/);
  });

  it('never leaves unresolved Handlebars once data is supplied', () => {
    expect(render(def.build(), full)).not.toContain('{{');
  });
});

// ---------------------------------------------------------------------------
// Send path
// ---------------------------------------------------------------------------
const booking = (overrides = {}) => ({
  id: 'booking-1',
  bookingNumber: 'TB-001',
  customerId: 'cust-1',
  tourId: 'tour-1',
  createdAt: new Date('2026-06-20T00:00:00Z'),
  travelDate: new Date('2026-07-01T10:00:00Z'),
  selectedTime: '10:00',
  travelers: { adults: 2, children: 0, infants: 0 },
  subtotal: 200,
  taxes: 20,
  grossAmount: 220,
  platformCommission: 33,
  supplierPayout: 187,
  currency: 'USD',
  paymentStatus: 'SUCCEEDED',
  customer: { id: 'cust-1', name: 'John Doe', email: 'john@test.com' },
  tour: {
    id: 'tour-1',
    title: 'Test Tour',
    slug: 'test-tour',
    coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1787749419/user-photos/abc.png',
    productContent: {},
    supplier: { id: 'sup-1', name: 'Supplier Co', email: 's@t.com' },
  },
  ...overrides,
});

describe('sendSupplierReviewInviteEmail', () => {
  it('addresses the lead traveller and sends to the supplier reviews recipients', async () => {
    await sendSupplierReviewInviteEmail(booking({ leadTravelerName: 'Ada Lovelace' }));

    expect(resolveRecipients).toHaveBeenCalledWith('sup-1', 'reviews');
    const { to, subject, html } = __send.mock.calls[0][0];
    // A single recipient may be normalized to a bare string by the send layer.
    expect(Array.isArray(to) ? to : [to]).toEqual(['supplier@example.com']);
    expect(subject).toBe('Activity completed - send Ada Lovelace the review link (Ref: TB-001)');
    expect(html).toContain('Invite Ada Lovelace to review their experience');
    expect(html).toContain('review/test-tour?bookingId=booking-1');
    expect(html).not.toContain('{{');
    expect(html).not.toContain('\u2014');
  });

  it('falls back to the account holder when no lead traveller is recorded', async () => {
    await sendSupplierReviewInviteEmail(booking());
    expect(__send.mock.calls[0][0].subject).toBe(
      'Activity completed - send John Doe the review link (Ref: TB-001)',
    );
  });

  it('degrades to "your guest" when neither a lead nor an account name exists', async () => {
    const b = booking();
    b.customer = { id: 'cust-1', name: '', email: 'john@test.com' };
    await sendSupplierReviewInviteEmail(b);
    expect(__send.mock.calls[0][0].subject).toBe(
      'Activity completed - send your guest the review link (Ref: TB-001)',
    );
  });

  it('omits the reference suffix when there is no booking number', async () => {
    const b = booking({ leadTravelerName: 'Ada' });
    b.bookingNumber = null;
    await sendSupplierReviewInviteEmail(b);
    expect(__send.mock.calls[0][0].subject).toBe('Activity completed - send Ada the review link');
  });

  it('sets a preheader that names the guest', async () => {
    await sendSupplierReviewInviteEmail(booking({ leadTravelerName: 'Ada' }));
    expect(__send.mock.calls[0][0].html).toContain('Share the review link with Ada');
  });
});
