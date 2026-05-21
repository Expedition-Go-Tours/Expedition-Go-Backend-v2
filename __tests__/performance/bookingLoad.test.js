jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), delete: jest.fn() },
  cartItem: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), upsert: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  tour: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  review: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
  notification: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(), count: jest.fn() },
  supplierProfile: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
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

jest.mock('../../utils/stripeHelpers', () => ({
  createPaymentIntent: jest.fn(),
  calculateCommission: jest.fn(),
}));

jest.mock('../../utils/bookingHelpers', () => ({
  generateBookingNumber: jest.fn(() => 'BK-LOAD-001'),
  validateTravelerInfo: jest.fn(() => ({ isValid: true, errors: [] })),
}));

jest.mock('../../utils/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/emailService', () => ({
  generatePrintableTicketHtml: jest.fn(() => '<html>ticket</html>'),
}));

const prisma = require('../../utils/prismaClient');
const { createPaymentIntent, calculateCommission } = require('../../utils/stripeHelpers');
const { LoadTest, runLoadTestScenarios } = require('./loadTest');

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
  id: 'booking-load-1',
  bookingNumber: 'BK-LOAD-001',
  customerId: 'customer-1',
  tourId: 'tour-1',
  status: 'PENDING',
  total: 385,
  currency: 'USD',
  commissionRate: 0.15,
  commissionAmount: 57.75,
  supplierPayout: 327.25,
  stripePaymentIntentId: 'pi_load_123',
  paymentStatus: 'PROCESSING',
  tour: { title: 'Grand Canyon Tour', supplier: { id: 'supplier-1', name: 'Canyon Explorers' } },
  customer: { id: 'customer-1', name: 'John Doe', email: 'john@test.com' },
};

const mockTx = {
  booking: { create: jest.fn().mockResolvedValue(mockBooking), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  notification: { create: jest.fn().mockResolvedValue({}) },
  supplierProfile: { update: jest.fn().mockResolvedValue({}) },
  tour: { update: jest.fn().mockResolvedValue({}) },
  cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
};

let counter = 0;

function setupMocks() {
  counter++;
  const uid = `customer-${counter}`;
  jest.clearAllMocks();
  prisma.$transaction.mockImplementation((cb) => cb(mockTx));
  calculateCommission.mockReturnValue({ rate: 0.15, amount: 57.75, supplierPayout: 327.25 });
  createPaymentIntent.mockResolvedValue({ id: `pi_${counter}`, client_secret: `secret_${counter}` });
  prisma.tour.findFirst.mockResolvedValue(tourTemplate);
  return uid;
}

function mockReq(uid) {
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
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('Booking Load Tests', () => {
  const scenarios = [
    { concurrency: 10, targetRps: 100, durationMs: 500 },
    { concurrency: 50, targetRps: 500, durationMs: 500 },
    { concurrency: 100, targetRps: 1000, durationMs: 1000 },
  ];

  it('addToCart throughput at increasing concurrency', async () => {
    const results = await runLoadTestScenarios('addToCart Load', () => {
      const uid = setupMocks();
      const req = mockReq(uid);
      const res = mockRes();
      const next = jest.fn();
      return bookingController.addToCart(req, res, next);
    }, scenarios);

    const best = results[results.length - 1];
    expect(best.throughput).toBeGreaterThan(0);
    expect(best.errorRate).toBe('0.00%');
  }, 30000);

  it('createBooking throughput at increasing concurrency', async () => {
    const results = await runLoadTestScenarios('createBooking Load', () => {
      const uid = setupMocks();
      const req = mockReq(uid);
      const res = mockRes();
      const next = jest.fn();
      return bookingController.createBooking(req, res, next);
    }, scenarios);

    const best = results[results.length - 1];
    expect(best.throughput).toBeGreaterThan(0);
    expect(best.errorRate).toBe('0.00%');
  }, 30000);

  it('mixed cart+booking flow at 100 concurrency', async () => {
    let opIdx = 0;
    const operations = [
      () => bookingController.addToCart(mockReq(setupMocks()), mockRes(), jest.fn()),
      () => bookingController.createBooking(mockReq(setupMocks()), mockRes(), jest.fn()),
      () => bookingController.getCart(mockReq(setupMocks()), mockRes()),
      () => bookingController.getMyBookings(mockReq(setupMocks()), mockRes()),
    ];

    const test = new LoadTest({ name: 'Mixed Flow (c=100)', concurrency: 100, targetRps: 1000, durationMs: 1000 });
    await test.run(() => {
      const op = operations[opIdx++ % operations.length];
      return op();
    });

    const m = test.report();
    expect(m.throughput).toBeGreaterThan(0);
  }, 30000);
});
