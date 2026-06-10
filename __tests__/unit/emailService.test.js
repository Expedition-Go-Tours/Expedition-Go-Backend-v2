jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn(),
}));

jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn() },
  tour: { findUnique: jest.fn() },
  $disconnect: jest.fn(),
}));

const sgMail = require('@sendgrid/mail');
const prisma = require('../../utils/prismaClient');

beforeAll(() => {
  process.env.SENDGRID_API_KEY = 'test-key';
  process.env.EMAIL_FROM = 'Travio Africa <noreply@travioafrica.com>';
  process.env.EMAIL_REPLY_TO = 'support@travioafrica.com';
  process.env.CLIENT_URL = 'https://travioafrica.com';
  process.env.SUPPORT_EMAIL = 'support@expeditiongo.com';
  process.env.LOGO_URL = 'https://example.com/logo.png';
});

beforeEach(() => {
  jest.clearAllMocks();
});

const {
  sendEmail,
  sendBookingConfirmationEmail,
  sendBookingCancellationEmail,
  sendSupplierStatusEmail,
  sendReviewNotificationEmail,
  sendPayoutNotificationEmail,
  sendSupplierBookingNotification,
  generatePrintableTicketHtml,
} = require('../../utils/emailService');

// ---------------------------------------------------------------------------
// sendEmail — core send function
// ---------------------------------------------------------------------------
describe('sendEmail', () => {
  it('sends via SendGrid with correct structure', async () => {
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'msg-123' } }]);

    const result = await sendEmail({
      to: 'test@test.com',
      subject: 'Test Subject',
      template: 'generic-notification',
      data: { title: 'Hello', message: 'World' },
    });

    expect(sgMail.setApiKey).toHaveBeenCalledWith('test-key');
    expect(sgMail.send).toHaveBeenCalledTimes(1);
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.to).toBe('test@test.com');
    expect(msg.subject).toBe('Test Subject');
    expect(msg.from.email).toBe('noreply@travioafrica.com');
    expect(msg.from.name).toBe('Travio Africa');
    expect(msg.html).toContain('Hello');
    expect(msg.text).toContain('Hello');
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-123');
  });

  it('throws when SendGrid fails', async () => {
    sgMail.send.mockRejectedValue(new Error('SendGrid error'));

    await expect(sendEmail({
      to: 'test@test.com',
      subject: 'Fail',
      template: 'generic-notification',
      data: { title: 'Oops', message: 'Fail' },
    })).rejects.toThrow('Failed to send email: SendGrid error');
  });

  it('handles EMAIL_FROM without display name', async () => {
    process.env.EMAIL_FROM = 'noreply@travioafrica.com';
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'msg-456' } }]);

    const result = await sendEmail({
      to: 'test@test.com',
      subject: 'No Name',
      template: 'generic-notification',
      data: { title: 'Test', message: 'Body' },
    });

    expect(result.success).toBe(true);
  });

  it('falls back to generic template for unknown template name', async () => {
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'msg-789' } }]);

    await sendEmail({
      to: 'test@test.com',
      subject: 'Unknown',
      template: 'non-existent-template',
      data: { title: 'Fallback', message: 'Generic body' },
    });

    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.html).toContain('Fallback');
    expect(msg.html).toContain('Generic body');
  });

  it('outputs each known template type correctly', async () => {
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'm' } }]);

    const cases = [
      { template: 'booking-confirmation', data: { tourTitle: 'T', bookingNumber: 'B1', customerName: 'J', selectedDate: '2026-07-01', totalAmount: 100, currency: 'USD' }, expectHtml: 'Booking Confirmed' },
      { template: 'booking-cancellation', data: { tourTitle: 'T', bookingNumber: 'B1', customerName: 'J', selectedDate: '2026-07-01' }, expectHtml: 'Booking Cancelled' },
      { template: 'supplier-approved', data: { name: 'Biz' }, expectHtml: 'Welcome to' },
      { template: 'supplier-rejected', data: { name: 'Biz' }, expectHtml: 'Application Update' },
      { template: 'supplier-under-review', data: { name: 'Biz' }, expectHtml: 'Additional Information Required' },
      { template: 'supplier-activated', data: { name: 'Biz' }, expectHtml: 'Account Activated' },
      { template: 'supplier-suspended', data: { name: 'Biz' }, expectHtml: 'Account Suspended' },
    ];

    for (const c of cases) {
      await sendEmail({ to: 't@t.com', subject: 'S', template: c.template, data: c.data });
      const msg = sgMail.send.mock.calls[sgMail.send.mock.calls.length - 1][0];
      expect(msg.html).toContain(c.expectHtml);
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
      selectedDate: '2026-07-01T00:00:00.000Z',
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
      selectedDate: '2026-08-15T00:00:00.000Z',
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
// sendBookingConfirmationEmail
// ---------------------------------------------------------------------------
describe('sendBookingConfirmationEmail', () => {
  const mockCustomer = { id: 'cust-1', name: 'John Doe', email: 'john@test.com' };
  const mockTour = {
    id: 'tour-1',
    title: 'Test Tour',
    description: 'A wonderful tour',
    productContent: {
      included: ['Professional guide', 'Lunch'],
      whatToBring: ['Sunscreen', 'Hat'],
      highlights: ['Scenic views'],
      restrictions: null,
    },
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
    selectedDate: new Date('2026-07-01T10:00:00Z'),
    selectedTime: '10:00',
    travelers: { adults: 2, children: 1, infants: 0 },
    subtotal: 200,
    taxes: 20,
    total: 220,
    currency: 'USD',
  };

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockCustomer);
    prisma.tour.findUnique.mockResolvedValue(mockTour);
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'msg-bc' } }]);
  });

  it('sends confirmation with correct data', async () => {
    await sendBookingConfirmationEmail(mockBooking);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'cust-1' } });
    expect(prisma.tour.findUnique).toHaveBeenCalledWith({
      where: { id: 'tour-1' },
      include: { supplier: { select: { name: true, email: true, phone: true } } },
    });
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.subject).toContain('Booking Confirmed');
    expect(msg.subject).toContain('Test Tour');
    expect(msg.subject).toContain('TB-001');
    expect(msg.html).toContain('2 Adult(s)');
    expect(msg.html).toContain('1 Child(ren)');
    expect(msg.html).toContain('Main Gate');
    expect(msg.html).toContain('Professional guide');
  });

  it('handles missing customer gracefully', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await sendBookingConfirmationEmail(mockBooking);
    expect(sgMail.send).not.toHaveBeenCalled();
  });

  it('handles missing tour gracefully', async () => {
    prisma.tour.findUnique.mockResolvedValue(null);
    await sendBookingConfirmationEmail(mockBooking);
    expect(sgMail.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sendBookingCancellationEmail
// ---------------------------------------------------------------------------
describe('sendBookingCancellationEmail', () => {
  const mockCustomer = { id: 'cust-1', name: 'John Doe', email: 'john@test.com' };
  const mockTour = { id: 'tour-1', title: 'Test Tour' };
  const mockBooking = {
    id: 'booking-1',
    bookingNumber: 'TB-001',
    customerId: 'cust-1',
    tourId: 'tour-1',
    selectedDate: new Date('2026-07-01'),
    cancellationReason: 'Schedule conflict',
    currency: 'USD',
    total: 220,
  };

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockCustomer);
    prisma.tour.findUnique.mockResolvedValue(mockTour);
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'm' } }]);
  });

  it('sends cancellation with refund when provided', async () => {
    await sendBookingCancellationEmail(mockBooking, 220);
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.subject).toContain('Booking Cancelled');
    expect(msg.html).toContain('TB-001');
    expect(msg.html).toContain('Schedule conflict');
    expect(msg.html).toContain('220.00');
  });

  it('sends cancellation without refund', async () => {
    await sendBookingCancellationEmail(mockBooking);
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.html).toContain('TB-001');
    expect(msg.html).not.toContain('Refund');
  });

  it('throws on DB error', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('DB error'));
    await expect(sendBookingCancellationEmail(mockBooking)).rejects.toThrow('DB error');
  });
});

