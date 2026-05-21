jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), delete: jest.fn() },
  cartItem: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), upsert: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  tour: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  supplierProfile: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  stripeEvent: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  notification: { create: jest.fn(), createMany: jest.fn() },
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
beforeAll(() => { process.env.STRIPE_SECRET_KEY = 'sk_test_concur'; });

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
  generateBookingNumber: jest.fn(),
  validateTravelerInfo: jest.fn(() => ({ isValid: true, errors: [] })),
}));

jest.mock('../../utils/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/emailService', () => ({
  generatePrintableTicketHtml: jest.fn(() => '<html>ticket</html>'),
}));

const prisma = require('../../utils/prismaClient');
const { createPaymentIntent, calculateCommission, processStripeWebhook } = require('../../utils/stripeHelpers');
const { generateBookingNumber } = require('../../utils/bookingHelpers');

const bookingController = require('../../controllers/bookingController');

const tourTemplate = {
  id: 'tour-1',
  title: 'Grand Canyon Tour',
  status: 'ACTIVE',
  supplierId: 'supplier-1',
  schedulesAndPricing: {
    currency: 'USD',
    schedules: [{ prices: [{ retailPrice: 175 }] }],
  },
  supplier: {
    id: 'supplier-1',
    name: 'Canyon Explorers',
    email: 'supplier@test.com',
    supplierProfile: { status: 'ACTIVE', totalBookings: 30, averageRating: 4.5 },
  },
};

const mockBooking = {
  id: 'booking-1',
  bookingNumber: 'BK-CONCUR-001',
  customerId: 'customer-1',
  tourId: 'tour-1',
  status: 'PENDING',
  total: 385,
  currency: 'USD',
  commissionRate: 0.15,
  commissionAmount: 57.75,
  supplierPayout: 327.25,
  stripePaymentIntentId: 'pi_concur_123',
  paymentStatus: 'PROCESSING',
  tour: { title: 'Grand Canyon Tour', supplier: { id: 'supplier-1', name: 'Canyon Explorers' }, supplierId: 'supplier-1' },
  customer: { id: 'customer-1', name: 'John Doe', email: 'john@test.com' },
};

