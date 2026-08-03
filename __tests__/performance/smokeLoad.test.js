jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  tour: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  review: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  supplierProfile: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  cartItem: { findMany: jest.fn(), count: jest.fn() },
  notification: { findMany: jest.fn(), count: jest.fn() },
  tourSecondaryTheme: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
  $disconnect: jest.fn(),
}));

jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateTourCaches: jest.fn(),
  invalidateKeys: jest.fn(),
  TOUR_DETAIL_PREFIX: (id) => `tours:detail:${id}`,
  TOUR_POPULAR_KEY: 'tours:popular:by-category',
  TOUR_LIST_PREFIX: 'tours:list:*',
  TOUR_FILTERS_KEY: 'tours:filters:options',
  REVIEWS_TOUR_PREFIX: (tourId) => `reviews:tour:${tourId}:*`,
}));

jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn() }));
jest.mock('../../utils/cloudinaryHelper', () => ({ deleteCloudinaryImage: jest.fn(), isValidCloudinaryUrl: jest.fn(() => true) }));
jest.mock('../../utils/tourHelpers', () => ({ createSlug: jest.fn(), validateTourData: jest.fn() }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`) }));
jest.mock('../../utils/tourFilterBuilder', () => ({ buildTourFilters: jest.fn(), buildSortOptions: jest.fn(), getAvailableFilterOptions: jest.fn(), validateFilterParams: jest.fn(), findNearbyTourIds: jest.fn(), getTourDistances: jest.fn() }));
jest.mock('../../utils/popularityScorer', () => ({ getPopularByCategory: jest.fn() }));
jest.mock('../../utils/fullTextSearch', () => ({ rankTourIdsBySearch: jest.fn() }));
jest.mock('../../utils/getConfig', () => jest.fn().mockResolvedValue('0.15'));
jest.mock('../../utils/specialOfferEngine', () => ({ findBestDiscount: jest.fn().mockResolvedValue({ discountAmount: 0, finalPrice: 100, appliedOffer: null }) }));

const prisma = require('../../utils/prismaClient');
const { validateFilterParams } = require('../../utils/tourFilterBuilder');
const { LoadTest, runLoadTestScenarios } = require('./loadTest');
const tourController = require('../../controllers/tourController');

const mockTour = {
  id: 'tour-1',
  title: 'Smoke Test Tour',
  slug: 'smoke-test-tour',
  photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/photo1.jpg'],
  coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/cover1.jpg',
  supplierId: 'supplier-1',
  supplier: {
    id: 'supplier-1',
    name: 'Test Supplier',
    photoURL: null,
    supplierProfile: { averageRating: 4.5, totalBookings: 10 },
  },
  _count: { reviews: 5, bookings: 20 },
};

function mockReq(overrides = {}) {
  return {
    user: { id: 'user-1', roles: ['customer'] },
    query: {},
    params: {},
    body: {},
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
}

describe('Smoke Load Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validateFilterParams.mockReturnValue({ isValid: true, errors: [] });
  });

  it('getAllTours — light load sanity check', async () => {
    prisma.tour.findMany.mockResolvedValue([mockTour]);
    prisma.tour.count.mockResolvedValue(1);

    const results = await runLoadTestScenarios('getAllTours Smoke', () => {
      const req = mockReq();
      const res = mockRes();
      return tourController.getAllTours(req, res, jest.fn());
    }, [
      { concurrency: 5, targetRps: 50, durationMs: 500 },
      { concurrency: 10, targetRps: 100, durationMs: 500 },
    ]);

    const best = results[results.length - 1];
    expect(best.throughput).toBeGreaterThan(0);
    expect(best.errors).toBe(0);
  }, 60000);

  it('getTour — single tour detail under light load', async () => {
    prisma.tour.findUnique.mockResolvedValue({
      ...mockTour,
      categorization: { category: 'Adventure' },
      theme: { primary: 'Nature' },
      productContent: { highlights: [] },
      schedulesAndPricing: { currency: 'USD' },
      bookingAndTickets: {},
      secondaryThemes: [],
    });

    const results = await runLoadTestScenarios('getTour Smoke', () => {
      const req = mockReq({ params: { slugOrId: 'smoke-test-tour' } });
      const res = mockRes();
      return tourController.getTour(req, res, jest.fn());
    }, [
      { concurrency: 5, targetRps: 50, durationMs: 500 },
      { concurrency: 10, targetRps: 100, durationMs: 500 },
    ]);

    const best = results[results.length - 1];
    expect(best.throughput).toBeGreaterThan(0);
    expect(best.errors).toBe(0);
  }, 60000);

  it('mixed read flow — tours + single tour at low concurrency', async () => {
    prisma.tour.findMany.mockResolvedValue([mockTour]);
    prisma.tour.count.mockResolvedValue(1);
    prisma.tour.findUnique.mockResolvedValue({
      ...mockTour,
      categorization: { category: 'Adventure' },
      theme: { primary: 'Nature' },
      productContent: { highlights: [] },
      schedulesAndPricing: { currency: 'USD' },
      bookingAndTickets: {},
      secondaryThemes: [],
    });

    let opIdx = 0;
    const operations = [
      () => tourController.getAllTours(mockReq(), mockRes(), jest.fn()),
      () => tourController.getTour(mockReq({ params: { slugOrId: 'smoke-test-tour' } }), mockRes(), jest.fn()),
    ];

    const test = new LoadTest({ name: 'Mixed Read Smoke (c=10)', concurrency: 10, targetRps: 100, durationMs: 1000 });
    await test.run(() => {
      const op = operations[opIdx++ % operations.length];
      return op();
    });

    const m = test.report();
    expect(m.throughput).toBeGreaterThan(0);
    expect(m.errors).toBe(0);
  }, 60000);
});
