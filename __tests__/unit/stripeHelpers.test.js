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
const { enqueueEmail, enqueueEvent } = require('../../utils/queue');
jest.mock('../../utils/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueWebhookRetry: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/eventEmitter', () => ({
  emit: jest.fn(),
}));
jest.mock('../../utils/emailService', () => ({}));
jest.mock('../../utils/getConfig', () => jest.fn((key, defaultValue) => Promise.resolve(defaultValue)));

const mockConstructEvent = jest.fn();
let mockStripeInstance;
jest.mock('stripe', () => {
  mockStripeInstance = {
    webhooks: { constructEvent: mockConstructEvent },
    accounts: { create: jest.fn(), createLoginLink: jest.fn() },
    accountLinks: { create: jest.fn() },
    paymentIntents: { create: jest.fn(), retrieve: jest.fn(), cancel: jest.fn() },
  };
  return jest.fn(() => mockStripeInstance);
});
beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
});

const {
  calculateCommission,
  processStripeWebhook,
  verifyWebhookSignature,
  cancelPaymentIntent,
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
  it('returns 15% for default tier (low volume)', async () => {
    const profile = { totalBookings: 5, averageRating: null };
    const result = await calculateCommission(100, profile);

    expect(result.rate).toBe(0.15);
    expect(result.amount).toBe(15);
    expect(result.supplierPayout).toBe(85);
  });

  it('returns 14% for high-rated new suppliers', async () => {
    const profile = { totalBookings: 5, averageRating: 4.9 };
    const result = await calculateCommission(100, profile);

    expect(result.rate).toBeCloseTo(0.14);
  });

  it('returns 13% for medium-volume suppliers (51-100 bookings)', async () => {
    const profile = { totalBookings: 75, averageRating: null };
    const result = await calculateCommission(100, profile);

    expect(result.rate).toBe(0.13);
  });

  it('returns 12% for high-volume suppliers (100+ bookings)', async () => {
    const profile = { totalBookings: 150, averageRating: null };
    const result = await calculateCommission(100, profile);

    expect(result.rate).toBe(0.12);
  });

  it('high volume takes priority over high rating', async () => {
    const profile = { totalBookings: 150, averageRating: 4.9 };
    const result = await calculateCommission(100, profile);

    expect(result.rate).toBe(0.12);
  });

  it('handles zero booking amount', async () => {
    const profile = { totalBookings: 0, averageRating: null };
    const result = await calculateCommission(0, profile);

    expect(result.rate).toBe(0.15);
    expect(result.amount).toBe(0);
    expect(result.supplierPayout).toBe(0);
  });

  it('handles string amount input', async () => {
    const profile = { totalBookings: 10, averageRating: null };
    const result = await calculateCommission('200', profile);

    expect(result.rate).toBe(0.15);
    expect(result.amount).toBe(30);
    expect(result.supplierPayout).toBe(170);
  });
});

