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
    expect(msg.templateId).toBe('d-12b0cfb8cf1f4211a22db258e13c9f30');
    expect(msg.dynamicTemplateData.title).toBe('Hello');
    expect(msg.dynamicTemplateData.message).toBe('World');
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

  it('falls back to generic fallback for unknown template name', async () => {
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'msg-789' } }]);

    await sendEmail({
      to: 'test@test.com',
      subject: 'Unknown',
      template: 'non-existent-template',
      data: { title: 'Fallback', message: 'Generic body' },
    });

    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.html).toContain('Email template not found');
  });

  it('outputs each known template type correctly', async () => {
    sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'm' } }]);

    const templateIds = {
      'booking-confirmation': 'd-0a159d1f1c43422d85195f8d8f898506',
      'booking-cancellation': 'd-3b94f590c23f4530a05152bbdca561b0',
      'supplier-approved': 'd-2f3d5b9302ae459b8ac94758a70d6ce6',
      'supplier-rejected': 'd-46112aefe32a4e1a846ec72b5ddc38e4',
      'supplier-under-review': 'd-875a87dd2cf14a11a4f1075d053fc6b1',
      'supplier-activated': 'd-493cd6b3347e4552a09f6c7d70a4a933',
      'supplier-suspended': 'd-d09364df53b4467ea43a7128483295e3',
    };

    const cases = [
      { template: 'booking-confirmation', data: { tourTitle: 'T', bookingNumber: 'B1', customerName: 'J', selectedDate: '2026-07-01', totalAmount: 100, currency: 'USD' } },
      { template: 'booking-cancellation', data: { tourTitle: 'T', bookingNumber: 'B1', customerName: 'J', selectedDate: '2026-07-01' } },
      { template: 'supplier-approved', data: { name: 'Biz' } },
      { template: 'supplier-rejected', data: { name: 'Biz' } },
      { template: 'supplier-under-review', data: { name: 'Biz' } },
      { template: 'supplier-activated', data: { name: 'Biz' } },
      { template: 'supplier-suspended', data: { name: 'Biz' } },
    ];

    for (const c of cases) {
      await sendEmail({ to: 't@t.com', subject: 'S', template: c.template, data: c.data });
      const msg = sgMail.send.mock.calls[sgMail.send.mock.calls.length - 1][0];
      expect(msg.templateId).toBe(templateIds[c.template]);
      expect(msg.dynamicTemplateData).toBeDefined();
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
    expect(msg.templateId).toBe('d-0a159d1f1c43422d85195f8d8f898506');
    expect(msg.dynamicTemplateData.bookingNumber).toBe('TB-001');
    expect(msg.dynamicTemplateData.tourTitle).toBe('Test Tour');
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
    expect(msg.templateId).toBe('d-3b94f590c23f4530a05152bbdca561b0');
    expect(msg.dynamicTemplateData.bookingNumber).toBe('TB-001');
    expect(msg.dynamicTemplateData.cancellationReason).toBe('Schedule conflict');
    expect(msg.dynamicTemplateData.refundAmount).toBe(220);
  });

  it('sends cancellation without refund', async () => {
    await sendBookingCancellationEmail(mockBooking);
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.templateId).toBe('d-3b94f590c23f4530a05152bbdca561b0');
    expect(msg.dynamicTemplateData.bookingNumber).toBe('TB-001');
    expect(msg.dynamicTemplateData.refundAmount).toBeNull();
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

  const statusTemplateIds = {
    APPROVED: 'd-2f3d5b9302ae459b8ac94758a70d6ce6',
    REJECTED: 'd-46112aefe32a4e1a846ec72b5ddc38e4',
    UNDER_REVIEW: 'd-875a87dd2cf14a11a4f1075d053fc6b1',
    ACTIVE: 'd-493cd6b3347e4552a09f6c7d70a4a933',
    SUSPENDED: 'd-d09364df53b4467ea43a7128483295e3',
  };
  statuses.forEach((status) => {
    it(`sends ${status} email correctly`, async () => {
      await sendSupplierStatusEmail('supplier@test.com', status, { name: 'Test Business' });
      const msg = sgMail.send.mock.calls[0][0];
      expect(msg.to).toBe('supplier@test.com');
      expect(msg.templateId).toBe(statusTemplateIds[status]);
      expect(msg.dynamicTemplateData.supplierBusinessName).toBe('Test Business');
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
    expect(msg.templateId).toBe('d-3fd7be6a230d418e92090c8bc888f8e7');
    expect(msg.dynamicTemplateData.tourTitle).toBe('Test Tour');
    expect(msg.dynamicTemplateData.customerName).toBe('John Doe');
    expect(msg.dynamicTemplateData.reviewComment).toBe('Best tour ever');
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
    expect(msg.templateId).toBe('d-78cb9803209e42f6a80cfe45b9cdfc3b');
    expect(msg.dynamicTemplateData.supplierName).toBe('Supplier Co');
    expect(msg.dynamicTemplateData.payoutAmount).toBe(500);
    expect(msg.dynamicTemplateData.payoutId).toBe('po-001');
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
    expect(msg.templateId).toBe('d-2973e0ab70734472985569ca1e20b220');
    expect(msg.dynamicTemplateData.customerName).toBe('John Doe');
    expect(msg.dynamicTemplateData.customerPhone).toBe('+233501234567');
    expect(msg.dynamicTemplateData.travelerCount).toBe(3);
    expect(msg.dynamicTemplateData.totalAmount).toBe(220);
  });

  it('handles missing customer gracefully', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === 's-1') return Promise.resolve(mockSupplier);
      return Promise.resolve(null);
    });
    await sendSupplierBookingNotification(mockBooking);
    const msg = sgMail.send.mock.calls[0][0];
    expect(msg.dynamicTemplateData.customerName).toBe('Guest');
  });

  it('handles missing supplier gracefully', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await sendSupplierBookingNotification(mockBooking);
    expect(sgMail.send).not.toHaveBeenCalled();
  });
});
