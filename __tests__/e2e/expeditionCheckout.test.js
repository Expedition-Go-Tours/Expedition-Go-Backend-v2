const mockVerifyAccessToken = jest.fn();

jest.mock('../../config/jwt', () => ({
  verifyAccessToken: (...args) => mockVerifyAccessToken(...args),
}));

jest.mock('../../utils/prismaClient', () => ({
  expeditionTour: { findFirst: jest.fn(), findUnique: jest.fn() },
  tour: { findUnique: jest.fn(), findFirst: jest.fn() },
  user: { findUnique: jest.fn() },
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  notification: { create: jest.fn() },
  supplierProfile: { update: jest.fn() },
  stripeEvent: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  cartItem: { deleteMany: jest.fn(() => Promise.resolve({ count: 0 })) },
  payout: { create: jest.fn() },
  payoutMethod: { findFirst: jest.fn() },
  specialOffer: { update: jest.fn() },
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../utils/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn() }));
jest.mock('../../utils/cacheHelper', () => ({ getOrSet: jest.fn((_, fn) => fn()), invalidateKeys: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));

jest.mock('../../utils/bookingHelpers', () => ({
  generateBookingNumber: jest.fn(() => Promise.resolve('BK-EXP-E2E-001')),
  validateTravelerInfo: jest.fn(() => ({ isValid: true, errors: [] })),
}));

jest.mock('../../utils/getConfig', () => {
  const fn = jest.fn();
  fn.mockImplementation((key, defaultValue) => {
    const values = {
      'commission.default_rate': '0.15',
      'booking.min_advance_hours': '0',
      'booking.max_advance_days': '365',
    };
    return Promise.resolve(values[key] ?? defaultValue);
  });
  return fn;
});

jest.mock('../../utils/tourHelpers', () => ({
  checkTourAvailability: jest.fn(),
  calculateTourPrice: jest.fn(),
}));

jest.mock('../../utils/stripeHelpers', () => {
  const actual = jest.requireActual('../../utils/stripeHelpers');
  return {
    createPaymentIntent: jest.fn(),
    createCheckoutSession: jest.fn(),
    calculateCommission: jest.fn(),
    createRefund: jest.fn(),
    ensureStripeCustomer: jest.fn(async (user) => user?.stripeCustomerId || null),
    getStripe: jest.fn(),
    processStripeWebhook: actual.processStripeWebhook,
    verifyWebhookSignature: actual.verifyWebhookSignature,
  };
});

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_e2e_exp';
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
});

const request = require('supertest');
const app = require('../../app');
const prisma = require('../../utils/prismaClient');
const tourHelpers = require('../../utils/tourHelpers');
const bookingHelpers = require('../../utils/bookingHelpers');
const { createPaymentIntent, createCheckoutSession, calculateCommission, processStripeWebhook } = require('../../utils/stripeHelpers');


const mockUser = {
  id: 'exp-e2e-user-1',
  name: 'Expedition User',
  email: 'exp@test.com',
  photoURL: '',
  roles: ['customer'],
  active: true,
  stripeCustomerId: 'cus_exp_e2e',
  wishlist: [],
};

const mockTour = {
  id: 'tour-exp-e2e',
  title: 'Expedition E2E Safari',
  slug: 'expedition-e2e-safari',
  status: 'ACTIVE',
  supplierId: 'supplier-exp-e2e',
  category: 'Adventure',
  city: 'Nairobi',
  country: 'Kenya',
  durationMinutes: 300,
  averageRating: 4.5,
  reviewCount: 20,
  coverPhoto: null,
  photos: [],
  schedulesAndPricing: {
    travelerDetails: { pricingModel: 'perPerson', maxTravelersPerBooking: 15, ageGroups: [
      { label: 'Adult', minAge: 13, maxAge: 99 },
      { label: 'Child', minAge: 6, maxAge: 12 },
      { label: 'Infant', minAge: 0, maxAge: 5 },
    ]},
    pricingSchedules: {
      currency: 'USD',
      schedules: [{
        startDate: '2026-01-01', endDate: '2027-12-31',
        prices: [
          { ageGroup: 'Adult', retailPrice: 200 },
          { ageGroup: 'Child', retailPrice: 100 },
          { ageGroup: 'Infant', retailPrice: 0 },
        ],
      }],
    },
  },
  supplier: {
    id: 'supplier-exp-e2e',
    name: 'Safari Experts',
    email: 'safari@test.com',
    photoURL: null,
    supplierProfile: { status: 'ACTIVE', totalBookings: 50, averageRating: 4.5 },
  },
};

