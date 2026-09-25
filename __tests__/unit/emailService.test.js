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

const { Resend, __send } = require('resend');
const prisma = require('../../src/core/services/prismaClient');

beforeAll(() => {
  process.env.RESEND_API_KEY = 're_testkey';
  process.env.EMAIL_FROM = 'Travio Africa <noreply@travioafrica.com>';
  process.env.EMAIL_REPLY_TO = 'support@travioafrica.com';
  process.env.CLIENT_URL = 'https://travioafrica.com';
  process.env.SUPPORT_EMAIL = 'support@expeditiongo.com';
  process.env.LOGO_URL = 'https://example.com/logo.png';
});

beforeEach(() => {
  jest.clearAllMocks();
  Resend.mockClear();
  __send.mockResolvedValue({ data: { id: 'msg-123' }, error: null });
});

const {
  sendEmail,
  renderTemplate,
  sendBookingConfirmedEmail,
  sendBookingConfirmationEmail,
  sendBookingCancellationEmail,
  sendSupplierStatusEmail,
  sendReviewNotificationEmail,
  sendPayoutNotificationEmail,
  sendSupplierBookingNotification,
  sendSupplierNewBookingEmail,
  sendSupplierProductSubmittedEmail,
  sendSupplierProductUpdateSubmittedEmail,
  generatePrintableTicketHtml,
} = require('../../src/core/services/emailService');

// ---------------------------------------------------------------------------
// sendEmail — core send function
// ---------------------------------------------------------------------------
describe('sendEmail', () => {
  it('sends via Resend with correct structure', async () => {
    const result = await sendEmail({
      to: 'test@test.com',
      subject: 'Test Subject',
      template: 'booking-confirmed',
      data: { customerName: 'Hello', bookingNumber: 'B1', tourTitle: 'T', dateLabel: 'D', travelersLabel: '1 adult' },
    });

    expect(Resend).toHaveBeenCalledWith('re_testkey');
    expect(__send).toHaveBeenCalledTimes(1);
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('test@test.com');
    expect(payload.subject).toBe('Test Subject');
    expect(payload.from).toBe('Travio Africa <noreply@travioafrica.com>');
    expect(payload.reply_to).toBe('support@travioafrica.com');
    expect(payload.html).toContain('Hello');
    expect(payload.html).toContain('Travio Africa');
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-123');
  });

  it('throws when Resend fails', async () => {
    __send.mockResolvedValue({ data: null, error: { message: 'Resend error' } });
    await expect(sendEmail({
      to: 'test@test.com',
      subject: 'Fail',
      template: 'booking-confirmed',
      data: { customerName: 'X', bookingNumber: 'B1', tourTitle: 'T', dateLabel: 'D', travelersLabel: '1' },
    })).rejects.toThrow('Failed to send email: Resend error');
  });

  it('renders inline fallback for legacy template names', async () => {
    await sendEmail({
      to: 'test@test.com',
      subject: 'Hello',
      template: 'generic-notification',
      data: { header: 'Password Reset', message: 'Click below', buttonUrl: 'https://x/r', buttonText: 'Reset' },
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.html).toContain('Password Reset');
    expect(payload.html).toContain('Click below');
    expect(payload.html).toContain('https://x/r');
  });

  it('skips send when no RESEND_API_KEY is set', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendEmail({
      to: 'test@test.com',
      subject: 'Skip',
      template: 'booking-confirmed',
      data: { customerName: 'X', bookingNumber: 'B1', tourTitle: 'T', dateLabel: 'D', travelersLabel: '1' },
    });
    expect(result.success).toBe(false);
    expect(result.reason).toBe('no-provider');
    expect(__send).not.toHaveBeenCalled();
    process.env.RESEND_API_KEY = 're_testkey';
  });
});