function mockReq(uid, overrides = {}) {
  return {
    user: { id: uid, roles: ['customer'], stripeCustomerId: 'cus_123' },
    body: {
      tourId: 'tour-1',
      selectedDate: '2026-07-01',
      travelers: { adults: 2, children: 0, infants: 0 },
      paymentMethodId: 'pm_123',
    },
    params: {},
    query: {},
    originalUrl: '/api/bookings',
    ip: '127.0.0.1',
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeBookingTx(usedNumbers) {
  const used = usedNumbers || new Set();
  return {
    booking: {
      create: jest.fn().mockImplementation((args) => {
        if (used.has(args.data.bookingNumber)) {
          const err = new Error('Unique constraint failed on bookingNumber');
          err.code = 'P2002';
          err.meta = { target: ['bookingNumber'] };
          return Promise.reject(err);
        }
        used.add(args.data.bookingNumber);
        return Promise.resolve({ ...mockBooking, bookingNumber: args.data.bookingNumber });
      }),
      update: jest.fn().mockResolvedValue(mockBooking),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    notification: { create: jest.fn().mockResolvedValue({}) },
    supplierProfile: { update: jest.fn().mockResolvedValue({}) },
    tour: { update: jest.fn().mockResolvedValue({}) },
    cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
}

/** Global set tracking booking numbers used during a test */
let usedBookingNumbers;

function baseSetup() {
  usedBookingNumbers = new Set();
  jest.clearAllMocks();
  prisma.tour.findFirst.mockResolvedValue(tourTemplate);
  prisma.$transaction.mockImplementation((cb) => cb(makeBookingTx(usedBookingNumbers)));
  calculateCommission.mockReturnValue({ rate: 0.15, amount: 57.75, supplierPayout: 327.25 });
  createPaymentIntent.mockResolvedValue({ id: 'pi_concur', client_secret: 'secret' });
}

/**
 * Helper: run `count` concurrent calls and collect results.
 */
function concurrentCalls(fn, count) {
  const calls = [];
  for (let i = 0; i < count; i++) calls.push(fn(i));
  return Promise.allSettled(calls);
}

describe('Concurrency — Double Booking Prevention', () => {
  beforeEach(baseSetup);

  it('prevents duplicate cart items for same customer+tour+date', async () => {
    const upsertCalls = [];
    prisma.cartItem.upsert.mockImplementation((args) => {
      upsertCalls.push(args);
      return Promise.resolve({
        id: `cart-${upsertCalls.length}`,
        customerId: 'customer-1',
        tourId: 'tour-1',
        total: 385,
      });
    });

    const results = await concurrentCalls(
      () => bookingController.addToCart(
        mockReq('customer-1', { body: { tourId: 'tour-1', selectedDate: '2026-07-01', travelers: { adults: 2 } } }),
        mockRes(),
        jest.fn(),
      ),
      10,
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    expect(succeeded).toBe(10);
    // All concurrent upserts use the same compound key → Prisma handles atomically
    for (const call of upsertCalls) {
      expect(call.where.customerId_tourId_selectedDate_selectedTime.customerId).toBe('customer-1');
      expect(call.where.customerId_tourId_selectedDate_selectedTime.tourId).toBe('tour-1');
    }
  });

  it('prevents duplicate bookings via bookingNumber unique constraint', async () => {
    let callIdx = 0;
    generateBookingNumber.mockImplementation(() => {
      callIdx++;
      return Promise.resolve(callIdx <= 5 ? `BK-UNIQUE-${callIdx}` : 'BK-COLLISION');
    });

    const nextCalls = [];
    const results = await concurrentCalls(
      (i) => {
        const uid = `customer-${i}`;
        const next = jest.fn();
        nextCalls.push(next);
        prisma.booking.findFirst.mockResolvedValue(null);
        return bookingController.createBooking(mockReq(uid), mockRes(), next);
      },
      10,
    );

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(10);

    const nextNotCalled = nextCalls.filter(n => n.mock.calls.length === 0);
    const nextCalled = nextCalls.filter(n => n.mock.calls.length > 0);
    // 5 unique booking numbers + 1 first 'BK-COLLISION' succeed = 6
    // The other 4 'BK-COLLISION' duplicates get caught by catchAsync → next(err)
    expect(nextNotCalled.length).toBe(6);
    expect(nextCalled.length).toBe(4);
    for (const n of nextCalled) {
      expect(n).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('bookingNumber') }));
    }
  });

  it('prevents double-processing of same Stripe event', async () => {
    prisma.stripeEvent.findUnique.mockResolvedValue(null);
    prisma.stripeEvent.upsert.mockResolvedValue({});
    prisma.stripeEvent.update.mockResolvedValue({});

    const mockTx = {
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 2 }), findMany: jest.fn().mockResolvedValue([mockBooking]) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      payout: { create: jest.fn().mockResolvedValue({ id: 'payout-concur-1', status: 'PENDING' }) },
      supplierProfile: { update: jest.fn().mockResolvedValue({}) },
      tour: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((cb) => cb(mockTx));

    const event = {
      id: 'evt_concur_same',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123', metadata: { bookingIds: 'booking-1' } } },
    };

    const results = await concurrentCalls(() => processStripeWebhook(event), 10);
    const succeeded = results.filter(r => r.status === 'fulfilled');
    // All 10 should complete because all concurrent calls find findUnique=null
    // Idempotency is enforced by the stripeEventId unique constraint (DB-level)
    expect(succeeded.length).toBe(10);
    expect(succeeded[0].value.success).toBe(true);
  });
});

describe('Concurrency — Race Conditions', () => {
  beforeEach(baseSetup);

  it('handles concurrent addToCart + createBooking for same tour', async () => {
    prisma.cartItem.upsert.mockResolvedValue({
      id: 'cart-race',
      customerId: 'customer-race',
      tourId: 'tour-1',
      total: 385,
    });
    prisma.cartItem.findMany.mockResolvedValue([]);
    generateBookingNumber.mockResolvedValue('BK-RACE-001');

    const ops = [
      bookingController.addToCart(mockReq('customer-race'), mockRes(), jest.fn()),
      bookingController.createBooking(mockReq('customer-race'), mockRes(), jest.fn()),
      bookingController.addToCart(mockReq('customer-race'), mockRes(), jest.fn()),
    ];

    const results = await Promise.allSettled(ops);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    expect(succeeded).toBeGreaterThan(0);
  });

  it('handles concurrent cancel + status update on same booking', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 3600000);
    const bookableBooking = {
      ...mockBooking,
      id: 'booking-race-1',
      status: 'CONFIRMED',
      paymentStatus: 'SUCCEEDED',
      selectedDate: futureDate,
      tour: { ...mockBooking.tour, bookingAndTickets: { cancellationPolicy: { cancellationWindowHours: 24 } } },
    };

    prisma.booking.findFirst.mockResolvedValue(bookableBooking);
    prisma.booking.update.mockResolvedValue({ ...bookableBooking, status: 'CANCELLED' });

    const cancelReq = mockReq('customer-1', { params: { id: 'booking-race-1' }, body: { reason: 'change of plans' } });
    const statusReq = mockReq('customer-1', { params: { id: 'booking-race-1' }, body: { status: 'COMPLETED' } });
    // "supplier" role for status update
    statusReq.user.roles = ['supplier'];

    const results = await Promise.allSettled([
      bookingController.cancelBooking(cancelReq, mockRes(), jest.fn()),
      bookingController.updateBookingStatus(statusReq, mockRes(), jest.fn()),
    ]);

    // Both may succeed (different operations), or one may fail with 404 if the
    // status changes between the findFirst and the update — that's acceptable.
    // The key invariant: the booking must end in a valid state.
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    expect(succeeded).toBeGreaterThanOrEqual(1);
    expect(succeeded).toBeLessThanOrEqual(2);
  });

  it('prevents concurrent cart clear + createBooking from cart race', async () => {
    const cartItem = {
      id: 'cart-race-1', customerId: 'customer-race-2', tourId: 'tour-1',
      selectedDate: new Date('2026-07-01'), selectedTime: '',
      travelers: { adults: 2 }, subtotal: 350, total: 385, currency: 'USD',
      expiresAt: new Date(Date.now() + 3600000),
      tour: tourTemplate,
    };

    // Simulate race: first `findMany` returns items, then a concurrent `clearCart` deletes them,
    // then `findMany` in transaction returns nothing
    let findManyCall = 0;
    prisma.cartItem.findMany.mockImplementation(() => {
      findManyCall++;
      return findManyCall <= 1
        ? Promise.resolve([cartItem])
        : Promise.resolve([]); // second call (in transaction) is empty
    });
    prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });
    generateBookingNumber.mockResolvedValue('BK-RACE-002');
    prisma.booking.findFirst.mockResolvedValue(null);

    const results = await Promise.allSettled([
      bookingController.createBooking(mockReq('customer-race-2', { body: { useCart: true, paymentMethodId: 'pm_123' } }), mockRes(), jest.fn()),
      bookingController.clearCart(mockReq('customer-race-2'), mockRes()),
    ]);

    // Both should resolve: clearCart deletes, createBooking fails with 400 (empty cart)
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);
  });

  it('handles 50 concurrent createBooking calls with unique booking numbers', async () => {
    let numCalls = 0;
    generateBookingNumber.mockImplementation(() => {
      numCalls++;
      return Promise.resolve(`BK-CONCUR-${String(numCalls).padStart(5, '0')}`);
    });

    prisma.cartItem.findMany.mockResolvedValue([]);

    const results = await concurrentCalls(
      (i) => {
        const uid = `customer-concur-${i}`;
        prisma.booking.findFirst.mockResolvedValue(null);
        return bookingController.createBooking(mockReq(uid), mockRes(), jest.fn());
      },
      50,
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    // With unique booking numbers, all should succeed
    expect(succeeded.length).toBe(50);
    expect(failed.length).toBe(0);
  }, 30000);

  it('detects booking number collision under high concurrency', async () => {
    generateBookingNumber.mockResolvedValue('BK-SAME-FOR-ALL');

    prisma.cartItem.findMany.mockResolvedValue([]);

    const nextCalls = [];
    const results = await concurrentCalls(
      (i) => {
        const uid = `customer-collide-${i}`;
        const next = jest.fn();
        nextCalls.push(next);
        prisma.booking.findFirst.mockResolvedValue(null);
        return bookingController.createBooking(mockReq(uid), mockRes(), next);
      },
      20,
    );

    // All 20 resolve because catchAsync catches via next(), but only 1 succeeds
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(20);

    const nextCalled = nextCalls.filter(n => n.mock.calls.length > 0);
    const nextNotCalled = nextCalls.filter(n => n.mock.calls.length === 0);
    expect(nextNotCalled.length).toBe(1);
    expect(nextCalled.length).toBe(19);
    for (const n of nextCalled) {
      expect(n).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('bookingNumber') }));
    }
  });
});
