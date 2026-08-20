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
const { enqueueEmail, enqueueEvent, enqueueNotification } = require('../../utils/queue');
jest.mock('../../utils/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueWebhookRetry: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/eventEmitter', () => ({
  emit: jest.fn(),
}));
jest.mock('../../utils/redisClient', () => ({
  setnx: jest.fn(async () => null),
  del: jest.fn(async () => undefined),
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
    customers: { create: jest.fn(), list: jest.fn() },
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
  createPaymentIntent,
  createStripeCustomer,
  ensureStripeCustomer,
  handlePaymentSucceeded,
} = require('../../utils/stripeHelpers');
const redis = require('../../utils/redisClient');
const getConfig = require('../../utils/getConfig');

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

  it('tolerates percentage-style config (15 → 0.15)', async () => {
    getConfig.mockResolvedValueOnce('15');
    const profile = { totalBookings: 5, averageRating: null };
    const result = await calculateCommission(100, profile);

    expect(result.rate).toBe(0.15);
    expect(result.amount).toBe(15);
    expect(result.supplierPayout).toBe(85);
  });

  it('clamps an oversized config to at most 100%', async () => {
    getConfig.mockResolvedValueOnce('150');
    const profile = { totalBookings: 5, averageRating: null };
    const result = await calculateCommission(100, profile);

    expect(result.rate).toBe(1);
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
        where: expect.objectContaining({ paymentStatus: { in: ['PENDING', 'PROCESSING'] } }),
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
        where: expect.objectContaining({ paymentStatus: { in: ['PENDING', 'PROCESSING'] } }),
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
        where: expect.objectContaining({ paymentStatus: { in: ['PENDING', 'PROCESSING'] } }),
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

  it('handles checkout.session.completed by attaching the PI and settling the booking', async () => {
    enqueueEmail.mockClear();
    enqueueEvent.mockClear();

    const stripeEvent = {
      id: `evt_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          payment_intent: 'pi_456',
          metadata: { bookingIds: 'booking-1', source: 'expedition' },
        },
      },
    };

    const result = await processStripeWebhook(stripeEvent);

    expect(result.success).toBe(true);
    // Attach the session's PaymentIntent to the booking.
    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['booking-1'] } }),
        data: expect.objectContaining({ stripePaymentIntentId: 'pi_456', stripeCheckoutSessionId: 'cs_test_123' }),
      }),
    );
    // Settle the booking to CONFIRMED.
    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paymentStatus: { in: ['PENDING', 'PROCESSING'] } }),
        data: expect.objectContaining({ status: 'CONFIRMED', paymentStatus: 'SUCCEEDED' }),
      }),
    );
    expect(enqueueEmail).toHaveBeenCalled();
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'booking.completed' }));
  });

  it('handles checkout.session.expired by cancelling pending bookings', async () => {
    enqueueNotification.mockClear();
    enqueueEvent.mockClear();

    const stripeEvent = {
      id: `evt_${Date.now()}`,
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_test_123',
          metadata: { bookingIds: 'booking-1', source: 'expedition' },
        },
      },
    };

    const result = await processStripeWebhook(stripeEvent);

    expect(result.success).toBe(true);
    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['booking-1'] } }),
        data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'FAILED' }),
      }),
    );
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BOOKING_CANCELLED' }),
    );
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'booking.expired' }));
  });
});

describe('handlePaymentSucceeded offer capacity guard', () => {
  function baseClient() {
    return {
      booking: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ ...mockBooking, appliedOfferId: 'offer-1' }]),
        update: jest.fn().mockResolvedValue({}),
      },
      specialOffer: {
        findUnique: jest.fn().mockResolvedValue({ capacityType: 'CAPPED', maxSpots: 10, spotsSold: 5 }),
        update: jest.fn().mockResolvedValue({}),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      notification: { create: jest.fn().mockResolvedValue({}) },
      supplierProfile: { update: jest.fn().mockResolvedValue({}) },
      tour: { update: jest.fn().mockResolvedValue({}) },
      payoutMethod: { findFirst: jest.fn().mockResolvedValue(null) },
      payout: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  it('consumes capacity atomically for capped offers with room left', async () => {
    const client = baseClient();

    const result = await handlePaymentSucceeded({ id: 'pi_1', metadata: { bookingIds: 'booking-1' } }, client);

    expect(client.$executeRaw).toHaveBeenCalledTimes(1);
    expect(client.specialOffer.update).not.toHaveBeenCalled();
    expect(result.bookings).toHaveLength(1);
    expect(result.oversold).toHaveLength(0);
  });

  it('cancels the booking and flags it for refund when capacity is exhausted', async () => {
    const client = baseClient();
    client.$executeRaw.mockResolvedValue(0);

    const result = await handlePaymentSucceeded({ id: 'pi_1', metadata: { bookingIds: 'booking-1' } }, client);

    expect(client.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'booking-1' },
        data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'FAILED' }),
      })
    );
    expect(result.bookings).toHaveLength(0);
    expect(result.oversold).toHaveLength(1);
    expect(result.oversold[0].id).toBe('booking-1');
  });

  it('keeps the legacy increment for uncapped offers', async () => {
    const client = baseClient();
    client.specialOffer.findUnique.mockResolvedValue({ capacityType: 'UNLIMITED', maxSpots: null, spotsSold: 0 });

    const result = await handlePaymentSucceeded({ id: 'pi_1', metadata: { bookingIds: 'booking-1' } }, client);

    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(client.specialOffer.update).toHaveBeenCalledWith({
      where: { id: 'offer-1' },
      data: { spotsSold: { increment: 2 } },
    });
    expect(result.oversold).toHaveLength(0);
  });
});

describe('handlePaymentSucceeded manual confirmation', () => {
  function clientFor(booking) {
    return {
      booking: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([booking]),
        update: jest.fn().mockResolvedValue({}),
      },
      specialOffer: {
        findUnique: jest.fn().mockResolvedValue({ capacityType: 'UNLIMITED', maxSpots: null, spotsSold: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      notification: { create: jest.fn().mockResolvedValue({}) },
      supplierProfile: { update: jest.fn().mockResolvedValue({}) },
      tour: { update: jest.fn().mockResolvedValue({}) },
      payoutMethod: { findFirst: jest.fn().mockResolvedValue(null) },
      payout: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  it('holds the booking PENDING (paid) when the tour is manual-confirmation', async () => {
    const booking = {
      ...mockBooking,
      tour: { ...mockBooking.tour, bookingAndTickets: { instantConfirmation: false } },
    };
    const client = clientFor(booking);

    const result = await handlePaymentSucceeded({ id: 'pi_1', metadata: { bookingIds: 'booking-1' } }, client);

    // The corrective updateMany re-holds the paid booking as PENDING.
    expect(client.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['booking-1'] } }),
        data: expect.objectContaining({ status: 'PENDING' }),
      })
    );
    expect(result.bookings[0].status).toBe('PENDING');
    // Customer notification reflects awaiting-confirmation, not confirmed.
    const notifCall = client.notification.create.mock.calls.find(
      (c) => c[0].data.userId === 'customer-1'
    );
    expect(notifCall[0].data.type).toBe('BOOKING_AWAITING_CONFIRMATION');
  });

  it('auto-confirms when instantConfirmation is unset (default instant)', async () => {
    const client = clientFor(mockBooking); // tour has no bookingAndTickets

    const result = await handlePaymentSucceeded({ id: 'pi_1', metadata: { bookingIds: 'booking-1' } }, client);

    const confirmCall = client.booking.updateMany.mock.calls.find(
      (c) => c[0].data && c[0].data.status === 'CONFIRMED'
    );
    expect(confirmCall).toBeTruthy();
    expect(result.bookings[0].status).toBe('CONFIRMED');
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

describe('createPaymentIntent customer guard', () => {
  beforeEach(() => {
    mockStripeInstance.paymentIntents.create.mockClear();
    mockStripeInstance.paymentIntents.create.mockResolvedValue({ id: 'pi_123', client_secret: 'secret_123' });
  });

  it('omits customer when customerId is an empty string', async () => {
    await createPaymentIntent({ amount: 1000, customerId: '' });
    const [data] = mockStripeInstance.paymentIntents.create.mock.calls[0];
    expect(data).not.toHaveProperty('customer');
  });

  it('omits customer when customerId is null', async () => {
    await createPaymentIntent({ amount: 1000, customerId: null });
    const [data] = mockStripeInstance.paymentIntents.create.mock.calls[0];
    expect(data).not.toHaveProperty('customer');
  });

  it('omits customer when customerId is undefined', async () => {
    await createPaymentIntent({ amount: 1000 });
    const [data] = mockStripeInstance.paymentIntents.create.mock.calls[0];
    expect(data).not.toHaveProperty('customer');
  });

  it('omits customer when customerId is not a cus_ id', async () => {
    await createPaymentIntent({ amount: 1000, customerId: 'not-a-customer' });
    const [data] = mockStripeInstance.paymentIntents.create.mock.calls[0];
    expect(data).not.toHaveProperty('customer');
  });

  it('includes customer when customerId is a valid cus_ id', async () => {
    await createPaymentIntent({ amount: 1000, customerId: 'cus_abc123' });
    const [data] = mockStripeInstance.paymentIntents.create.mock.calls[0];
    expect(data.customer).toBe('cus_abc123');
  });

  it('still sends amount, payment method and metadata', async () => {
    await createPaymentIntent({ amount: 1000, currency: 'USD', paymentMethodId: 'pm_1', metadata: { tourId: 't1' } });
    const [data] = mockStripeInstance.paymentIntents.create.mock.calls[0];
    expect(data.amount).toBe(1000);
    expect(data.currency).toBe('usd');
    expect(data.payment_method).toBe('pm_1');
    expect(data.metadata).toEqual({ tourId: 't1' });
  });

  it('omits return_url when confirm is false (Stripe rejects it otherwise)', async () => {
    await createPaymentIntent({ amount: 1000, confirm: false });
    const [data] = mockStripeInstance.paymentIntents.create.mock.calls[0];
    expect(data).not.toHaveProperty('return_url');
  });

  it('includes return_url when confirm is true', async () => {
    process.env.CLIENT_URL = 'https://example.com';
    await createPaymentIntent({ amount: 1000, confirm: true });
    const [data] = mockStripeInstance.paymentIntents.create.mock.calls[0];
    expect(data.return_url).toBe('https://example.com/booking/complete');
  });
});

describe('createPaymentIntent derived idempotency key', () => {
  beforeEach(() => {
    mockStripeInstance.paymentIntents.create.mockClear();
    mockStripeInstance.paymentIntents.create.mockResolvedValue({ id: 'pi_123', client_secret: 'secret_123' });
  });

  const keyOf = (call) => call[1]?.idempotencyKey;

  it('uses an explicit idempotencyKey verbatim', async () => {
    await createPaymentIntent({ amount: 1000, customerId: 'cus_abc123', idempotencyKey: 'client-key-1' });
    expect(keyOf(mockStripeInstance.paymentIntents.create.mock.calls[0])).toBe('client-key-1');
  });

  it('derives a stable key for identical requests', async () => {
    await createPaymentIntent({ amount: 1000, customerId: 'cus_abc123', paymentMethodId: 'pm_1' });
    await createPaymentIntent({ amount: 1000, customerId: 'cus_abc123', paymentMethodId: 'pm_1' });
    const [first, second] = mockStripeInstance.paymentIntents.create.mock.calls;
    expect(keyOf(first)).toBe(keyOf(second));
    expect(keyOf(first)).toMatch(/^pi-create:[0-9a-f]{64}$/);
  });

  it('derives a DIFFERENT key when a customer is attached on retry', async () => {
    // Regression: a retry whose customer attachment changed (async customer
    // creation completing in between) must not reuse the earlier key — Stripe
    // rejects a key reused with different parameters.
    await createPaymentIntent({ amount: 1000, customerId: null, paymentMethodId: 'pm_1' });
    await createPaymentIntent({ amount: 1000, customerId: 'cus_abc123', paymentMethodId: 'pm_1' });
    const [first, second] = mockStripeInstance.paymentIntents.create.mock.calls;
    expect(keyOf(first)).not.toBe(keyOf(second));
  });

  it('derives a different key when the amount or payment method changes', async () => {
    await createPaymentIntent({ amount: 1000, paymentMethodId: 'pm_1' });
    await createPaymentIntent({ amount: 2000, paymentMethodId: 'pm_1' });
    await createPaymentIntent({ amount: 1000, paymentMethodId: 'pm_2' });
    const keys = mockStripeInstance.paymentIntents.create.mock.calls.map(keyOf);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('createStripeCustomer', () => {
  beforeEach(() => {
    mockStripeInstance.customers.create.mockReset();
    prisma.user.update.mockReset();
  });

  it('creates the customer in Stripe and persists the id on the user', async () => {
    mockStripeInstance.customers.create.mockResolvedValue({ id: 'cus_new' });
    prisma.user.update.mockResolvedValue({});

    const id = await createStripeCustomer({ userId: 'u1', email: 'a@b.com', name: 'A B' });

    expect(id).toBe('cus_new');
    expect(mockStripeInstance.customers.create).toHaveBeenCalledWith(
      { email: 'a@b.com', name: 'A B', metadata: { userId: 'u1', source: 'local_auth' } },
      { idempotencyKey: 'create-customer:u1' }
    );
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { stripeCustomerId: 'cus_new' },
    });
  });

  it('propagates Stripe failures', async () => {
    mockStripeInstance.customers.create.mockRejectedValue(new Error('stripe down'));
    await expect(createStripeCustomer({ userId: 'u1', email: 'a@b.com' })).rejects.toThrow('stripe down');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('ensureStripeCustomer', () => {
  beforeEach(() => {
    redis.setnx.mockReset();
    redis.del.mockReset();
    redis.setnx.mockResolvedValue(null);
    redis.del.mockResolvedValue(undefined);
    mockStripeInstance.customers.create.mockReset();
    prisma.user.update.mockReset();
    prisma.user.findUnique.mockReset();
  });

  it('returns the existing valid customer id without creating one', async () => {
    const user = { id: 'u1', stripeCustomerId: 'cus_existing', email: 'a@b.com' };
    await expect(ensureStripeCustomer(user)).resolves.toBe('cus_existing');
    expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
    expect(redis.setnx).not.toHaveBeenCalled();
  });

  it('creates a customer lazily when missing (Redis unavailable)', async () => {
    redis.setnx.mockResolvedValue(null);
    mockStripeInstance.customers.create.mockResolvedValue({ id: 'cus_new' });
    prisma.user.update.mockResolvedValue({});

    const user = { id: 'u1', email: 'a@b.com', name: 'A B', stripeCustomerId: null };
    await expect(ensureStripeCustomer(user)).resolves.toBe('cus_new');
    expect(mockStripeInstance.customers.create).toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { stripeCustomerId: 'cus_new' },
    });
  });

  it('releases the lock after creating', async () => {
    redis.setnx.mockResolvedValue(true);
    mockStripeInstance.customers.create.mockResolvedValue({ id: 'cus_new' });
    prisma.user.update.mockResolvedValue({});

    const user = { id: 'u1', email: 'a@b.com', stripeCustomerId: null };
    await ensureStripeCustomer(user);
    expect(redis.del).toHaveBeenCalledWith('stripe:customer-lock:u1');
  });

  it('returns null when creation fails (graceful, no throw)', async () => {
    redis.setnx.mockResolvedValue(true);
    mockStripeInstance.customers.create.mockRejectedValue(new Error('stripe down'));
    prisma.user.update.mockResolvedValue({});

    const user = { id: 'u1', email: 'a@b.com', stripeCustomerId: null };
    await expect(ensureStripeCustomer(user)).resolves.toBeNull();
  });

  it('waits for a concurrent creator and returns the persisted id', async () => {
    redis.setnx.mockResolvedValue(false);
    prisma.user.findUnique.mockResolvedValue({ stripeCustomerId: 'cus_persisted' });

    const user = { id: 'u1', email: 'a@b.com', stripeCustomerId: null };
    await expect(ensureStripeCustomer(user)).resolves.toBe('cus_persisted');
    expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { stripeCustomerId: true },
    });
  });

  it('returns null for a missing user', async () => {
    await expect(ensureStripeCustomer(null)).resolves.toBeNull();
    await expect(ensureStripeCustomer({})).resolves.toBeNull();
  });
});
