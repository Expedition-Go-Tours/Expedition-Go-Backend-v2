jest.mock('../../utils/prismaClient', () => ({
  travioGhanaTour: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  tour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  user: { findUnique: jest.fn(), update: jest.fn() },
  wishlistItem: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
  booking: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
  tourDateOverride: { findFirst: jest.fn() },
  review: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  newsletterSubscriber: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  cartItem: { deleteMany: jest.fn() },
  supplierProfile: { findFirst: jest.fn() },
  payout: { create: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  payoutRequestItem: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  payoutRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({}) },
  checkoutDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));
jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn(), emitBatch: jest.fn() }));
jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/bookingHelpers', () => ({
  validateTravelerInfo: jest.fn(),
  generateBookingNumber: jest.fn(),
  evaluateCancellationPolicy: jest.fn(() => ({ allowed: true, refundAmount: 105, refundPercentage: 100, reason: 'Full refund available', windowHours: 24 })),
  evaluateModifyPolicy: jest.fn(() => ({ allowed: true, reason: null, cutoffHours: 24, deadline: null })),
  isValidEmail: jest.fn(() => true),
}));
jest.mock('../../utils/tourHelpers', () => ({
  checkTourAvailability: jest.fn(),
  calculateTourPrice: jest.fn(),
  cheapestRetailPrice: jest.fn(() => 50),
}));
jest.mock('../../utils/stripeHelpers', () => ({
  createPaymentIntent: jest.fn(),
  createCheckoutSession: jest.fn(),
  createCustomCheckoutPaymentIntent: jest.fn(),
  createCustomerSession: jest.fn(),
  calculateCommission: jest.fn(),
  createRefund: jest.fn(),
  ensureStripeCustomer: jest.fn(async (user) => user?.stripeCustomerId || null),
  getStripe: jest.fn(() => ({ paymentIntents: { confirm: jest.fn(), retrieve: jest.fn(), update: jest.fn(() => Promise.resolve({})) }, checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } }, refunds: { create: jest.fn() } })),
}));
jest.mock('../../utils/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/checkoutHold', () => ({ acquireHold: jest.fn(), releaseHold: jest.fn(), HOLD_MINUTES: 30 }));
jest.mock('../../utils/availabilityCalendar', () => ({ buildAvailabilityCalendar: jest.fn(() => Promise.resolve([])) }));

const prisma = require('../../utils/prismaClient');
const controller = require('../../src/brands/ghana/controller');

const mockTour = {
  id: 'tour-1',
  title: 'Test Tour',
  slug: 'test-tour',
  description: 'A fantastic test tour',
  coverPhoto: 'https://res.cloudinary.com/test/tour.jpg',
  photos: ['https://res.cloudinary.com/test/tour1.jpg'],
  category: 'Adventure',
  durationMinutes: 120,
  averageRating: 4.5,
  reviewCount: 10,
  city: 'Accra',
  country: 'Ghana',
  schedulesAndPricing: { pricingSchedules: { currency: 'USD', schedules: [{ prices: [{ retailPrice: 50 }] }] } },
  supplier: { id: 'supplier-1', name: 'Test Supplier', photoURL: null },
  status: 'ACTIVE',
};

const mockGhanaTour = {
  id: 'gt-1',
  tourId: 'tour-1',
  displayOrder: 1,
  isFeatured: false,
  isActive: true,
  tour: mockTour,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('travioGhanaController (Phase 1b characterization)', () => {
  let req, res;

  beforeEach(() => {
    req = { query: {}, params: {}, body: {}, user: { id: 'user-1', roles: ['customer'] }, headers: {}, ip: '127.0.0.1' };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
    jest.clearAllMocks();
    prisma.travioGhanaTour.findMany.mockResolvedValue([mockGhanaTour]);
    prisma.travioGhanaTour.findUnique.mockResolvedValue(mockGhanaTour);
    prisma.travioGhanaTour.findFirst.mockResolvedValue(mockGhanaTour);
    prisma.travioGhanaTour.count.mockResolvedValue(1);
    prisma.tour.findMany.mockResolvedValue([mockTour]);
    prisma.tour.findFirst.mockResolvedValue(mockTour);
  });

  it('exports every function the Ghana storefront routes reference', () => {
    const need = ['calculateCheckout', 'cancelBooking', 'confirmBooking', 'getBooking', 'getBookingBySession', 'getFeaturedTours', 'getMyBookings', 'getSimilarTours', 'getSitemap', 'getSupplierBookings', 'getTourAvailability', 'getTourBadges', 'getTourBySlug', 'getTourReviews', 'getTours', 'getWishlist', 'submitContact', 'subscribe', 'toggleWishlist', 'trackClick', 'updateBookingStatus'];
    for (const name of need) expect(typeof controller[name]).toBe('function');
  });

  it('shared getFeaturedTours queries the Ghana listing model (travioGhanaTour)', async () => {
    await controller.getFeaturedTours(req, res);
    expect(prisma.travioGhanaTour.findMany).toHaveBeenCalled();
    expect(prisma.expeditionTour).toBeUndefined();
  });

  it('shared getSitemap queries the Ghana listing model (travioGhanaTour)', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([{ tour: { slug: 'test-tour' }, updatedAt: new Date() }]);
    await controller.getSitemap(req, res);
    expect(prisma.travioGhanaTour.findMany).toHaveBeenCalled();
  });
});