const mockExpeditionTour = {
  id: 'et-exp-e2e',
  tourId: 'tour-exp-e2e',
  displayOrder: 1,
  isFeatured: true,
  isActive: true,
  tour: mockTour,
};

const expectedBooking = {
  id: 'booking-exp-e2e-1',
  bookingNumber: 'BK-EXP-E2E-001',
  customerId: 'exp-e2e-user-1',
  tourId: 'tour-exp-e2e',
  source: 'EXPEDITION',
  status: 'CONFIRMED',
  stripePaymentIntentId: 'pi_exp_e2e',
  paymentStatus: 'SUCCEEDED',
  supplierPayout: 446.25,
  platformCommission: 78.75,
  grossAmount: 525,
  currency: 'USD',
  tour: {
    title: 'Expedition E2E Safari',
    supplierId: 'supplier-exp-e2e',
    supplier: { id: 'supplier-exp-e2e', name: 'Safari Experts', email: 'safari@test.com' },
  },
  customer: { id: 'exp-e2e-user-1', name: 'Expedition User', email: 'exp@test.com' },
};

const mockTx = {
  $queryRawUnsafe: jest.fn().mockImplementation((query) => {
    if (query.includes('SELECT id FROM')) return [{ id: 'tour-exp-e2e' }];
    return [{ currentBookings: '0' }];
  }),
  tourDateOverride: { findFirst: jest.fn().mockResolvedValue(null) },
  booking: {
    create: jest.fn().mockResolvedValue(expectedBooking),
  },
  tour: { update: jest.fn().mockResolvedValue({}) },
  cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
};