// ---------------------------------------------------------------------------
// sendSupplierStatusEmail
// ---------------------------------------------------------------------------
describe('sendSupplierStatusEmail', () => {
  beforeEach(() => {
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'm' } }]);
  });

  const statuses = ['APPROVED', 'REJECTED', 'UNDER_REVIEW', 'ACTIVE', 'SUSPENDED'];

  statuses.forEach((status) => {
    it(`sends ${status} email correctly`, async () => {
      await sendSupplierStatusEmail('supplier@test.com', status, { name: 'Test Business' });
      const msg = sgMail.send.mock.calls[0][0];
      expect(msg.to).toBe('supplier@test.com');
      expect(msg.html).toContain('Test Business');
    });
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
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'm' } }]);
  });

  it('sends review notification to supplier', async () => {
    await sendReviewNotificationEmail(mockReview);
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.to).toBe('supplier@test.com');
    expect(msg.subject).toContain('5-Star Review');
    expect(msg.html).toContain('Test Tour');
    expect(msg.html).toContain('John Doe');
    expect(msg.html).toContain('Best tour ever');
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
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'm' } }]);
  });

  it('sends payout notification', async () => {
    await sendPayoutNotificationEmail('s-1', payoutData);
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.to).toBe('supplier@test.com');
    expect(msg.subject).toContain('Payout Processed');
    expect(msg.html).toContain('Supplier Co');
    expect(msg.html).toContain('500');
    expect(msg.html).toContain('po-001');
  });

  it('throws when supplier not found', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(sendPayoutNotificationEmail('bad-id', payoutData)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sendSupplierBookingNotification
// ---------------------------------------------------------------------------
describe('sendSupplierBookingNotification', () => {
  const mockSupplier = { id: 's-1', name: 'Supplier Co', email: 'supplier@test.com' };
  const mockCustomer = { id: 'c-1', name: 'John Doe', email: 'john@test.com' };
  const mockTour = { id: 'tour-1', title: 'Test Tour', supplierId: 's-1' };
  const mockBooking = {
    id: 'b-1',
    bookingNumber: 'TB-001',
    tourId: 'tour-1',
    customerId: 'c-1',
    selectedDate: new Date('2026-07-01T10:00:00Z'),
    selectedTime: '10:00',
    travelers: { adults: 2, children: 1, infants: 0, phoneNumber: '+233501234567', location: 'Accra' },
    total: 220,
    currency: 'USD',
    tour: { supplierId: 's-1' },
  };

  beforeEach(() => {
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === 's-1') return Promise.resolve(mockSupplier);
      if (where.id === 'c-1') return Promise.resolve(mockCustomer);
      return Promise.resolve(null);
    });
    prisma.tour.findUnique.mockResolvedValue(mockTour);
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'm' } }]);
  });

  it('sends booking notification to supplier', async () => {
    await sendSupplierBookingNotification(mockBooking);
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.to).toBe('supplier@test.com');
    expect(msg.subject).toContain('New Booking');
    expect(msg.html).toContain('John Doe');
    expect(msg.html).toContain('+233501234567');
    expect(msg.html).toContain('3 guest(s)');
    expect(msg.html).toContain('220');
  });

  it('handles missing customer gracefully', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === 's-1') return Promise.resolve(mockSupplier);
      return Promise.resolve(null);
    });
    await sendSupplierBookingNotification(mockBooking);
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.html).toContain('Guest');
  });

  it('handles missing supplier gracefully', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await sendSupplierBookingNotification(mockBooking);
    expect(sgMail.send).not.toHaveBeenCalled();
  });
});
