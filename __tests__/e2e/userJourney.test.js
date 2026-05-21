const mockVerifyIdToken = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
  credential: { cert: jest.fn() },
  initializeApp: jest.fn(),
  apps: [],
}));

jest.mock('../../config/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
  apps: [],
}));

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), delete: jest.fn() },
  cartItem: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), upsert: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  tour: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  review: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
  notification: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(), count: jest.fn() },
  supplierProfile: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  stripeEvent: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  tourEvent: { create: jest.fn(), findMany: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn() },
  auditLog: { create: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
  $disconnect: jest.fn(),
}));

jest.mock('../../utils/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn() }));

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: jest.fn() },
    accounts: { create: jest.fn(), createLoginLink: jest.fn() },
    accountLinks: { create: jest.fn() },
    paymentIntents: { create: jest.fn() },
  }));
});

jest.mock('../../utils/stripeHelpers', () => {
  const actual = jest.requireActual('../../utils/stripeHelpers');
  return {
    createPaymentIntent: jest.fn(),
    calculateCommission: jest.fn(),
    processStripeWebhook: actual.processStripeWebhook,
    verifyWebhookSignature: actual.verifyWebhookSignature,
  };
});

jest.mock('../../utils/bookingHelpers', () => ({
  generateBookingNumber: jest.fn(() => Promise.resolve('BK-E2E-001')),
  validateTravelerInfo: jest.fn(() => ({ isValid: true, errors: [] })),
}));

jest.mock('../../utils/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/emailService', () => ({
  generatePrintableTicketHtml: jest.fn(() => '<html>e2e-ticket</html>'),
}));

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_e2e';
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
});

const request = require('supertest');
const app = require('../../app');
const prisma = require('../../utils/prismaClient');
const { createPaymentIntent, calculateCommission, processStripeWebhook } = require('../../utils/stripeHelpers');
const { enqueueEmail, enqueueNotification } = require('../../utils/queue');
const event = require('../../utils/eventEmitter');

const mockUser = {
  id: 'e2e-user-1',
  firebaseUid: 'firebase-uid-e2e',
  name: 'E2E Test User',
  email: 'e2e@test.com',
  photoURL: '',
  roles: ['customer'],
  active: true,
  stripeCustomerId: 'cus_e2e',
};