describe('E2E: Expedition Checkout Flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockVerifyAccessToken.mockReturnValue({ userId: 'exp-e2e-user-1' });

    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.expeditionTour.findFirst.mockResolvedValue(mockExpeditionTour);
    prisma.expeditionTour.findUnique.mockResolvedValue({ isActive: true });
    prisma.tour.findFirst.mockResolvedValue(mockTour);
    prisma.tour.findUnique.mockResolvedValue(mockTour);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.count.mockResolvedValue(0);
    prisma.$queryRawUnsafe.mockResolvedValue([{ currentBookings: '0' }]);
    prisma.$transaction.mockImplementation((cb) => cb(mockTx));

    tourHelpers.checkTourAvailability.mockResolvedValue({ available: true, availableSpots: 10 });
    tourHelpers.calculateTourPrice.mockResolvedValue({
      success: true, currency: 'USD',
      subtotal: 500, fees: 25, discount: 0, total: 525,
    });
    bookingHelpers.generateBookingNumber.mockResolvedValue('BK-EXP-E2E-001');
    createPaymentIntent.mockResolvedValue({ id: 'pi_exp_e2e', client_secret: 'secret_exp_e2e' });
    createCheckoutSession.mockResolvedValue({ id: 'cs_exp_e2e', url: 'https://checkout.stripe.com/c/pay/cs_exp_e2e' });
    calculateCommission.mockResolvedValue({ rate: 0.15, amount: 78.75, supplierPayout: 446.25 });
  });

  // ── Step 1: calculateCheckout (public, no auth) ────────────────────
  it('Step 1: calculates checkout pricing for valid tour', async () => {
    const res = await request(app)
      .post('/api/expedition/checkout/calculate')
      .send({ tourId: 'tour-exp-e2e', travelDate: '2027-06-15', travelers: { adults: 2, children: 1 } });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.pricing.total).toBe(525);
    expect(res.body.data.pricing.currency).toBe('USD');
    expect(tourHelpers.calculateTourPrice).toHaveBeenCalled();
  });

  // ── Step 2: confirmBooking (auth required) ─────────────────────────
  it('Step 2: confirms booking and redirects to hosted Checkout', async () => {
    const res = await request(app)
      .post('/api/expedition/checkout/confirm')
      .set('Authorization', 'Bearer valid-exp-token')
      .send({
        tourId: 'tour-exp-e2e',
        travelDate: '2027-06-15',
        travelers: { adults: 2, children: 1, infants: 0, phoneNumber: '+254700123456', location: 'Nairobi, Kenya' },
        paymentTiming: 'now',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data.booking).toBeDefined();
    expect(res.body.data.booking.id).toBe('booking-exp-e2e-1');
    expect(res.body.data.checkout).toBeDefined();
    expect(res.body.data.checkout.url).toBe('https://checkout.stripe.com/c/pay/cs_exp_e2e');

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 52500,
        bookingId: 'booking-exp-e2e-1',
      }),
    );
    expect(createPaymentIntent).not.toHaveBeenCalled();

    expect(mockVerifyAccessToken).toHaveBeenCalledWith('valid-exp-token');
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(mockTx.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: 'EXPEDITION' }) }),
    );
  });

  // ── Step 2b: reserve-now-pay-later captures the card (uncharged) ───
  it('reserve-now-pay-later still captures a PaymentIntent for auto-charge', async () => {
    const res = await request(app)
      .post('/api/expedition/checkout/confirm')
      .set('Authorization', 'Bearer valid-exp-token')
      .send({
        tourId: 'tour-exp-e2e',
        travelDate: '2027-06-15',
        travelers: { adults: 2, children: 1, infants: 0, phoneNumber: '+254700123456', location: 'Nairobi, Kenya' },
        paymentTiming: 'later',
        paymentMethodId: 'pm_exp_e2e',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data.checkout).toBeNull();
    expect(res.body.data.message).toContain('reserved');

    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 52500,
        paymentMethodId: 'pm_exp_e2e',
        confirm: false,
        metadata: expect.objectContaining({ source: 'expedition', paymentTiming: 'later' }),
      }),
    );
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  // ── Step 3: Stripe webhook falls back to PI ID lookup when no bookingIds ──
  it('Step 3: Stripe webhook falls back to PI ID lookup when no bookingIds', async () => {
    prisma.stripeEvent.findUnique.mockResolvedValue(null);
    prisma.stripeEvent.upsert.mockResolvedValue({});
    prisma.stripeEvent.update.mockResolvedValue({});

    const webhookTx = {
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), findMany: jest.fn().mockResolvedValue([]) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      stripeEvent: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
      payout: { create: jest.fn().mockResolvedValue({}) },
      payoutMethod: { findFirst: jest.fn().mockResolvedValue(null) },
      supplierProfile: { update: jest.fn().mockResolvedValue({}) },
      tour: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((cb) => cb(webhookTx));

    const stripeEvent = {
      id: 'evt_exp_e2e_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_exp_e2e',
          metadata: { source: 'expedition' },
        },
      },
    };

    const result = await processStripeWebhook(stripeEvent);
    expect(result.success).toBe(true);

    // Falls back to updating by stripePaymentIntentId. The fallback matches both
    // PENDING and PROCESSING: TRAVIO checkouts create bookings with
    // paymentStatus PROCESSING, Expedition uses PENDING — either is confirmable.
    // Reserve-now-pay-later bookings (PENDING + paymentTiming 'later') are
    // matched via the OR clause too.
    expect(webhookTx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stripePaymentIntentId: 'pi_exp_e2e',
          paymentStatus: { in: ['PENDING', 'PROCESSING'] },
        }),
      }),
    );
    expect(webhookTx.booking.findMany).not.toHaveBeenCalled();
  });

  // ── Step 4: Full journey (calculate → confirm → webhook) ──────────
  it('completes the full expedition checkout journey', async () => {
    prisma.tour.findFirst.mockResolvedValueOnce(mockTour).mockResolvedValueOnce(mockTour);

    const calcRes = await request(app)
      .post('/api/expedition/checkout/calculate')
      .send({ tourId: 'tour-exp-e2e', travelDate: '2027-06-15', travelers: { adults: 2 } });
    expect(calcRes.status).toBe(200);
    expect(calcRes.body.data.pricing.subtotal).toBe(500);

    prisma.tour.findFirst.mockResolvedValue(mockTour);
    prisma.$transaction.mockImplementation((cb) => cb(mockTx));
    createCheckoutSession.mockResolvedValue({ id: 'cs_exp_e2e_full', url: 'https://checkout.stripe.com/c/pay/cs_exp_e2e_full' });

    const confirmRes = await request(app)
      .post('/api/expedition/checkout/confirm')
      .set('Authorization', 'Bearer full-exp-token')
      .send({
        tourId: 'tour-exp-e2e',
        travelDate: '2027-06-15',
        travelers: { adults: 2, phoneNumber: '+254700123456', location: 'Nairobi, Kenya' },
        paymentTiming: 'now',
      });
    expect(confirmRes.status).toBe(201);
    expect(confirmRes.body.data.booking.id).toBe('booking-exp-e2e-1');
    expect(confirmRes.body.data.checkout.url).toContain('checkout.stripe.com');

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 52500 }),
    );

    expect(mockVerifyAccessToken).toHaveBeenCalledWith('full-exp-token');
  });
});

