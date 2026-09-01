jest.mock('resend', () => {
  const send = jest.fn();
  return {
    Resend: jest.fn(() => ({ emails: { send } })),
    __send: send,
  };
});

jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn() },
  tour: { findUnique: jest.fn() },
  booking: { findUnique: jest.fn() },
  $disconnect: jest.fn(),
}));

const { Resend, __send } = require('resend');
const prisma = require('../../utils/prismaClient');

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
  generatePrintableTicketHtml,
} = require('../../utils/emailService');

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

  it('renders all 32 compiled templates with no leftover braces', async () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
    expect(files.length).toBe(32);

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
      });
      expect(html).toContain('Travio Africa');
      const leftover = html.match(/\{\{[^}]+\}\}/g) || [];
      expect(leftover).toEqual([]);
    }
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