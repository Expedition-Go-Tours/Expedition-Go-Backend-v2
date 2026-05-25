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

jest.mock('../../utils/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn() }));

jest.mock('../../utils/emailService', () => ({}));

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: jest.fn() },
    accounts: { create: jest.fn(), createLoginLink: jest.fn() },
    accountLinks: { create: jest.fn() },
    paymentIntents: { create: jest.fn() },
  }));
});

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_load';
});

const prisma = require('../../utils/prismaClient');
const { LoadTest, runLoadTestScenarios } = require('./loadTest');
const {
  calculateCommission,
  processStripeWebhook,
  verifyWebhookSignature,
} = require('../../utils/stripeHelpers');

const mockBooking = {
  id: 'booking-load-1',
  bookingNumber: 'BK-LOAD-001',
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
  paymentStatus: 'SUCCEEDED',
  paidAt: new Date(),
  customers: { id: 'customer-1', name: 'John Doe', email: 'john@test.com' },
  customer: { id: 'customer-1', name: 'John Doe', email: 'john@test.com' },
  tour: {
    id: 'tour-1',
    title: 'Grand Canyon Tour',
    supplierId: 'supplier-1',
    supplier: { id: 'supplier-1', name: 'Canyon Explorers', email: 'supplier@test.com' },
    supplierProfile: {},
  },
};

const mockTx = {
  booking: { updateMany: jest.fn().mockResolvedValue({ count: 2 }), findMany: jest.fn().mockResolvedValue([mockBooking]) },
  notification: { create: jest.fn().mockResolvedValue({}) },
  supplierProfile: { update: jest.fn().mockResolvedValue({}) },
  tour: { update: jest.fn().mockResolvedValue({}) },
  payout: { create: jest.fn().mockResolvedValue({}) },
};

function makeStripeEvent(type) {
  return {
    id: `evt_${Date.now()}_${Math.random()}`,
    type,
    data: { object: { id: 'pi_123', metadata: { bookingIds: 'booking-1,booking-2' } } },
  };
}

describe('Stripe Load Tests', () => {
  const scenarios = [
    { concurrency: 50, targetRps: 500, durationMs: 500 },
    { concurrency: 100, targetRps: 1000, durationMs: 1000 },
    { concurrency: 200, targetRps: 2000, durationMs: 1000 },
  ];

  it('calculateCommission — pure function throughput', async () => {
    const profile = { totalBookings: 30, averageRating: 4.5 };
    const results = await runLoadTestScenarios('calculateCommission', () => {
      calculateCommission(Math.random() * 1000, profile);
      return Promise.resolve();
    }, [
      { concurrency: 100, targetRps: 5000, durationMs: 500 },
      { concurrency: 500, targetRps: 50000, durationMs: 1000 },
    ]);

    expect(results[results.length - 1].throughput).toBeGreaterThan(0);
  }, 30000);

  it('processStripeWebhook — payment succeeded at scale', async () => {
    const results = await runLoadTestScenarios('processStripeWebhook (succeeded)', () => {
      jest.clearAllMocks();
      prisma.stripeEvent.findUnique.mockResolvedValue(null);
      prisma.stripeEvent.upsert.mockResolvedValue({});
      prisma.stripeEvent.update.mockResolvedValue({});
      prisma.$transaction.mockImplementation((cb) => cb(mockTx));
      return processStripeWebhook(makeStripeEvent('payment_intent.succeeded'));
    }, scenarios);

    const best = results[results.length - 1];
    expect(best.throughput).toBeGreaterThan(0);
    expect(best.errorRate).toBe('0.00%');
  }, 30000);

  it('processStripeWebhook — mixed event types', async () => {
    const types = ['payment_intent.succeeded', 'payment_intent.payment_failed', 'charge.updated', 'account.updated'];
    let idx = 0;

    const test = new LoadTest({ name: 'Stripe Webhooks Mixed (c=100)', concurrency: 100, targetRps: 1000, durationMs: 1000 });
    await test.run(() => {
      jest.clearAllMocks();
      prisma.stripeEvent.findUnique.mockResolvedValue(null);
      prisma.stripeEvent.upsert.mockResolvedValue({});
      prisma.stripeEvent.update.mockResolvedValue({});
      prisma.$transaction.mockImplementation((cb) => cb(mockTx));
      return processStripeWebhook(makeStripeEvent(types[idx++ % types.length]));
    });

    const m = test.report();
    expect(m.throughput).toBeGreaterThan(0);
  }, 30000);

  it('verifyWebhookSignature — high concurrency', async () => {
    const Stripe = require('stripe');
    const stripeInstance = Stripe();
    stripeInstance.webhooks.constructEvent.mockImplementation((payload, sig) => {
      if (sig === 'good_sig') return { id: 'evt_valid', type: 'payment_intent.succeeded' };
      throw new Error('Invalid signature');
    });

    const results = await runLoadTestScenarios('verifyWebhookSignature', () => {
      const sig = Math.random() > 0.1 ? 'good_sig' : 'bad_sig';
      try {
        verifyWebhookSignature('payload', sig, 'secret');
      } catch { /* expected for bad_sig */ }
      return Promise.resolve();
    }, [
      { concurrency: 100, targetRps: 5000, durationMs: 500 },
      { concurrency: 500, targetRps: 50000, durationMs: 1000 },
    ]);

    expect(results[results.length - 1].throughput).toBeGreaterThan(0);
  }, 30000);

  it('end-to-end Stripe flow: create PI → webhook → commission calc', async () => {
    const test = new LoadTest({ name: 'Stripe E2E Flow (c=50)', concurrency: 50, targetRps: 500, durationMs: 2000 });

    await test.run(async () => {
      const amount = Math.round(Math.random() * 50000) + 5000;
      const profile = { totalBookings: Math.floor(Math.random() * 200), averageRating: Math.random() * 5 };
      const commission = calculateCommission(amount / 100, profile);

      jest.clearAllMocks();
      prisma.stripeEvent.findUnique.mockResolvedValue(null);
      prisma.stripeEvent.upsert.mockResolvedValue({});
      prisma.stripeEvent.update.mockResolvedValue({});
      prisma.$transaction.mockImplementation((cb) => cb(mockTx));

      await processStripeWebhook(makeStripeEvent('payment_intent.succeeded'));

      return commission.rate > 0;
    });

    const m = test.report();
    expect(m.throughput).toBeGreaterThan(0);
  }, 30000);
});