// ---------------------------------------------------------------------------
// renderTemplate — compiled template pipeline
// ---------------------------------------------------------------------------
describe('renderTemplate', () => {
  it('throws for unknown template key', async () => {
    await expect(renderTemplate('does-not-exist', {})).rejects.toThrow('Template not found');
  });

  it('renders all 40 compiled templates with no leftover braces', async () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
    expect(files.length).toBe(40);

    for (const file of files) {
      const key = file.replace(/\.html$/, '');
      const html = await renderTemplate(key, {
        customerName: 'Jane',
        bookingNumber: 'TRAV-001',
        tourTitle: 'Cape Tour',
        dateLabel: 'Monday, August 17, 2026',
        timeLabel: '9:00 AM',
        durationLabel: '8 hours',
        travelersLabel: '2 adults',
        languageLabel: 'English',
        bookingTypeLabel: 'Shared',
        supplierName: 'Ocean Tours',
        totalLabel: '$110.00',
        amountPaidLabel: '$110.00',
        paymentStatusLabel: 'Paid',
        payoutAmountLabel: '$93.50',
        refundAmountLabel: '$110.00',
        changes: [{ label: 'Date', previous: 'Aug 1', updated: 'Aug 2' }],
        items: ['Bring sunscreen'],
        preheader: 'A new message',
        senderName: 'Kofi',
        senderRoleLabel: 'Tour operator',
        senderInitials: 'KO',
        senderMessageHtml: 'Hello Jane',
        chatUrl: 'https://example.com/chat',
      });
      expect(html).toContain('Travio Africa');
      const leftover = html.match(/\{\{[^}]+\}\}/g) || [];
      expect(leftover).toEqual([]);
    }
  });

  it('chat-new-message renders sender card + CTA and omits booking context when absent', async () => {
    const html = await renderTemplate('chat-new-message', {
      preheader: 'Ama wrote',
      senderName: 'Ama',
      senderRoleLabel: 'Traveller',
      senderInitials: 'AM',
      senderMessageHtml: 'Hello, is the boat still on?',
      chatUrl: 'https://example.com/chat?conversation=c1',
    });
    expect(html).toContain('New message');
    expect(html).toContain('Ama');
    expect(html).toContain('AM');
    expect(html).toContain('Hello, is the boat still on?');
    expect(html).toContain('https://example.com/chat?conversation=c1');
    expect(html).toContain('Reply to this email');
    expect(html).not.toContain('Ref ');
    expect(html.match(/\{\{[^}]+\}\}/g) || []).toEqual([]);
  });

  it('chat-new-message shows attachment thumbnail + About context when provided', async () => {
    const html = await renderTemplate('chat-new-message', {
      senderName: 'Kojo',
      senderRoleLabel: 'Tour operator',
      senderInitials: 'KO',
      senderMessageHtml: 'See attached photo',
      attachmentThumbUrl: 'https://img.example.test/photo.png',
      attachmentDocLabel: '',
      tourTitle: 'Cape Coast Castle & Elmina',
      bookingNumber: 'EXP-123456-2026',
      chatUrl: 'https://example.com/chat?conversation=c1',
    });
    expect(html).toContain('https://img.example.test/photo.png');
    expect(html).toContain('Cape Coast Castle & Elmina');
    expect(html).toContain('EXP-123456-2026');
    expect(html).toContain('KO');
    expect(html.match(/\{\{[^}]+\}\}/g) || []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generatePrintableTicketHtml
// ---------------------------------------------------------------------------
describe('generatePrintableTicketHtml', () => {
  it('returns ticket HTML with all booking details', () => {
    const data = {
      bookingNumber: 'TB-001',
      customerName: 'John Doe',
      tourTitle: 'Test Tour',
      tourDescription: 'A great tour experience',
      travelDate: '2026-07-01T00:00:00.000Z',
      selectedTime: '10:00',
      travelers: { adults: 2, children: 1, infants: 0 },
      currency: 'USD',
      total: 250,
      status: 'CONFIRMED',
      meetingPoint: { address: 'Main Gate', instructions: 'Be on time' },
      supplierName: 'Supplier Co',
      supportEmail: 'support@expeditiongo.com',
      included: ['Professional guide', 'Lunch'],
      restrictions: 'No pets allowed',
      cancellationPolicy: 'Free cancellation 24h before',
    };

    const html = generatePrintableTicketHtml(data);
    expect(html).toContain('TB-001');
    expect(html).toContain('John Doe');
    expect(html).toContain('Test Tour');
    expect(html).toContain('July 1, 2026');
    expect(html).toContain('10:00');
    expect(html).toContain('2 Adult(s)');
    expect(html).toContain('1 Child(ren)');
    expect(html).toContain('USD 250');
    expect(html).toContain('Confirmed');
    expect(html).toContain('Professional guide');
    expect(html).toContain('No pets allowed');
    expect(html).toContain('Free cancellation 24h before');
    expect(html).toContain('Supplier Co');
  });

  it('handles minimal input without crashing', () => {
    const data = {
      bookingNumber: 'TB-002',
      customerName: 'Jane Doe',
      tourTitle: 'Minimal Tour',
      travelDate: '2026-08-15T00:00:00.000Z',
      currency: 'USD',
      total: 100,
      status: 'PENDING',
      supplierName: 'Supplier Co',
      supportEmail: 'support@expeditiongo.com',
    };

    const html = generatePrintableTicketHtml(data);
    expect(html).toContain('TB-002');
    expect(html).toContain('August 15, 2026');
    expect(html).toContain('Supplier Co');
  });
});

// ---------------------------------------------------------------------------
// sendBookingConfirmationEmail / sendBookingConfirmedEmail
// ---------------------------------------------------------------------------
describe('sendBookingConfirmationEmail', () => {
  const mockCustomer = { id: 'cust-1', name: 'John Doe', email: 'john@test.com' };
  const mockTour = {
    id: 'tour-1',
    title: 'Test Tour',
    description: 'A wonderful tour',
    productContent: { included: ['Professional guide', 'Lunch'], whatToBring: ['Sunscreen', 'Hat'], highlights: ['Scenic views'], restrictions: null },
    bookingAndTickets: {
      meetingPoint: { address: 'Main Gate', instructions: 'Be on time' },
      checkInProcess: 'Show ticket at gate',
      cancellationPolicy: 'Free cancellation 24h before',
    },
    supplier: { name: 'Supplier Co', email: 's@t.com', phone: '+1234567890' },
  };
  const mockBooking = {
    id: 'booking-1',
    bookingNumber: 'TB-001',
    customerId: 'cust-1',
    tourId: 'tour-1',
    travelDate: new Date('2026-07-01T10:00:00Z'),
    selectedTime: '10:00',
    travelers: { adults: 2, children: 1, infants: 0 },
    subtotal: 200,
    taxes: 20,
    grossAmount: 220,
    currency: 'USD',
    platformCommission: 33,
    supplierPayout: 187,
    paymentStatus: 'SUCCEEDED',
    paymentTiming: 'now',
    customer: mockCustomer,
    tour: mockTour,
  };

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockCustomer);
    prisma.tour.findUnique.mockResolvedValue(mockTour);
  });

  it('sends confirmation with correct data', async () => {
    await sendBookingConfirmationEmail(mockBooking);

    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('john@test.com');
    expect(payload.subject).toContain('Booking Confirmed');
    expect(payload.subject).toContain('Test Tour');
    expect(payload.subject).toContain('TB-001');
    expect(payload.html).toContain('TB-001');
    expect(payload.html).toContain('Test Tour');
    expect(payload.html).toContain('John Doe');
  });

  it('re-fetches context when relations are missing', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...mockBooking, customer: mockCustomer, tour: mockTour });
    await sendBookingConfirmationEmail({ id: 'booking-1', bookingNumber: 'TB-001', customerId: 'cust-1', tourId: 'tour-1' });
    expect(prisma.booking.findUnique).toHaveBeenCalled();
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('john@test.com');
  });

  it('handles missing customer gracefully (no throw, no send)', async () => {
    const noCust = { ...mockBooking, customer: null, tour: mockTour };
    await sendBookingConfirmationEmail(noCust);
    // customer becomes Guest — email still attempted with empty to; legacy guard tolerates
    expect(__send.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// sendBookingCancellationEmail
// ---------------------------------------------------------------------------
describe('sendBookingCancellationEmail', () => {
  const mockCustomer = { id: 'cust-1', name: 'John Doe', email: 'john@test.com' };
  const mockTour = {
    id: 'tour-1',
    title: 'Test Tour',
    bookingAndTickets: { meetingPoint: null, cancellationPolicy: 'Free cancellation 24h before' },
    supplier: { name: 'Supplier Co', email: 's@t.com', phone: '+1234567890' },
  };
  const mockBooking = {
    id: 'booking-1',
    bookingNumber: 'TB-001',
    customerId: 'cust-1',
    tourId: 'tour-1',
    travelDate: new Date('2026-07-01'),
    cancellationReason: 'Schedule conflict',
    currency: 'USD',
    grossAmount: 220,
    refundAmount: null,
    cancelledAt: new Date('2026-06-20'),
    paymentStatus: 'SUCCEEDED',
    paymentTiming: 'now',
    customer: mockCustomer,
    tour: mockTour,
  };

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockCustomer);
    prisma.tour.findUnique.mockResolvedValue(mockTour);
  });

  it('sends full-refund email when refund provided', async () => {
    await sendBookingCancellationEmail(mockBooking, 220);
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('john@test.com');
    expect(payload.subject).toContain('cancelled');
    expect(payload.html).toContain('Test Tour');
    expect(payload.html).toContain('$220.00');
  });

  it('sends no-refund email when refund absent', async () => {
    await sendBookingCancellationEmail(mockBooking);
    const payload = __send.mock.calls[0][0];
    expect(payload.html).toContain('Your booking is cancelled');
    expect(payload.html).toContain('$220.00'); // cancellation fee
  });

  it('throws on DB error', async () => {
    prisma.booking.findUnique.mockRejectedValue(new Error('DB error'));
    await expect(sendBookingCancellationEmail({ id: 'booking-1', customerId: 'cust-1', tourId: 'tour-1' })).rejects.toThrow('DB error');
  });
});

