jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  tour: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  notification: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), createMany: jest.fn() },
  supplierProfile: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  stripeEvent: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
  $disconnect: jest.fn(),
}));

const prisma = require('../../utils/prismaClient');
const { enqueueEmail } = require('../../utils/queue');
const event = require('../../utils/eventEmitter');
jest.mock('../../utils/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/eventEmitter', () => ({
  emit: jest.fn(),
}));
jest.mock('../../utils/emailService', () => ({}));

const mockConstructEvent = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
    accounts: { create: jest.fn(), createLoginLink: jest.fn() },
    accountLinks: { create: jest.fn() },
    paymentIntents: { create: jest.fn() },
  }));
});
beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
});

const {
  calculateCommission,
  processStripeWebhook,
  verifyWebhookSignature,
} = require('../../utils/stripeHelpers');

const mockBooking = {
  id: 'booking-1',
  bookingNumber: 'BK-001',
  customerId: 'customer-1',
  tourId: 'tour-1',
  status: 'CONFIRMED',
  total: 385,
  currency: 'USD',
  commissionRate: 0.15,
  commissionAmount: 57.75,
  supplierPayout: 327.25,
  stripePaymentIntentId: 'pi_123',
  subtotal: 350,
  taxes: 35,
  fees: 0,
  discounts: 0,
  paymentStatus: 'SUCCEEDED',
  paidAt: new Date(),
  travelers: { adults: 2, children: 0, infants: 0 },
  selectedDate: new Date('2026-07-01'),
  selectedTime: null,
  cancellationReason: null,
  customer: {
    id: 'customer-1',
    name: 'John Doe',
    email: 'john@test.com',
  },
  tour: {
    id: 'tour-1',
    title: 'Grand Canyon Tour',
    supplierId: 'supplier-1',
    supplier: {
      id: 'supplier-1',
      name: 'Canyon Explorers',
      email: 'supplier@test.com',
    },
    supplierProfile: {

    },
  },
};

const mockStripeEvent = (type, data = {}) => ({
  id: `evt_${Date.now()}`,
  type,
  data: { object: { id: 'pi_123', metadata: { bookingIds: 'booking-1,booking-2' }, ...data } },
});

describe('calculateCommission', () => {
  it('returns 15% for default tier (low volume)', () => {
    const profile = { totalBookings: 5, averageRating: null };
    const result = calculateCommission(100, profile);

    expect(result.rate).toBe(0.15);
    expect(result.amount).toBe(15);
    expect(result.supplierPayout).toBe(85);
  });

  it('returns 14% for high-rated new suppliers', () => {
    const profile = { totalBookings: 5, averageRating: 4.9 };
    const result = calculateCommission(100, profile);

    expect(result.rate).toBe(0.14);
  });

  it('returns 13% for medium-volume suppliers (51-100 bookings)', () => {
    const profile = { totalBookings: 75, averageRating: null };
    const result = calculateCommission(100, profile);

    expect(result.rate).toBe(0.13);
  });

  it('returns 12% for high-volume suppliers (100+ bookings)', () => {
    const profile = { totalBookings: 150, averageRating: null };
    const result = calculateCommission(100, profile);

    expect(result.rate).toBe(0.12);
  });

  it('high volume takes priority over high rating', () => {
    const profile = { totalBookings: 150, averageRating: 4.9 };
    const result = calculateCommission(100, profile);

    expect(result.rate).toBe(0.12);
  });

  it('handles zero booking amount', () => {
    const profile = { totalBookings: 0, averageRating: null };
    const result = calculateCommission(0, profile);

    expect(result.rate).toBe(0.15);
    expect(result.amount).toBe(0);
    expect(result.supplierPayout).toBe(0);
  });

  it('handles string amount input', () => {
    const profile = { totalBookings: 10, averageRating: null };
    const result = calculateCommission('200', profile);

    expect(result.rate).toBe(0.15);
    expect(result.amount).toBe(30);
    expect(result.supplierPayout).toBe(170);
  });
});

describe('processStripeWebhook', () => {
  it('skips already processed events (idempotency)', async () => {
    prisma.stripeEvent.findUnique.mockResolvedValue({ processed: true });

    const event = mockStripeEvent('payment_intent.succeeded');
    const result = await processStripeWebhook(event);

    expect(result.message).toContain('already processed');
  });

  it('handles payment_intent.succeeded', async () => {
    prisma.stripeEvent.findUnique.mockResolvedValue(null);
    prisma.stripeEvent.upsert.mockResolvedValue({});
    prisma.stripeEvent.update.mockResolvedValue({});

    prisma.$transaction.mockImplementation(async (cb) => {
      const tx = {
        booking: {
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
          findMany: jest.fn().mockResolvedValue([mockBooking]),
        },
        notification: { create: jest.fn().mockResolvedValue({}) },
        payout: { create: jest.fn().mockResolvedValue({ id: 'payout-1', status: 'PENDING' }) },
        supplierProfile: { update: jest.fn().mockResolvedValue({}) },
        tour: { update: jest.fn().mockResolvedValue({}) },
      };
      await cb(tx);
    });

    const stripeEvent = mockStripeEvent('payment_intent.succeeded');
    const result = await processStripeWebhook(stripeEvent);

    expect(result.success).toBe(true);
    expect(enqueueEmail).toHaveBeenCalled();
    expect(event.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'booking.completed' }));
  });

  it('handles payment_intent.payment_failed', async () => {
    prisma.stripeEvent.findUnique.mockResolvedValue(null);
    prisma.stripeEvent.upsert.mockResolvedValue({});
    prisma.stripeEvent.update.mockResolvedValue({});
    prisma.booking.updateMany.mockResolvedValue({ count: 2 });

    const stripeEvent = mockStripeEvent('payment_intent.payment_failed');
    const result = await processStripeWebhook(stripeEvent);

    expect(result.success).toBe(true);
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentStatus: 'FAILED' }),
      }),
    );
  });

  it('handles payment_intent.succeeded with no booking IDs', async () => {
    prisma.stripeEvent.findUnique.mockResolvedValue(null);
    prisma.stripeEvent.upsert.mockResolvedValue({});
    prisma.stripeEvent.update.mockResolvedValue({});

    const stripeEvent = mockStripeEvent('payment_intent.succeeded', { metadata: {} });
    const result = await processStripeWebhook(stripeEvent);

    expect(result.success).toBe(false);
    expect(result.message).toContain('No bookings found');
  });

  it('handles unhandled event types gracefully', async () => {
    prisma.stripeEvent.findUnique.mockResolvedValue(null);
    prisma.stripeEvent.upsert.mockResolvedValue({});
    prisma.stripeEvent.update.mockResolvedValue({});

    const stripeEvent = mockStripeEvent('charge.updated');
    const result = await processStripeWebhook(stripeEvent);

    expect(result.success).toBe(true);
  });
});

describe('verifyWebhookSignature', () => {
  it('throws on invalid signature', () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('Invalid signature'); });
    expect(() => verifyWebhookSignature('payload', 'bad_sig', 'secret'))
      .toThrow('Invalid webhook signature');
  });

  it('returns event on valid signature', () => {
    const fakeEvent = { id: 'evt_valid', type: 'payment_intent.succeeded' };
    mockConstructEvent.mockReturnValue(fakeEvent);
    const result = verifyWebhookSignature('payload', 'good_sig', 'secret');
    expect(result).toEqual(fakeEvent);
    expect(mockConstructEvent).toHaveBeenCalledWith('payload', 'good_sig', 'secret');
  });
});