describe('E2E: Stripe Webhook Idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_e2e_wh';
  });

  it('processes same event only once — second call skips', async () => {
    const processedEvent = {
      id: 'evt_idemp_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_idemp_1',
          metadata: { bookingIds: 'booking-idemp-1,booking-idemp-2' },
        },
      },
    };

    const mockBookingRecord = {
      id: 'booking-idemp-1',
      bookingNumber: 'BK-IDEMP-001',
      customerId: 'cust-idemp',
      tourId: 'tour-idemp',
      status: 'CONFIRMED',
      grossAmount: 500,
      currency: 'USD',
      stripePaymentIntentId: 'pi_idemp_1',
      paymentStatus: 'SUCCEEDED',
      paidAt: new Date(),
      supplierPayout: 425,
      platformCommission: 75,
      tour: {
        title: 'Idempotent Test Tour',
        supplierId: 'supplier-idemp',
        supplier: { id: 'supplier-idemp', name: 'Idempotent Supplier', email: 'sup@test.com' },
      },
      customer: { id: 'cust-idemp', name: 'Test User', email: 'test@test.com' },
    };

    const callCounts = { bookingUpdateMany: 0, bookingFindMany: 0 };

    const webhookTx = {
      booking: {
        updateMany: jest.fn().mockImplementation(() => { callCounts.bookingUpdateMany++; return { count: 2 }; }),
        findMany: jest.fn().mockImplementation(() => { callCounts.bookingFindMany++; return [mockBookingRecord]; }),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
      stripeEvent: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      payout: { create: jest.fn().mockResolvedValue({}) },
      payoutMethod: { findFirst: jest.fn().mockResolvedValue({ id: 'pm-idemp-1' }) },
      supplierProfile: { update: jest.fn().mockResolvedValue({}) },
      tour: { update: jest.fn().mockResolvedValue({}) },
      specialOffer: { update: jest.fn().mockResolvedValue({}) },
    };

    webhookTx.stripeEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ processed: true });

    prisma.$transaction.mockImplementation((cb) => cb(webhookTx));

    const first = await processStripeWebhook(processedEvent);
    expect(first.success).toBe(true);
    expect(webhookTx.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(webhookTx.booking.findMany).toHaveBeenCalledTimes(1);

    const second = await processStripeWebhook(processedEvent);
    expect(second.success).toBe(true);
    expect(webhookTx.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(webhookTx.booking.findMany).toHaveBeenCalledTimes(1);
  });

  it('handles concurrent duplicate webhook events gracefully', async () => {
    const event = {
      id: 'evt_concurrent_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_concurrent_1',
          metadata: { bookingIds: 'booking-cc-1' },
        },
      },
    };

    let callCount = 0;

    const mockBookingRecord = {
      id: 'booking-cc-1',
      bookingNumber: 'BK-CC-001',
      customerId: 'cust-cc',
      tourId: 'tour-cc',
      status: 'CONFIRMED',
      grossAmount: 300,
      currency: 'USD',
      stripePaymentIntentId: 'pi_concurrent_1',
      paymentStatus: 'SUCCEEDED',
      paidAt: new Date(),
      supplierPayout: 255,
      platformCommission: 45,
      tour: {
        title: 'Concurrent Test Tour',
        supplierId: 'supplier-cc',
        supplier: { id: 'supplier-cc', name: 'CC Supplier', email: 'cc@test.com' },
      },
      customer: { id: 'cust-cc', name: 'CC User', email: 'cc@test.com' },
    };

    const webhookTx = {
      booking: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([mockBookingRecord]),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
      stripeEvent: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      payout: { create: jest.fn().mockResolvedValue({}) },
      payoutMethod: { findFirst: jest.fn().mockResolvedValue(null) },
      supplierProfile: { update: jest.fn().mockResolvedValue({}) },
      tour: { update: jest.fn().mockResolvedValue({}) },
    };

    prisma.stripeEvent.findUnique.mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount > 1 ? { processed: false } : null);
    });
    prisma.$transaction.mockImplementation((cb) => cb(webhookTx));

    const result = await processStripeWebhook(event);
    expect(result.success).toBe(true);

    expect(webhookTx.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(webhookTx.stripeEvent.upsert).toHaveBeenCalledTimes(1);
    expect(webhookTx.stripeEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripeEventId: 'evt_concurrent_1' }, data: { processed: true } }),
    );
  });
});