describe('processStripeWebhook', () => {
  let tx;

  beforeEach(() => {
    tx = null;
    prisma.$transaction.mockImplementation(async (cb) => {
      tx = {
        stripeEvent: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
        },
        booking: {
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
          findMany: jest.fn().mockResolvedValue([mockBooking]),
        },
        notification: { create: jest.fn().mockResolvedValue({}) },
        payout: { create: jest.fn().mockResolvedValue({ id: 'payout-1', status: 'PENDING' }) },
        payoutMethod: { findFirst: jest.fn().mockResolvedValue({ id: 'pm-1', type: 'bank' }) },
        supplierProfile: { update: jest.fn().mockResolvedValue({}) },
        tour: { update: jest.fn().mockResolvedValue({}) },
        specialOffer: { update: jest.fn().mockResolvedValue({}) },
      };
      await cb(tx);
    });
  });

  it('skips already processed events (idempotency)', async () => {
    const mockTx = {
      stripeEvent: {
        findUnique: jest.fn().mockResolvedValue({ processed: true }),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };
    tx = mockTx;
    prisma.$transaction.mockImplementation(async (cb) => {
      await cb(mockTx);
    });

    const event = mockStripeEvent('payment_intent.succeeded');
    const result = await processStripeWebhook(event);

    expect(result.success).toBe(true);
    expect(result.message).toContain('processed');
  });

  it('handles payment_intent.succeeded', async () => {
    const stripeEvent = mockStripeEvent('payment_intent.succeeded');
    await processStripeWebhook(stripeEvent);

    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    expect(enqueueEmail).toHaveBeenCalled();
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'booking.completed' }));
  });

  it('does not resurrect already-cancelled bookings on a late succeeded event', async () => {
    tx = {
      stripeEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      booking: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn(),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
      payout: { create: jest.fn().mockResolvedValue({ id: 'payout-1', status: 'PENDING' }) },
      payoutMethod: { findFirst: jest.fn().mockResolvedValue({ id: 'pm-1', type: 'bank' }) },
      supplierProfile: { update: jest.fn().mockResolvedValue({}) },
      tour: { update: jest.fn().mockResolvedValue({}) },
      specialOffer: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation(async (cb) => {
      await cb(tx);
    });
    enqueueEmail.mockClear();
    enqueueEvent.mockClear();

    await processStripeWebhook(mockStripeEvent('payment_intent.succeeded'));

    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    expect(tx.booking.findMany).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('handles payment_intent.payment_failed', async () => {
    const stripeEvent = mockStripeEvent('payment_intent.payment_failed');
    await processStripeWebhook(stripeEvent);

    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING' }),
        data: expect.objectContaining({ paymentStatus: 'FAILED' }),
      }),
    );
  });

  it('handles payment_intent.succeeded with no booking IDs (falls back to PI ID lookup)', async () => {
    const stripeEvent = mockStripeEvent('payment_intent.succeeded', { metadata: {} });
    await processStripeWebhook(stripeEvent);

    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stripePaymentIntentId: 'pi_123',
          status: 'PENDING',
          paymentStatus: { in: ['PENDING', 'PROCESSING'] },
        }),
      }),
    );
  });

  it('handles unhandled event types gracefully', async () => {
    const stripeEvent = mockStripeEvent('charge.updated');
    await processStripeWebhook(stripeEvent);

    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });
});

describe('cancelPaymentIntent', () => {
  beforeEach(() => {
    mockStripeInstance.paymentIntents.retrieve.mockReset();
    mockStripeInstance.paymentIntents.cancel.mockReset();
  });

  it('reports ok when the intent is already canceled', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });

    await expect(cancelPaymentIntent('pi_x')).resolves.toEqual({ ok: true });
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it('blocks when the intent already succeeded', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ status: 'succeeded' });

    await expect(cancelPaymentIntent('pi_x')).resolves.toEqual({ ok: false, reason: 'status_succeeded' });
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it('blocks when the intent is still processing', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ status: 'processing' });

    await expect(cancelPaymentIntent('pi_x')).resolves.toEqual({ ok: false, reason: 'status_processing' });
  });

  it('cancels a cancelable intent and reports success', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });
    mockStripeInstance.paymentIntents.cancel.mockResolvedValue({ status: 'canceled' });

    await expect(cancelPaymentIntent('pi_x')).resolves.toEqual({ ok: true });
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith('pi_x');
  });

  it('reports cancel_failed when Stripe rejects the cancel', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });
    mockStripeInstance.paymentIntents.cancel.mockRejectedValue(new Error('cannot cancel this intent'));

    await expect(cancelPaymentIntent('pi_x')).resolves.toEqual({ ok: false, reason: 'cancel_failed' });
  });

  it('reports unavailable when the intent cannot be retrieved', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockRejectedValue(new Error('network error'));

    await expect(cancelPaymentIntent('pi_x')).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('treats missing id as nothing to cancel', async () => {
    await expect(cancelPaymentIntent(null)).resolves.toEqual({ ok: true });
    await expect(cancelPaymentIntent('')).resolves.toEqual({ ok: true });
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