const mockTour = {
  id: 'tour-e2e-1',
  title: 'E2E Grand Canyon Tour',
  slug: 'e2e-grand-canyon-tour',
  status: 'ACTIVE',
  supplierId: 'supplier-e2e',
  description: 'An amazing e2e test tour',
  category: 'Adventure',
  subcategory: 'Hiking',
  duration: 180,
  difficulty: 'Moderate',
  location: 'New York, USA',
  country: 'United States',
  city: 'New York',
  price: 175,
  currency: 'USD',
  averageRating: 4.5,
  totalReviews: 42,
  totalBookings: 128,
  tags: ['nature', 'hiking'],
  photos: [],
  coverPhoto: null,
  supplier: {
    id: 'supplier-e2e',
    name: 'E2E Supplier',
    email: 'supplier@e2e.com',
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const expectedBooking = {
  id: 'booking-e2e-1',
  bookingNumber: 'BK-E2E-001',
  customerId: 'e2e-user-1',
  tourId: 'tour-e2e-1',
  status: 'PENDING',
  total: 385,
  currency: 'USD',
  commissionRate: 0.15,
  commissionAmount: 57.75,
  supplierPayout: 327.25,
  stripePaymentIntentId: 'pi_e2e_123',
  paymentStatus: 'PROCESSING',
  tour: { title: 'E2E Grand Canyon Tour', supplier: { id: 'supplier-e2e', name: 'E2E Supplier' } },
  customer: { id: 'e2e-user-1', name: 'E2E Test User', email: 'e2e@test.com' },
};

const activeTour = {
  id: 'tour-e2e-1',
  title: 'E2E Grand Canyon Tour',
  status: 'ACTIVE',
  supplierId: 'supplier-e2e',
  schedulesAndPricing: {
    currency: 'USD',
    schedules: [{ prices: [{ retailPrice: 175 }] }],
  },
  supplier: {
    id: 'supplier-e2e',
    name: 'E2E Supplier',
    email: 'supplier@e2e.com',
    supplierProfile: { status: 'ACTIVE', totalBookings: 30, averageRating: 4.5 },
  },
};

const mockTx = {
  booking: { create: jest.fn().mockResolvedValue(expectedBooking), update: jest.fn().mockResolvedValue(expectedBooking), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  notification: { create: jest.fn().mockResolvedValue({}) },
  supplierProfile: { update: jest.fn().mockResolvedValue({}) },
  tour: { update: jest.fn().mockResolvedValue({}) },
  cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
};

describe('E2E: Full User Journey', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Auth: valid Firebase token
    mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-e2e', name: 'E2E Test User', email: 'e2e@test.com' });

    // Prisma: user lookup
    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.user.findFirst.mockResolvedValue(mockUser);

    // Prisma: tour listing
    prisma.tour.findMany.mockResolvedValue([mockTour]);
    prisma.tour.count.mockResolvedValue(1);

    // Prisma: addToCart
    prisma.tour.findFirst.mockResolvedValue(activeTour);
    prisma.cartItem.upsert.mockResolvedValue({
      id: 'cart-e2e-1',
      customerId: 'e2e-user-1',
      tourId: 'tour-e2e-1',
      selectedDate: '2026-07-01',
      travelers: { adults: 2 },
      subtotal: 350,
      total: 385,
      currency: 'USD',
      expiresAt: new Date(Date.now() + 3600000),
      tour: { id: 'tour-e2e-1', title: 'E2E Grand Canyon Tour', photos: [], supplier: { name: 'E2E Supplier' } },
    });

    // Prisma: getCart
    prisma.cartItem.deleteMany.mockResolvedValue({ count: 0 });
    prisma.cartItem.findMany.mockResolvedValue([]);

    // Prisma: createBooking
    prisma.$transaction.mockImplementation((cb) => cb(mockTx));
    calculateCommission.mockReturnValue({ rate: 0.15, amount: 57.75, supplierPayout: 327.25 });
    createPaymentIntent.mockResolvedValue({ id: 'pi_e2e_123', client_secret: 'secret_e2e' });
  });

  // ── Step 1: Search tours ──────────────────────────────────────────
  it('Step 1: searches and finds tours', async () => {
    const res = await request(app)
      .get('/api/tours')
      .query({ limit: '5' })
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.data.tours).toHaveLength(1);
    expect(res.body.data.tours[0].title).toContain('Grand Canyon');
    expect(res.body.data.pagination).toBeDefined();
  });

  // ── Step 2: Add tour to cart ──────────────────────────────────────
  it('Step 2: adds tour to cart with valid auth', async () => {
    const res = await request(app)
      .post('/api/bookings/cart')
      .set('Authorization', 'Bearer valid-firebase-token')
      .send({
        tourId: 'tour-e2e-1',
        selectedDate: '2026-07-01',
        travelers: { adults: 2 },
      })
      .expect(201);

    expect(res.body.status).toBe('success');
    expect(res.body.data.cartItem).toBeDefined();
    expect(res.body.data.cartItem.tourId).toBe('tour-e2e-1');

    // Verify the auth middleware decoded the token
    expect(mockVerifyIdToken).toHaveBeenCalledWith('valid-firebase-token');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { firebaseUid: 'firebase-uid-e2e' } }),
    );
  });

  // ── Step 3: Get cart ──────────────────────────────────────────────
  it('Step 3: retrieves cart items', async () => {
    prisma.cartItem.findMany.mockResolvedValue([{
      id: 'cart-e2e-1',
      customerId: 'e2e-user-1',
      tourId: 'tour-e2e-1',
      total: 385,
      currency: 'USD',
      tour: { id: 'tour-e2e-1', title: 'E2E Grand Canyon Tour', photos: [], supplier: { name: 'E2E Supplier' } },
    }]);

    const res = await request(app)
      .get('/api/bookings/cart')
      .set('Authorization', 'Bearer valid-firebase-token')
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.data.cartItems).toHaveLength(1);
    expect(res.body.data.summary.itemCount).toBe(1);
    expect(res.body.data.summary.cartTotal).toBe(385);
  });

  // ── Step 4: Create booking (pay) ──────────────────────────────────
  it('Step 4: creates booking with payment intent', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', 'Bearer valid-firebase-token')
      .send({
        tourId: 'tour-e2e-1',
        selectedDate: '2026-07-01',
        travelers: { adults: 2 },
        paymentMethodId: 'pm_e2e_123',
      })
      .expect(201);

    expect(res.body.status).toBe('success');
    expect(res.body.data.bookings).toHaveLength(1);
    expect(res.body.data.bookings[0].id).toBe('booking-e2e-1');
    expect(res.body.data.paymentIntent.id).toBe('pi_e2e_123');

    // Verify Stripe payment intent was created
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 35000, // 350 * 100 cents (from calculateTourPricing)
        paymentMethodId: 'pm_e2e_123',
        metadata: expect.objectContaining({ customerId: 'e2e-user-1' }),
      }),
    );

    // Verify booking notification was queued
    expect(enqueueNotification).toHaveBeenCalled();
  });

  // ── Step 5: Stripe webhook confirms payment → email sent ─────────
  it('Step 5: processes Stripe webhook and sends confirmation email', async () => {
    prisma.stripeEvent.findUnique.mockResolvedValue(null);
    prisma.stripeEvent.upsert.mockResolvedValue({});
    prisma.stripeEvent.update.mockResolvedValue({});

    const webhookTx = {
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([{
        ...expectedBooking,
        status: 'CONFIRMED',
        paymentStatus: 'SUCCEEDED',
        paidAt: new Date(),
        tour: {
          id: 'tour-e2e-1',
          title: 'E2E Grand Canyon Tour',
          supplierId: 'supplier-e2e',
          supplier: { id: 'supplier-e2e', name: 'E2E Supplier', email: 'supplier@e2e.com' },
        },
        customer: { id: 'e2e-user-1', name: 'E2E Test User', email: 'e2e@test.com' },
      }]) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      payout: { create: jest.fn().mockResolvedValue({ id: 'payout-e2e-1', status: 'PENDING' }) },
      supplierProfile: { update: jest.fn().mockResolvedValue({}) },
      tour: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((cb) => cb(webhookTx));

    const stripeEvent = {
      id: 'evt_e2e_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_e2e_123',
          metadata: { bookingIds: 'booking-e2e-1', customerId: 'e2e-user-1' },
        },
      },
    };

    const result = await processStripeWebhook(stripeEvent);

    expect(result.success).toBe(true);

    // Verify confirmation emails were queued
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'booking-confirmation', bookingId: 'booking-e2e-1' }),
    );
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'supplier-booking-notification', bookingId: 'booking-e2e-1' }),
    );

    // Verify analytics event emitted
    expect(event.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'booking.completed' }),
    );
  });

  // ── Full journey: all steps in sequence ───────────────────────────
  it('completes the full journey: search → auth → cart → booking → webhook → email', async () => {
    // 1. Search
    prisma.tour.findMany.mockResolvedValue([mockTour]);
    prisma.tour.count.mockResolvedValue(1);
    const searchRes = await request(app).get('/api/tours').query({ limit: '5' });
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.data.tours).toHaveLength(1);

    // 2. Add to cart
    prisma.tour.findFirst.mockResolvedValue(activeTour);
    prisma.cartItem.upsert.mockResolvedValue({
      id: 'cart-e2e-1', customerId: 'e2e-user-1', tourId: 'tour-e2e-1',
      selectedDate: '2026-07-01', travelers: { adults: 2 },
      subtotal: 350, total: 385, currency: 'USD',
      expiresAt: new Date(Date.now() + 3600000),
      tour: { id: 'tour-e2e-1', title: 'E2E Grand Canyon Tour', photos: [], supplier: { name: 'E2E Supplier' } },
    });
    const cartRes = await request(app)
      .post('/api/bookings/cart')
      .set('Authorization', 'Bearer full-journey-token')
      .send({ tourId: 'tour-e2e-1', selectedDate: '2026-07-01', travelers: { adults: 2 } });
    expect(cartRes.status).toBe(201);
    expect(mockVerifyIdToken).toHaveBeenCalledWith('full-journey-token');

    // 3. Create booking
    prisma.$transaction.mockImplementation((cb) => cb(mockTx));
    createPaymentIntent.mockResolvedValue({ id: 'pi_e2e_full', client_secret: 'secret_full' });
    const bookingRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', 'Bearer full-journey-token')
      .send({ tourId: 'tour-e2e-1', selectedDate: '2026-07-01', travelers: { adults: 2 }, paymentMethodId: 'pm_full' });
    expect(bookingRes.status).toBe(201);
    expect(createPaymentIntent).toHaveBeenCalled();

    // 4. Process Stripe webhook
    prisma.stripeEvent.findUnique.mockResolvedValue(null);
    prisma.stripeEvent.upsert.mockResolvedValue({});
    prisma.stripeEvent.update.mockResolvedValue({});
    const webhookTx = {
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([{
        ...expectedBooking, stripePaymentIntentId: 'pi_e2e_full',
        tour: { ...expectedBooking.tour, supplierId: 'supplier-e2e', supplier: { id: 'supplier-e2e', name: 'E2E Supplier', email: 'supplier@e2e.com' } },
        customer: { id: 'e2e-user-1', name: 'E2E Test User', email: 'e2e@test.com' },
      }]) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      payout: { create: jest.fn().mockResolvedValue({ id: 'payout-e2e-1', status: 'PENDING' }) },
      supplierProfile: { update: jest.fn().mockResolvedValue({}) },
      tour: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((cb) => cb(webhookTx));
    const webhookResult = await processStripeWebhook({
      id: 'evt_e2e_full',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_e2e_full', metadata: { bookingIds: 'booking-e2e-1' } } },
    });
    expect(webhookResult.success).toBe(true);

    // 5. Verify email was queued
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'booking-confirmation' }),
    );
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'supplier-booking-notification' }),
    );

    // 6. Verify analytics
    expect(event.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'booking.completed' }),
    );
  });
});