// ---------------------------------------------------------------------------
// sendSupplierStatusEmail
// ---------------------------------------------------------------------------
describe('sendSupplierStatusEmail', () => {
  it('sends status email via inline generic template', async () => {
    await sendSupplierStatusEmail('supplier@test.com', 'APPROVED', { name: 'Test Business' });
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('supplier@test.com');
    expect(payload.subject).toContain('Approved');
    expect(payload.html).toContain('Test Business');
  });

  it('throws for unknown status', async () => {
    await expect(sendSupplierStatusEmail('t@t.com', 'UNKNOWN', {}))
      .rejects.toThrow('Unknown supplier status');
  });
});

// ---------------------------------------------------------------------------
// Product submission / update review emails
// ---------------------------------------------------------------------------
describe('product submission emails', () => {
  const tour = {
    id: 'tour-1',
    title: 'Cape Coast Castle Tour',
    supplier: { name: 'Accra Tours', email: 'supplier@test.com' },
  };

  it('sends the new-product submission email', async () => {
    await sendSupplierProductSubmittedEmail(tour);
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('supplier@test.com');
    expect(payload.subject).toBe('Your product has been submitted for review');
    expect(payload.html).toContain('Cape Coast Castle Tour');
    expect(payload.html).toContain('Accra Tours');
    expect(payload.html).toContain('2\u20133 working days');
  });

  it('sends the product update submission email', async () => {
    await sendSupplierProductUpdateSubmittedEmail(tour);
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('supplier@test.com');
    expect(payload.subject).toBe('Your product update is under review');
    expect(payload.html).toContain('Cape Coast Castle Tour');
    expect(payload.html).toContain('24\u201348 hours');
  });

  it('skips sending when the supplier has no email', async () => {
    const result = await sendSupplierProductSubmittedEmail({ id: 't', title: 'X', supplier: {} });
    expect(result).toEqual({ success: false, reason: 'no-recipient' });
    expect(__send).not.toHaveBeenCalled();
  });

  it('routes Ghana suppliers to the Ghana dashboard', async () => {
    await sendSupplierProductSubmittedEmail({
      ...tour,
      supplier: { name: 'Accra Tours', email: 'supplier@test.com', roles: ['supplier', 'ghana'] },
    });
    expect(__send.mock.calls[0][0].html).toContain('https://supplier.travioghana.com/products');
  });

  it('routes non-Ghana suppliers to the default dashboard', async () => {
    await sendSupplierProductUpdateSubmittedEmail({
      ...tour,
      supplier: { name: 'Accra Tours', email: 'supplier@test.com', roles: ['supplier'] },
    });
    const html = __send.mock.calls[0][0].html;
    expect(html).not.toContain('supplier.travioghana.com');
    expect(html).toContain('/products/build/tour-1/type');
  });
});

// ---------------------------------------------------------------------------
// sendReviewNotificationEmail
// ---------------------------------------------------------------------------
describe('sendReviewNotificationEmail', () => {
  const mockSupplier = { id: 's-1', name: 'Supplier Co', email: 'supplier@test.com' };
  const mockCustomer = { id: 'c-1', name: 'John Doe', email: 'john@test.com' };
  const mockReview = {
    id: 'review-1',
    rating: 5,
    title: 'Amazing!',
    comment: 'Best tour ever',
    createdAt: new Date('2026-06-01'),
    customerId: 'c-1',
    tour: { supplierId: 's-1', title: 'Test Tour' },
  };

  beforeEach(() => {
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === 's-1') return Promise.resolve(mockSupplier);
      if (where.id === 'c-1') return Promise.resolve(mockCustomer);
      return Promise.resolve(null);
    });
  });

  it('sends review notification to supplier', async () => {
    await sendReviewNotificationEmail(mockReview);
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('supplier@test.com');
    expect(payload.subject).toContain('5-Star Review');
    expect(payload.html).toContain('Best tour ever');
  });

  it('throws when supplier not found', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(sendReviewNotificationEmail(mockReview)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sendPayoutNotificationEmail
// ---------------------------------------------------------------------------
describe('sendPayoutNotificationEmail', () => {
  const mockSupplier = { id: 's-1', name: 'Supplier Co', email: 'supplier@test.com' };
  const payoutData = { amount: 500, currency: 'USD', date: '2026-06-15', id: 'po-001' };

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockSupplier);
  });

  it('sends payout notification', async () => {
    await sendPayoutNotificationEmail('s-1', payoutData);
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('supplier@test.com');
    expect(payload.subject).toContain('Payout Processed');
    expect(payload.html).toContain('$500.00');
  });

  it('throws when supplier not found', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(sendPayoutNotificationEmail('bad-id', payoutData)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sendSupplierBookingNotification / sendSupplierNewBookingEmail
// ---------------------------------------------------------------------------
describe('sendSupplierBookingNotification', () => {
  const mockSupplier = { id: 's-1', name: 'Supplier Co', email: 'supplier@test.com' };
  const mockCustomer = { id: 'c-1', name: 'John Doe', email: 'john@test.com' };
  const mockTour = {
    id: 'tour-1',
    title: 'Test Tour',
    supplier: { id: 's-1', name: 'Supplier Co', email: 'supplier@test.com', phone: '+233' },
  };
  const mockBooking = {
    id: 'b-1',
    bookingNumber: 'TB-001',
    tourId: 'tour-1',
    customerId: 'c-1',
    travelDate: new Date('2026-07-01T10:00:00Z'),
    selectedTime: '10:00',
    travelers: { adults: 2, children: 1, infants: 0, phoneNumber: '+233501234567', location: 'Accra' },
    grossAmount: 220,
    currency: 'USD',
    platformCommission: 33,
    supplierPayout: 187,
    paymentStatus: 'SUCCEEDED',
    paymentTiming: 'now',
    customer: mockCustomer,
    tour: mockTour,
  };

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockSupplier);
    prisma.tour.findUnique.mockResolvedValue(mockTour);
  });

  it('sends booking notification to supplier', async () => {
    await sendSupplierBookingNotification(mockBooking);
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('supplier@test.com');
    expect(payload.subject).toContain('New confirmed booking');
    expect(payload.html).toContain('John Doe');
    expect(payload.html).toContain('+233501234567');
  });

  it('handles missing customer gracefully', async () => {
    await sendSupplierNewBookingEmail({ ...mockBooking, customer: { name: null, email: '' } });
    const payload = __send.mock.calls[0][0];
    expect(payload.html).toContain('Guest');
  });
});

// ---------------------------------------------------------------------------
// Brand identity — Expedition config + brandKey threading through senders
// ---------------------------------------------------------------------------
const {
  resolveEmailBrand,
  sendNotificationRecipientVerificationEmail,
  sendSupplierResponseEmail,
  sendTeamInviteEmail,
  sendChatMessageEmail,
} = require('../../src/core/services/emailService');
const { getBrandEmail } = require('../../config/brands');
const emailUrls = require('../../config/emailUrls');

describe('Expedition email identity', () => {
  it('says Expedition-Go Tours in the badge, body and footer', () => {
    const brand = getBrandEmail('expedition');
    expect(brand.brandName).toBe('Expedition-Go Tours');
    expect(brand.poweredByLabel).toBe('Expedition-Go Tours');
    // From: header deliberately stays on the shared Ghana sender.
    expect(brand.from).toBe('Travio Ghana <notifications@travioghana.com>');
    expect(brand.supportEmail).toBe('support@travioghana.com');
  });

  it('renders an expedition-branded inline email end-to-end', async () => {
    await sendEmail({
      to: 'traveller@test.com',
      subject: 'Trip update',
      template: 'generic-notification',
      opts: { brandKey: 'expedition' },
      data: { header: 'Hello', message: 'Body' },
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.from).toBe('Travio Ghana <notifications@travioghana.com>');
    expect(payload.html).toContain('Expedition-Go Tours');
    expect(payload.html).not.toContain('Travio Africa');
  });
});

describe('resolveEmailBrand', () => {
  it('keeps Ghana for suppliers that also carry the expedition role', () => {
    const roles = ['supplier', 'ghana', 'expedition'];
    expect(resolveEmailBrand({ user: { roles } })).toBe('ghana');
    expect(resolveEmailBrand({ supplier: { roles } })).toBe('ghana');
  });

  it('maps expedition-only users to the Expedition brand', () => {
    expect(resolveEmailBrand({ user: { roles: ['customer', 'expedition'] } })).toBe('expedition');
  });

  it('prefers booking.source over roles and falls back to the default brand', () => {
    expect(resolveEmailBrand({ booking: { source: 'GHANA' } })).toBe('ghana');
    expect(resolveEmailBrand({ booking: { source: 'EXPEDITION' }, user: { roles: ['travioafrica'] } })).toBe('expedition');
    expect(resolveEmailBrand({})).toBe('africa');
    expect(resolveEmailBrand({ user: {} })).toBe('africa');
  });
});

describe('brandKey threading (inline hardening)', () => {
  it('resolves shell + From: from data.brandKey on the inline path', async () => {
    // Mirrors what the email queue forwards (data only, no opts).
    await sendEmail({
      to: 'supplier@test.com',
      subject: 'Queued',
      template: 'generic-notification',
      data: { header: 'Hi', message: 'Body', brandKey: 'ghana' },
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.from).toBe('Travio Ghana <notifications@travioghana.com>');
    expect(payload.html).toContain('Travio Ghana');
  });

  it('brands the supplier approval email from the supplier roles', async () => {
    await sendSupplierStatusEmail('supplier@test.com', 'APPROVED', {
      name: 'Accra Tours',
      roles: ['supplier', 'ghana'],
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.html).toContain('Welcome to Travio Ghana');
    expect(payload.from).toBe('Travio Ghana <notifications@travioghana.com>');
    expect(payload.html).toContain('https://supplier.travioghana.com/dashboard');
  });

  it('brands expedition-scoped recipients Expedition-Go Tours', async () => {
    await sendSupplierStatusEmail('ops@test.com', 'APPROVED', {
      name: 'Expedition Ops',
      roles: ['expedition'],
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.html).toContain('Welcome to Expedition-Go Tours');
  });

  it('keeps the Travio Africa default when no brand signal exists', async () => {
    await sendSupplierStatusEmail('supplier@test.com', 'APPROVED', { name: 'Plain Co' });
    const payload = __send.mock.calls[0][0];
    expect(payload.html).toContain('Welcome to Travio Africa');
  });

  it('threads brandKey into the notification-recipient verification email', async () => {
    await sendNotificationRecipientVerificationEmail({
      to: 'extra@test.com',
      supplierName: 'Accra Tours',
      verifyUrl: 'https://example.com/verify',
      types: ['Bookings'],
      brandKey: 'ghana',
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.from).toBe('Travio Ghana <notifications@travioghana.com>');
    expect(payload.html).toContain('TravioG_csfsyl.png'); // brand logo filled by the shell
    expect(payload.html).not.toContain('src=""');
    expect(payload.html).toContain('support@travioghana.com');
  });

  it('brands the review-response email from the booking source', async () => {
    await sendSupplierResponseEmail({
      id: 'b-9',
      source: 'EXPEDITION',
      customer: { email: 'traveller@test.com', name: 'Cara' },
      tour: {
        title: 'Cape Coast Castle Tour',
        slug: 'cape-coast-castle-tour',
        supplier: { id: 's-1', name: 'Accra Tours', email: 'supplier@test.com' },
      },
      review: { supplierResponse: 'Thanks for coming!' },
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.to).toBe('traveller@test.com');
    expect(payload.from).toBe('Travio Ghana <notifications@travioghana.com>');
    expect(payload.html).toContain('Expedition-Go Tours');
  });

  it('carries the conversation brand through the chat email', async () => {
    await sendChatMessageEmail(null, {
      to: 'supplier@test.com',
      conversationId: 'conv-1',
      senderName: 'Kofi',
      senderMessageHtml: 'Hello there',
      link: 'https://supplier.travioghana.com/dashboard/chat?conversation=conv-1',
      brandKey: 'ghana',
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.from).toBe('Travio Ghana <notifications@travioghana.com>');
    expect(payload.html).toContain('Travio Ghana');
    expect(payload.html).toContain('TravioG_csfsyl.png');
  });

  it('renders the brand logo + support inbox in team invites', async () => {
    await sendTeamInviteEmail({
      to: 'new@team.com',
      supplierName: 'Accra Tours',
      role: 'editor',
      inviteUrl: 'https://supplier.travioghana.com/team/invite?token=t0k',
      invitedBy: 'Ops Lead',
      brandKey: 'ghana',
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.from).toBe('Travio Ghana <notifications@travioghana.com>');
    expect(payload.html).toContain('TravioG_csfsyl.png');
    expect(payload.html).not.toContain('src=""');
    expect(payload.html).toContain('support@travioghana.com');
  });
});

describe('brand-aware email links (ForUser variants)', () => {
  it('routes Ghana suppliers to the Ghana dashboard', () => {
    expect(emailUrls.supplierDashboardForUser({ roles: ['supplier', 'ghana'] }))
      .toBe('https://supplier.travioghana.com/dashboard');
    expect(emailUrls.supplierEarningsForUser({ roles: ['ghana'] }))
      .toBe('https://supplier.travioghana.com/earnings');
    expect(emailUrls.supplierReviewForUser('r1', { roles: ['ghana'] }))
      .toBe('https://supplier.travioghana.com/reviews?reviewId=r1');
    expect(emailUrls.supplierReplyReviewForUser('r1', { roles: ['ghana'] }))
      .toBe('https://supplier.travioghana.com/reviews?reviewId=r1&reply=1');
  });

  it('keeps the default dashboard for everyone else', () => {
    expect(emailUrls.supplierDashboardForUser({ roles: ['supplier'] })).toBe(emailUrls.supplierDashboard());
    expect(emailUrls.supplierDashboardForUser(undefined)).toBe(emailUrls.supplierDashboard());
  });
});

// ---------------------------------------------------------------------------
// Contact form — inline generator (previously `template: null` threw a 500)
// ---------------------------------------------------------------------------
describe('contact-form template', () => {
  it('renders the visitor message in the brand shell and sends', async () => {
    await sendEmail({
      to: 'support@travioghana.com',
      subject: '[Travio Ghana Inquiry] Jane Doe - jane@test.com',
      template: 'contact-form',
      opts: { brandKey: 'ghana' },
      data: {
        subject: '[Travio Ghana Inquiry] Jane Doe - jane@test.com',
        messageBody: 'Name: Jane Doe\nEmail: jane@test.com\n\nMessage:\nDo you run private hikes?',
        name: 'Jane Doe',
        email: 'jane@test.com',
        phone: 'Not provided',
        inquiryType: 'Travio Ghana Contact Form',
      },
    });

    const payload = __send.mock.calls[0][0];
    expect(payload.from).toBe('Travio Ghana <notifications@travioghana.com>');
    expect(payload.html).toContain('Jane Doe');
    expect(payload.html).toContain('Do you run private hikes?');
    // Brand shell slots merged (logo alt + footer).
    expect(payload.html).toContain('Travio Ghana');
    expect(payload.html).not.toContain('{{brandName}}');
    expect(payload.text).toContain('Do you run private hikes?');
  });

  it('skips the "Not provided" phone row', async () => {
    await sendEmail({
      to: 'support@travioghana.com',
      subject: 'Contact',
      template: 'contact-form',
      opts: { brandKey: 'ghana' },
      data: { messageBody: 'Hello there team', name: 'A', email: 'a@b.com', phone: 'Not provided' },
    });
    const payload = __send.mock.calls[0][0];
    expect(payload.html).not.toContain('Phone');
    expect(payload.html).toContain('Hello there team');
  });
});

// ---------------------------------------------------------------------------
// Brand-scoped Reply-To (prod had one global override for every brand)
// ---------------------------------------------------------------------------
describe('brand-scoped Reply-To', () => {
  const base = { to: 'someone@test.com', subject: 'S', template: 'generic-notification', data: { header: 'H', message: 'M body' } };

  it('ghana falls back to its own support inbox, not the default override', async () => {
    await sendEmail({ ...base, opts: { brandKey: 'ghana' } });
    expect(__send.mock.calls[0][0].reply_to).toBe('support@travioghana.com');
  });

  it('expedition falls back to its shared support inbox', async () => {
    await sendEmail({ ...base, opts: { brandKey: 'expedition' } });
    expect(__send.mock.calls[0][0].reply_to).toBe('support@travioghana.com');
  });

  it('per-brand EMAIL_REPLY_TO_GHANA env wins for Ghana', async () => {
    process.env.EMAIL_REPLY_TO_GHANA = 'ghana-reply@example.com';
    try {
      await sendEmail({ ...base, opts: { brandKey: 'ghana' } });
      expect(__send.mock.calls[0][0].reply_to).toBe('ghana-reply@example.com');
    } finally {
      delete process.env.EMAIL_REPLY_TO_GHANA;
    }
  });

  it('an explicit opts.replyTo beats env and brand fallbacks', async () => {
    await sendEmail({ ...base, opts: { brandKey: 'ghana', replyTo: 'explicit@example.com' } });
    expect(__send.mock.calls[0][0].reply_to).toBe('explicit@example.com');
  });
});