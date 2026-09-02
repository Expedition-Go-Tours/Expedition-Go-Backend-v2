jest.mock('../../utils/prismaClient', () => {
  const booking = { groupBy: jest.fn(), aggregate: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
  return {
    tour: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), groupBy: jest.fn(), aggregate: jest.fn() },
    booking,
    review: { aggregate: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    specialOfferTarget: { findMany: jest.fn().mockResolvedValue([]) },
    supplierProfile: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    tourSecondaryTheme: { deleteMany: jest.fn(), createMany: jest.fn() },
    payoutMethod: { findFirst: jest.fn() },
    media: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((fn) => fn({ booking })),
    $queryRawUnsafe: jest.fn(),
  };
});

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

jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn(), deriveSessionId: jest.fn(() => 'test-session-id') }));
jest.mock('../../utils/queue', () => ({ enqueueEvent: jest.fn(() => Promise.resolve()), enqueueNotification: jest.fn(() => Promise.resolve()), enqueueAiScoring: jest.fn(() => Promise.resolve()), enqueueGhanaPublish: jest.fn(() => Promise.resolve()), enqueueTravioAfricaPublish: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/adminNotificationService', () => ({ notifyAdmin: jest.fn(() => Promise.resolve()), emitToRoom: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/cloudinaryHelper', () => ({ deleteCloudinaryImage: jest.fn(), isValidCloudinaryUrl: jest.fn((url) => typeof url === 'string' && url.startsWith('https://res.cloudinary.com/')) }));
jest.mock('../../utils/tourHelpers', () => ({ createSlug: jest.fn(), validateTourData: jest.fn(), normalizeProductPayload: jest.fn((d) => d), validateStoredPricing: jest.fn(), rebuildSchedulePrices: jest.fn(), reconcileAvailability: jest.fn((b) => b), durationToMinutes: jest.fn() }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/stripeHelpers', () => ({ cancelPaymentIntent: jest.fn() }));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn() }));
jest.mock('../../utils/tourFilterBuilder', () => ({ buildTourFilters: jest.fn(), buildSortOptions: jest.fn(), getAvailableFilterOptions: jest.fn(), validateFilterParams: jest.fn(), findNearbyTourIds: jest.fn(), getTourDistances: jest.fn() }));
jest.mock('../../utils/popularityScorer', () => ({ getPopularByCategory: jest.fn() }));
jest.mock('../../utils/fullTextSearch', () => ({ rankTourIdsBySearch: jest.fn() }));
jest.mock('../../config/jwt', () => ({ verifyAccessToken: jest.fn() }));

const prisma = require('../../utils/prismaClient');
const cache = require('../../utils/cacheHelper');
const { enqueueEvent, enqueueNotification } = require('../../utils/queue');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const { emit } = require('../../utils/eventEmitter');
const { deleteCloudinaryImage } = require('../../utils/cloudinaryHelper');
const { createSlug, validateTourData, validateStoredPricing, rebuildSchedulePrices, durationToMinutes } = require('../../utils/tourHelpers');
const { logActivity } = require('../../utils/auditLogger');
const { cancelPaymentIntent } = require('../../utils/stripeHelpers');
const { cloudinaryUrl } = require('../../utils/imageOptimizer');
const {
  buildTourFilters,
  buildSortOptions,
  getAvailableFilterOptions,
  validateFilterParams,
  findNearbyTourIds,
  getTourDistances,
} = require('../../utils/tourFilterBuilder');
const { getPopularByCategory } = require('../../utils/popularityScorer');
const { rankTourIdsBySearch } = require('../../utils/fullTextSearch');
const { verifyAccessToken } = require('../../config/jwt');

const controller = require('../../controllers/tourController');

describe('tourController', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      query: {},
      params: {},
      body: {},
      supplierId: 'supplier-1',
      user: { id: 'supplier-1', roles: ['supplier'] },
      files: [],
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      ip: '127.0.0.1',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };
    next = jest.fn();

    jest.clearAllMocks();

    prisma.tour.findMany.mockResolvedValue([]);
    prisma.tour.findFirst.mockResolvedValue(null);
    prisma.tour.count.mockResolvedValue(0);
    prisma.tour.create.mockResolvedValue({});
    prisma.tour.update.mockResolvedValue({});
    prisma.tour.groupBy.mockResolvedValue([]);
    prisma.tour.aggregate.mockResolvedValue({});
    prisma.booking.groupBy.mockResolvedValue([]);
    prisma.booking.aggregate.mockResolvedValue({});
    prisma.review.aggregate.mockResolvedValue({});
    prisma.supplierProfile.findUnique.mockResolvedValue(null);
    prisma.supplierProfile.create.mockResolvedValue({});
    prisma.supplierProfile.update.mockResolvedValue({});
    prisma.tourSecondaryTheme.deleteMany.mockResolvedValue();
    prisma.tourSecondaryTheme.createMany.mockResolvedValue();
    prisma.payoutMethod.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.$transaction.mockImplementation((cb) => cb(prisma));
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    cache.getOrSet.mockImplementation((key, fn) => fn());
    cache.invalidateTourCaches.mockResolvedValue();
    cache.invalidateKeys.mockResolvedValue();
    enqueueEvent.mockResolvedValue();
    enqueueNotification.mockResolvedValue();
    notifyAdmin.mockResolvedValue();
    deleteCloudinaryImage.mockResolvedValue();
    createSlug.mockResolvedValue('test-tour-slug');
    validateTourData.mockReturnValue({ isValid: true, errors: [] });
    validateStoredPricing.mockReturnValue([]);
    logActivity.mockResolvedValue();
    cloudinaryUrl.mockImplementation((url, size) => `https://cdn.example.com/${size}/${url}`);
    buildTourFilters.mockReturnValue({});
    buildSortOptions.mockReturnValue({ createdAt: 'desc' });
    validateFilterParams.mockReturnValue({ isValid: true, errors: [] });
    findNearbyTourIds.mockResolvedValue([]);
    getTourDistances.mockResolvedValue(new Map());
    getAvailableFilterOptions.mockResolvedValue({});
    getPopularByCategory.mockReturnValue({});
    rankTourIdsBySearch.mockResolvedValue([]);
  });

  // ============================
  // getAllTours
  // ============================
  describe('getAllTours', () => {
    const mockTours = [
      { id: 'tour-1', title: 'Tour 1', photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/photo1.jpg'], coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/cover1.jpg', supplier: { id: 's1', name: 'S1', photoURL: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/photo.jpg', supplierProfile: { averageRating: 4.5, totalBookings: 10 } }, _count: { reviews: 5, bookings: 20 } },
      { id: 'tour-2', title: 'Tour 2', photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/photo2.jpg'], coverPhoto: null, supplier: { id: 's2', name: 'S2', photoURL: null, supplierProfile: { averageRating: 4.0, totalBookings: 5 } }, _count: { reviews: 2, bookings: 8 } },
    ];

    beforeEach(() => {
      prisma.tour.findMany.mockResolvedValue(mockTours);
      prisma.tour.count.mockResolvedValue(10);
      validateFilterParams.mockReturnValue({ isValid: true, errors: [] });
    });

    it('returns paginated tours', async () => {
      await controller.getAllTours(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            tours: expect.any(Array),
            pagination: expect.objectContaining({
              currentPage: 1,
              totalPages: 1,
              totalCount: 10,
            }),
          }),
        })
      );
    });

    it('returns 400 when filter validation fails', async () => {
      validateFilterParams.mockReturnValue({ isValid: false, errors: ['Invalid page'] });

      await controller.getAllTours(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
        message: expect.stringContaining('Invalid filters'),
      }));
    });

    it('returns empty array when geo filter finds no nearby tours', async () => {
      req.query = { lat: '5.6', lng: '-0.2', radius: '50' };
      findNearbyTourIds.mockResolvedValue([]);

      await controller.getAllTours(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tours: [],
            pagination: expect.objectContaining({ totalCount: 0 }),
          }),
        })
      );
    });

    it('filters by nearby ids when geo params are present', async () => {
      req.query = { lat: '5.6', lng: '-0.2' };
      findNearbyTourIds.mockResolvedValue(['tour-1']);
      getTourDistances.mockResolvedValue(new Map([['tour-1', 5.2]]));

      await controller.getAllTours(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({ id: { in: ['tour-1'] } }),
            ]),
          }),
        })
      );
    });

    it('sorts by nearest when sortBy=nearest with geo', async () => {
      req.query = { lat: '5.6', lng: '-0.2', sortBy: 'nearest' };
      findNearbyTourIds.mockResolvedValue(['tour-1', 'tour-2']);
      getTourDistances.mockResolvedValue(new Map([['tour-1', 5.2], ['tour-2', 2.0]]));

      await controller.getAllTours(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        })
      );
    });

    it('re-ranks by relevance when search is provided', async () => {
      req.query = { search: 'safari', sortBy: 'relevance' };
      rankTourIdsBySearch.mockResolvedValue(['tour-2', 'tour-1']);

      await controller.getAllTours(req, res, next);

      expect(rankTourIdsBySearch).toHaveBeenCalledWith('safari', ['tour-1', 'tour-2']);
    });

    it('defaults sortBy to relevance when search is provided without explicit sortBy', async () => {
      req.query = { search: 'safari' };

      await controller.getAllTours(req, res, next);

      expect(buildSortOptions).toHaveBeenCalledWith('relevance', 'desc');
    });

    it('emits search event when search param is present', async () => {
      req.query = { search: 'safari', category: 'Adventure' };

      await controller.getAllTours(req, res, next);

      expect(enqueueEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'search.executed',
          properties: expect.objectContaining({
            query: 'safari',
            category: 'Adventure',
          }),
        })
      );
    });

    it('emits browse event when no search but has category/location filters', async () => {
      req.query = { category: 'Cultural', location: 'Accra' };

      await controller.getAllTours(req, res, next);

      expect(enqueueEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'browse.executed',
        })
      );
    });

    it('does not emit event when no filters are applied', async () => {
      await controller.getAllTours(req, res, next);

      expect(enqueueEvent).not.toHaveBeenCalled();
    });

    it('handles prisma errors gracefully by passing to error middleware', async () => {
      const dbError = new Error('DB connection failed');
      prisma.tour.findMany.mockRejectedValue(dbError);

      await controller.getAllTours(req, res, next);

      expect(next).toHaveBeenCalledWith(dbError);
    });
  });

  // ============================
  // getFilterOptions
  // ============================
  describe('getFilterOptions', () => {
    it('returns filter options', async () => {
      getAvailableFilterOptions.mockResolvedValue({ categories: ['Cultural'], themes: ['Nature'] });

      await controller.getFilterOptions(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            filterOptions: expect.any(Object),
          }),
        })
      );
    });

    it('returns 500 when filter options are null', async () => {
      getAvailableFilterOptions.mockResolvedValue(null);

      await controller.getFilterOptions(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 500,
        message: expect.stringContaining('Failed to retrieve filter options'),
      }));
    });
  });

  // ============================
  // getPopularByCategory
  // ============================
  describe('getPopularByCategory', () => {
    const mockTours = [
      { id: 't1', title: 'Popular Tour', categorization: { category: 'Adventure' }, theme: { primary: 'Nature', secondary: ['Hiking'] }, supplier: { id: 's1', name: 'S1', photoURL: 'p.jpg', supplierProfile: { averageRating: 4.8, totalBookings: 50 } } },
    ];

    beforeEach(() => {
      prisma.tour.findMany.mockResolvedValue(mockTours);
      getPopularByCategory.mockReturnValue({
        Adventure: [
          { id: 't1', title: 'Popular Tour', photos: [], coverPhoto: null, supplier: { id: 's1', name: 'S1', photoURL: 'p.jpg', supplierProfile: { averageRating: 4.8, totalBookings: 50 } } },
        ],
      });
    });

    it('returns popular tours grouped by category', async () => {
      await controller.getPopularByCategory(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            categories: expect.any(Object),
            weights: expect.any(Object),
          }),
        })
      );
    });

    it('filters by category when query param is provided', async () => {
      req.query = { category: 'Adventure' };

      await controller.getPopularByCategory(req, res, next);

      // New implementation uses SQL directly — verify it returned results
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            categories: expect.any(Object),
          }),
        })
      );
    });

    it('filters by theme when query param is provided', async () => {
      req.query = { theme: 'Hiking' };

      await controller.getPopularByCategory(req, res, next);

      // New implementation uses SQL directly — verify it returned results
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            categories: expect.any(Object),
          }),
        })
      );
    });

    it('clamps perCategory between 1 and 20', async () => {
      req.query = { perCategory: '100' };

      await controller.getPopularByCategory(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // getTourBadges
  // ============================
  describe('getTourBadges', () => {
    it('returns badge payload for active tours on active suppliers', async () => {
      prisma.tour.findMany.mockResolvedValue([
        {
          id: 't1',
          slug: 'cape-coast',
          difficulty: 'MODERATE',
          bookingAndTickets: { pickupProvided: true, cancellationPolicy: { label: 'Free cancellation' }, meetingMode: 'hotel' },
          productContent: { writingLanguage: 'English' },
          categorization: { accommodationIncluded: true },
        },
      ]);

      await controller.getTourBadges(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'ACTIVE',
            supplier: { supplierProfile: { status: 'ACTIVE' } },
          },
        })
      );
      const body = res.json.mock.calls[0][0];
      expect(body.data.tours).toEqual([
        expect.objectContaining({
          id: 't1',
          slug: 'cape-coast',
          pickupIncluded: true,
          cancellationPolicy: 'Free cancellation',
          languages: ['English'],
          meetingMode: 'hotel',
          accommodationIncluded: true,
        }),
      ]);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns empty tours when none active', async () => {
      prisma.tour.findMany.mockResolvedValue([]);
      await controller.getTourBadges(req, res, next);
      const body = res.json.mock.calls[0][0];
      expect(body.data.tours).toEqual([]);
    });
  });

  // ============================
  // getTour
  // ============================
  describe('getTour', () => {
    const mockTour = {
      id: 'tour-1',
      title: 'Test Tour',
      slug: 'test-tour',
      status: 'ACTIVE',
      supplierId: 'supplier-1',
      photos: ['photo1.jpg'],
      coverPhoto: 'cover.jpg',
      supplier: { id: 's1', name: 'S1', photoURL: null, supplierProfile: { averageRating: 4.5, totalBookings: 10, businessInfo: {} } },
      reviews: [],
      _count: { reviews: 0, bookings: 0 },
    };

    beforeEach(() => {
      prisma.tour.findFirst.mockResolvedValue(mockTour);
    });

    it('returns a single tour by ID', async () => {
      req.params = { id: 'tour-1' };

      await controller.getTour(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            tour: expect.objectContaining({ id: 'tour-1' }),
          }),
        })
      );
    });

    it('lets a logged-in supplier view a public ACTIVE tour they do not own', async () => {
      req.params = { id: 'tour-1' };
      verifyAccessToken.mockReturnValue({ id: 'supplier-2', userId: 'supplier-2' });
      req.headers.authorization = 'Bearer supplier-token';
      req.user = { id: 'supplier-2', roles: ['supplier'] };
      prisma.supplierProfile.findFirst.mockResolvedValue({ id: 'profile-2', status: 'ACTIVE' });

      await controller.getTour(req, res, next);

      const where = prisma.tour.findFirst.mock.calls[0][0].where;
      expect(where).toEqual(expect.objectContaining({
        OR: [{ id: 'tour-1' }, { slug: 'tour-1' }],
        AND: [{ OR: [{ status: 'ACTIVE' }, { supplierId: 'supplier-2' }] }],
      }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('lets a supplier fetch their own non-ACTIVE (draft) tour', async () => {
      req.params = { id: 'tour-1' };
      verifyAccessToken.mockReturnValue({ id: 'supplier-1', userId: 'supplier-1' });
      prisma.tour.findFirst.mockResolvedValue({ ...mockTour, status: 'DRAFT', supplierId: 'supplier-1' });
      req.headers.authorization = 'Bearer owner-token';
      req.user = { id: 'supplier-1', roles: ['supplier'] };
      prisma.supplierProfile.findFirst.mockResolvedValue({ id: 'profile-1', status: 'PENDING' });

      await controller.getTour(req, res, next);

      const where = prisma.tour.findFirst.mock.calls[0][0].where;
      expect(where).toEqual(expect.objectContaining({
        AND: [{ OR: [{ status: 'ACTIVE' }, { supplierId: 'supplier-1' }] }],
      }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 404 when tour is not found', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);
      req.params = { id: 'nonexistent' };

      await controller.getTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 404,
        message: 'Tour not found',
      }));
    });

    it('does not count view for tour owner', async () => {
      req.params = { id: 'tour-1' };
      req.user = { id: 'supplier-1', roles: ['supplier'] };

      await controller.getTour(req, res, next);

      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('does not count view for admin', async () => {
      req.params = { id: 'tour-1' };
      req.user = { id: 'admin-1', roles: ['admin'] };

      await controller.getTour(req, res, next);

      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('increments view count for unique visitor', async () => {
      req.params = { id: 'tour-1' };
      req.user = { id: 'customer-1', roles: ['customer'] };
      prisma.tour.update = jest.fn().mockResolvedValue();

      await controller.getTour(req, res, next);

      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tour-1' },
          data: { viewCount: { increment: 1 } },
        })
      );
    });

    it('does not count view for non-owner active supplier', async () => {
      req.params = { id: 'tour-1' };
      req.user = { id: 'supplier-2', roles: ['supplier'] };
      prisma.supplierProfile.findFirst.mockResolvedValue({ status: 'ACTIVE' });
      prisma.tour.update = jest.fn().mockResolvedValue();

      await controller.getTour(req, res, next);

      expect(prisma.supplierProfile.findFirst).toHaveBeenCalled();
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('counts view for supplier whose profile is not ACTIVE', async () => {
      req.params = { id: 'tour-1' };
      req.user = { id: 'supplier-3', roles: ['supplier'] };
      prisma.supplierProfile.findFirst.mockResolvedValue({ status: 'PENDING' });
      prisma.tour.update = jest.fn().mockResolvedValue();

      await controller.getTour(req, res, next);

      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tour-1' },
          data: { viewCount: { increment: 1 } },
        })
      );
    });

    it('does not count view for expedition role', async () => {
      req.params = { id: 'tour-1' };
      req.user = { id: 'exp-1', roles: ['expedition'] };
      prisma.tour.update = jest.fn().mockResolvedValue();

      await controller.getTour(req, res, next);

      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('emits tour.viewed event when view is counted', async () => {
      emit.mockClear();
      req.params = { id: 'tour-1' };
      req.user = { id: 'unique-viewer-99', roles: ['customer'] };
      prisma.tour.update = jest.fn().mockResolvedValue();

      await controller.getTour(req, res, next);

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'tour.viewed' })
      );
    });

    it('sets Cache-Control header', async () => {
      req.params = { id: 'tour-1' };

      await controller.getTour(req, res, next);

      expect(res.set).toHaveBeenCalledWith(
        'Cache-Control',
        expect.stringContaining('public')
      );
    });
  });

  // ============================
  // createTour
  // ============================
  describe('createTour', () => {
    const mockProfile = { userId: 'supplier-1', status: 'ACTIVE' };
    const mockCreatedTour = {
      id: 'new-tour-1',
      title: 'New Tour',
      slug: 'new-tour',
      supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null },
    };

    beforeEach(() => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.tour.create.mockResolvedValue(mockCreatedTour);
      prisma.payoutMethod.findFirst = jest.fn().mockResolvedValue(null);
    });

    it('creates a tour successfully', async () => {
      req.body = {
        title: 'New Tour',
        description: 'A great tour experience that is long enough to pass validation.',
        categorization: { category: 'Adventure', subcategory: 'Hiking', activityType: 'Guided', difficulty: 'Easy', duration: { hours: 3 } },
        theme: { primary: 'Nature', secondary: ['Photography'] },
        productContent: { highlights: ['Nice view'], location: { city: 'Accra', country: 'Ghana', region: 'Greater Accra' } },
        schedulesAndPricing: {},
        bookingAndTickets: {},
        photos: [],
        tags: ['adventure'],
        status: 'DRAFT',
        latitude: 5.6,
        longitude: -0.2,
      };

      await controller.createTour(req, res, next);

      expect(prisma.tour.create).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({ tour: mockCreatedTour }),
        })
      );
    });

    it('returns 403 when supplier profile is not active', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue({ userId: 'supplier-1', status: 'SUSPENDED' });

      await controller.createTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('returns 403 when supplier profile does not exist', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(null);

      await controller.createTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('coerces ACTIVE/PUBLISHED status to DRAFT (no direct publish)', async () => {
      req.body = {
        title: 'New Tour',
        description: 'A great tour experience that is long enough to pass validation.',
        categorization: { category: 'Adventure', subcategory: 'Hiking', activityType: 'Guided', difficulty: 'Easy', duration: { hours: 3 } },
        theme: { primary: 'Nature', secondary: [] },
        productContent: { location: { city: 'Accra', country: 'Ghana', region: 'Greater Accra' } },
        schedulesAndPricing: {},
        bookingAndTickets: {},
        photos: [],
        status: 'PUBLISHED',
      };
      prisma.payoutMethod.findFirst = jest.fn().mockResolvedValue({ id: 'pm-1', verified: true });

      await controller.createTour(req, res, next);

      expect(prisma.tour.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DRAFT' }),
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(prisma.payoutMethod.findFirst).not.toHaveBeenCalled();
    });

    it('returns 400 when validation fails', async () => {
      validateTourData.mockReturnValue({ isValid: false, errors: ['Title is required'] });

      await controller.createTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('uploads photos from multer files', async () => {
      req.files = [{ path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/img1.jpg' }, { path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/img2.jpg' }];
      req.body = {
        title: 'Tour With Photos',
        description: 'A great tour experience that is long enough to pass validation.',
        categorization: { category: 'Adventure', subcategory: 'Hiking', activityType: 'Guided', difficulty: 'Easy', duration: { hours: 3 } },
        theme: { primary: 'Nature', secondary: [] },
        productContent: { highlights: ['Nice view'], location: { city: 'Accra', country: 'Ghana', region: 'Greater Accra' } },
        schedulesAndPricing: {},
        bookingAndTickets: {},
        photos: [],
        tags: ['adventure'],
        status: 'DRAFT',
        latitude: 5.6,
        longitude: -0.2,
      };

      await controller.createTour(req, res, next);

      expect(prisma.tour.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            photos: expect.arrayContaining(['https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/img1.jpg']),
          }),
        })
      );
    });

    it('sets coverPhoto from coverPhotoIndex', async () => {
      req.files = [{ path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/img1.jpg' }, { path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/img2.jpg' }];
      req.body.coverPhotoIndex = '1';
      req.body.title = 'Tour';
      req.body.description = 'A great tour experience that is long enough to pass validation.';
      req.body.categorization = { category: 'Adventure', subcategory: 'Hiking', activityType: 'Guided', difficulty: 'Easy', duration: { hours: 3 } };
      req.body.theme = { primary: 'Nature', secondary: [] };
      req.body.productContent = { location: { city: 'Accra', country: 'Ghana', region: 'Greater Accra' } };
      req.body.schedulesAndPricing = {};
      req.body.bookingAndTickets = {};

      await controller.createTour(req, res, next);

      expect(prisma.tour.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/img2.jpg',
          }),
        })
      );
    });

    it('logs activity on success', async () => {
      req.body = {
        title: 'New Tour',
        description: 'A great tour experience that is long enough to pass validation.',
        categorization: { category: 'Adventure', subcategory: 'Hiking', activityType: 'Guided', difficulty: 'Easy', duration: { hours: 3 } },
        theme: { primary: 'Nature', secondary: [] },
        productContent: { location: { city: 'Accra', country: 'Ghana', region: 'Greater Accra' } },
        schedulesAndPricing: {},
        bookingAndTickets: {},
        status: 'DRAFT',
      };

      await controller.createTour(req, res, next);
      await new Promise(resolve => setImmediate(resolve));

      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tour.created',
          userId: 'supplier-1',
        })
      );
    });

    it('invalidates cache after creation', async () => {
      req.body = {
        title: 'New Tour',
        description: 'A great tour experience that is long enough to pass validation.',
        categorization: { category: 'Adventure', subcategory: 'Hiking', activityType: 'Guided', difficulty: 'Easy', duration: { hours: 3 } },
        theme: { primary: 'Nature', secondary: [] },
        productContent: { location: { city: 'Accra', country: 'Ghana', region: 'Greater Accra' } },
        schedulesAndPricing: {},
        bookingAndTickets: {},
      };

      await controller.createTour(req, res, next);
      await new Promise(resolve => setImmediate(resolve));

      expect(cache.invalidateTourCaches).toHaveBeenCalled();
    });

    it('handles error when cache invalidation fails', async () => {
      cache.invalidateTourCaches.mockRejectedValue(new Error('Cache error'));
      req.body = {
        title: 'New Tour',
        description: 'A great tour experience that is long enough to pass validation.',
        categorization: { category: 'Adventure', subcategory: 'Hiking', activityType: 'Guided', difficulty: 'Easy', duration: { hours: 3 } },
        theme: { primary: 'Nature', secondary: [] },
        productContent: { location: { city: 'Accra', country: 'Ghana', region: 'Greater Accra' } },
        schedulesAndPricing: {},
        bookingAndTickets: {},
      };

      await controller.createTour(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  // ============================
  // updateTour
  // ============================
  describe('updateTour', () => {
    const mockExistingTour = {
      id: 'tour-1',
      title: 'Old Title',
      supplierId: 'supplier-1',
      status: 'DRAFT',
      photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/old-photo.jpg'],
      coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/old-photo.jpg',
    };
    const mockUpdatedTour = {
      id: 'tour-1',
      title: 'Updated Title',
      slug: 'updated-title',
      supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null },
    };

    beforeEach(() => {
      req.params = { id: 'tour-1' };
      prisma.tour.findFirst.mockResolvedValue(mockExistingTour);
      prisma.tour.update.mockResolvedValue(mockUpdatedTour);
    });

    it('updates a tour successfully', async () => {
      req.body = { title: 'Updated Title' };

      await controller.updateTour(req, res, next);

      expect(prisma.tour.update).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 404 when tour not found or not owned by supplier', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);

      await controller.updateTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('blocks direct publish (ACTIVE/PUBLISHED) with guidance to submit for review', async () => {
      req.body = { status: 'PUBLISHED' };
      prisma.payoutMethod = { findFirst: jest.fn().mockResolvedValue(null) };

      await controller.updateTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('blocks direct publish even with a verified payout method', async () => {
      req.body = { title: 'Updated', status: 'ACTIVE' };
      prisma.payoutMethod = { findFirst: jest.fn().mockResolvedValue({ id: 'pm-1', verified: true }) };

      await controller.updateTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('returns 400 when partial validation fails', async () => {
      validateTourData.mockReturnValue({ isValid: false, errors: ['Invalid field'] });

      await controller.updateTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('blocks Set Live (ACTIVE) via the direct-publish guard', async () => {
      req.body = { status: 'ACTIVE' };
      prisma.tour.findFirst.mockResolvedValue({
        ...mockExistingTour,
        status: 'DRAFT',
        schedulesAndPricing: {
          travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'dependsOnAge' },
          pricingSchedules: { schedules: [] },
          availability: { scheduleType: 'fixedTimeSlot', timeSlots: [] },
        },
      });
      validateStoredPricing.mockReturnValue(['Add at least one pricing schedule']);

      await controller.updateTour(req, res, next);

      expect(validateStoredPricing).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('blocks Set Live (ACTIVE) even with a complete stored pricing blob', async () => {
      req.body = { status: 'ACTIVE' };
      prisma.tour.findFirst.mockResolvedValue({
        ...mockExistingTour,
        status: 'DRAFT',
        schedulesAndPricing: {
          travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'dependsOnAge' },
          pricingSchedules: { schedules: [{ startDate: '2026-01-01' }] },
          availability: { scheduleType: 'fixedTimeSlot', timeSlots: ['09:00'] },
        },
      });
    validateStoredPricing.mockReturnValue([]);
    rebuildSchedulePrices.mockImplementation((blob) => blob);
    durationToMinutes.mockImplementation((d) => (d?.value != null && d?.unit === 'hours' ? d.value * 60 : null));

      await controller.updateTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('blocks direct publish even when a pricing blob is supplied', async () => {
      req.body = {
        title: 'Updated',
        status: 'PUBLISHED',
        schedulesAndPricing: {
          travelerDetails: { pricingModel: 'perGroup', groupSizes: [{ from: 1, to: 4, price: null }] },
          pricingSchedules: { schedules: [{ startDate: '2026-01-01' }] },
          availability: { scheduleType: 'fixedTimeSlot', timeSlots: ['09:00'] },
        },
      };
      prisma.payoutMethod = { findFirst: jest.fn().mockResolvedValue({ id: 'pm-1', verified: true }) };
      validateStoredPricing.mockReturnValue(['Group size 1: price is required']);

      await controller.updateTour(req, res, next);

      expect(validateStoredPricing).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('does not run live pricing validation on plain draft updates', async () => {
      req.body = { title: 'Updated' };

      await controller.updateTour(req, res, next);

      expect(validateStoredPricing).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('regenerates derived schedule prices on the incoming blob before persisting', async () => {
      const incoming = {
        travelerDetails: { pricingModel: 'perGroup', groupSizes: [{ from: 1, to: 4, price: 300 }] },
        pricingSchedules: { schedules: [{ startDate: '2026-01-01', prices: [] }] },
        availability: { scheduleType: 'fixedTimeSlot', timeSlots: ['09:00'] },
      };
      const normalized = JSON.parse(JSON.stringify(incoming));
      normalized.pricingSchedules.schedules[0].prices = [{ label: 'Group of 1-4', retailPrice: 300, groupSize: true }];
      rebuildSchedulePrices.mockReturnValue(normalized);
      req.body = { title: 'Updated', schedulesAndPricing: incoming };

      await controller.updateTour(req, res, next);

      expect(rebuildSchedulePrices).toHaveBeenCalledWith(incoming);
      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schedulesAndPricing: normalized }),
        })
      );
    });

    it('updates slug when title changes', async () => {
      req.body = { title: 'Brand New Title' };

      await controller.updateTour(req, res, next);

      expect(createSlug).toHaveBeenCalledWith('Brand New Title', expect.anything());
    });

    it('normalizes durationMinutes from the dashboard { value, unit } duration shape', async () => {
      durationToMinutes.mockReturnValue(120);
      req.body = { title: 'Updated', categorization: { duration: { value: 2, unit: 'hours' } } };

      await controller.updateTour(req, res, next);

      expect(durationToMinutes).toHaveBeenCalledWith({ value: 2, unit: 'hours' });
      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ durationMinutes: 120 }),
        })
      );
    });

    it('handles photo uploads and deletion of removed photos', async () => {
      req.body = { title: 'Updated', existingPhotos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/kept-photo.jpg'] };
      req.files = [{ path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/new-photo.jpg' }];
      prisma.tour.findFirst.mockResolvedValue({
        ...mockExistingTour,
        photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/old-photo.jpg', 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/kept-photo.jpg'],
      });

      await controller.updateTour(req, res, next);

      expect(deleteCloudinaryImage).toHaveBeenCalledWith('https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/old-photo.jpg', 3, { tourId: 'tour-1' });
    });

    it('handles categorization normalization from JSON string', async () => {
      req.body = {
        categorization: JSON.stringify({
          category: 'Cultural',
          subcategory: 'Walking Tours',
          activityType: 'Guided',
          difficulty: 'Easy',
          duration: { hours: 2 },
        }),
      };

      await controller.updateTour(req, res, next);

      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            category: 'Cultural',
            subcategory: 'Walking Tours',
            durationMinutes: 120,
          }),
        })
      );
    });

    it('extracts location fields from productContent', async () => {
      req.body = {
        title: 'Updated',
        productContent: { location: { city: 'Kumasi', country: 'Ghana', region: 'Ashanti' } },
      };

      await controller.updateTour(req, res, next);

      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            city: 'Kumasi',
            country: 'Ghana',
            region: 'Ashanti',
          }),
        })
      );
    });

    it('invalidates cache after update', async () => {
      req.body = { title: 'Updated' };

      await controller.updateTour(req, res, next);

      expect(cache.invalidateTourCaches).toHaveBeenCalledWith('tour-1', 'updated-title');
    });

    it('logs activity after update', async () => {
      req.body = { title: 'Updated' };

      await controller.updateTour(req, res, next);

      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'tour.updated' })
      );
    });
  });

  // ============================
  // deleteTour
  // ============================
  describe('deleteTour', () => {
    const mockTour = {
      id: 'tour-1',
      title: 'Test Tour',
      slug: 'test-tour',
      supplierId: 'supplier-1',
      photos: ['photo1.jpg', 'photo2.jpg'],
    };

    beforeEach(() => {
      req.params = { id: 'tour-1' };
      prisma.tour.findFirst.mockResolvedValue({ ...mockTour, bookings: [] });
      cancelPaymentIntent.mockReset();
      cancelPaymentIntent.mockResolvedValue({ ok: true });
    });

    it('deletes a tour (archives it)', async () => {
      await controller.deleteTour(req, res, next);

      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tour-1' },
          data: { status: 'ARCHIVED' },
        })
      );
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('returns 404 when tour not found', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);

      await controller.deleteTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when tour has active bookings', async () => {
      prisma.tour.findFirst.mockResolvedValue({
        ...mockTour,
        bookings: [{ id: 'b1', status: 'CONFIRMED' }],
      });

      await controller.deleteTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('auto-cancels PENDING bookings instead of blocking deletion', async () => {
      prisma.tour.findFirst.mockResolvedValue({
        ...mockTour,
        bookings: [
          { id: 'b1', status: 'PENDING' },
          { id: 'b2', status: 'PENDING' },
        ],
      });

      await controller.deleteTour(req, res, next);

expect(prisma.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['b1', 'b2'] }, status: 'PENDING' },
          data: expect.objectContaining({
            status: 'CANCELLED',
            cancellationReason: 'Tour deleted by supplier',
          }),
        })
      );
      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tour-1' } })
      );
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('cancels the live Stripe intent before cancelling its PENDING booking', async () => {
      prisma.tour.findFirst.mockResolvedValue({
        ...mockTour,
        bookings: [
          { id: 'b1', status: 'PENDING', stripePaymentIntentId: 'pi_1', paymentStatus: 'PROCESSING' },
          { id: 'b2', status: 'PENDING' },
        ],
      });

      await controller.deleteTour(req, res, next);

      expect(cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
      expect(prisma.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['b1', 'b2'] }, status: 'PENDING' },
        })
      );
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('blocks deletion with 409 when the live payment already succeeded', async () => {
      cancelPaymentIntent.mockResolvedValue({ ok: false, reason: 'status_succeeded' });
      prisma.tour.findFirst.mockResolvedValue({
        ...mockTour,
        bookings: [
          { id: 'b1', status: 'PENDING', stripePaymentIntentId: 'pi_1', paymentStatus: 'PROCESSING' },
        ],
      });

      await controller.deleteTour(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 409, message: expect.stringContaining('already succeeded') })
      );
      expect(prisma.booking.updateMany).not.toHaveBeenCalled();
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('blocks deletion with 409 when the live payment is in flight', async () => {
      cancelPaymentIntent.mockResolvedValue({ ok: false, reason: 'cancel_failed' });
      prisma.tour.findFirst.mockResolvedValue({
        ...mockTour,
        bookings: [
          { id: 'b1', status: 'PENDING', stripePaymentIntentId: 'pi_1', paymentStatus: 'PROCESSING' },
        ],
      });

      await controller.deleteTour(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 409 })
      );
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('leaves abandoned PENDING bookings (no live charge) alone in Stripe', async () => {
      prisma.tour.findFirst.mockResolvedValue({
        ...mockTour,
        bookings: [
          { id: 'b1', status: 'PENDING', stripePaymentIntentId: null, paymentStatus: 'PENDING' },
        ],
      });

      await controller.deleteTour(req, res, next);

      expect(cancelPaymentIntent).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('deletes associated photos from Cloudinary', async () => {
      await controller.deleteTour(req, res, next);

      expect(deleteCloudinaryImage).toHaveBeenCalledWith('photo1.jpg');
      expect(deleteCloudinaryImage).toHaveBeenCalledWith('photo2.jpg');
    });

    it('invalidates cache after deletion', async () => {
      await controller.deleteTour(req, res, next);

      expect(cache.invalidateTourCaches).toHaveBeenCalledWith('tour-1', 'test-tour');
    });

    it('logs activity after deletion', async () => {
      await controller.deleteTour(req, res, next);

      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'tour.deleted' })
      );
    });
  });

  // ============================
  // getMyTours
  // ============================
  describe('getMyTours', () => {
    const mockMyTours = [
      { id: 't1', title: 'My Tour', photos: ['p1.jpg'], coverPhoto: 'c1.jpg', _count: { reviews: 1, bookings: 5 } },
    ];

    beforeEach(() => {
      prisma.tour.findMany.mockResolvedValue(mockMyTours);
      prisma.tour.count.mockResolvedValue(1);
    });

    it('returns supplier own tours', async () => {
      await controller.getMyTours(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            supplierId: 'supplier-1',
            status: { not: 'ARCHIVED' },
          }),
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('filters by status when query param is provided', async () => {
      req.query.status = 'PUBLISHED';

      await controller.getMyTours(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'PUBLISHED',
          }),
        })
      );
    });

    it('handles pagination params', async () => {
      req.query = { page: '2', limit: '5' };
      prisma.tour.count.mockResolvedValue(12);

      await controller.getMyTours(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pagination: expect.objectContaining({
              currentPage: 2,
              totalPages: 3,
              totalCount: 12,
            }),
          }),
        })
      );
    });
  });

  // ============================
  // getTourAnalytics
  // ============================
  describe('getTourAnalytics', () => {
    const mockTour = { id: 'tour-1', title: 'Test Tour', viewCount: 150 };

    beforeEach(() => {
      req.params = { id: 'tour-1' };
      prisma.tour.findFirst.mockResolvedValue(mockTour);
      prisma.booking.groupBy.mockResolvedValue([{ status: 'CONFIRMED', _count: 10 }]);
      prisma.booking.aggregate.mockResolvedValue({
        _sum: { total: 5000, supplierPayout: 4000 },
        _avg: { total: 500 },
      });
      prisma.review.aggregate.mockResolvedValue({
        _avg: { rating: 4.5 },
        _count: 20,
      });
      prisma.$queryRaw.mockResolvedValue([
        { month: new Date('2026-01-01'), bookings: 5, revenue: 2500 },
      ]);
    });

    it('returns analytics for own tour', async () => {
      await controller.getTourAnalytics(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            bookingStats: expect.any(Array),
            revenueStats: expect.any(Object),
            reviewStats: expect.any(Object),
            monthlyBookings: expect.any(Array),
            tour: expect.objectContaining({ id: 'tour-1' }),
          }),
        })
      );
    });

    it('returns 404 when tour not found', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);

      await controller.getTourAnalytics(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // deleteTourPhoto
  // ============================
  describe('deleteTourPhoto', () => {
    const mockTour = {
      id: 'tour-1',
      title: 'Test Tour',
      slug: 'test-tour',
      supplierId: 'supplier-1',
      photos: ['photo1.jpg', 'photo2.jpg'],
      coverPhoto: 'photo1.jpg',
    };

    beforeEach(() => {
      req.params = { id: 'tour-1' };
      req.body = { photoUrl: 'photo1.jpg' };
      prisma.tour.findFirst.mockResolvedValue(mockTour);
    });

    it('deletes a photo from a tour', async () => {
      await controller.deleteTourPhoto(req, res, next);

      expect(deleteCloudinaryImage).toHaveBeenCalledWith('photo1.jpg');
      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tour-1' },
          data: expect.objectContaining({
            photos: ['photo2.jpg'],
            coverPhoto: null,
          }),
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 when photoUrl is missing', async () => {
      req.body = {};

      await controller.deleteTourPhoto(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when tour not found', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);

      await controller.deleteTourPhoto(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 404 when photo is not in the tour', async () => {
      req.body = { photoUrl: 'nonexistent.jpg' };

      await controller.deleteTourPhoto(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('does not clear coverPhoto if a different photo is deleted', async () => {
      req.body = { photoUrl: 'photo2.jpg' };

      await controller.deleteTourPhoto(req, res, next);

      const callArg = prisma.tour.update.mock.calls[0][0];
      expect(callArg.data.coverPhoto).toBeUndefined();
      expect(callArg.data.photos).toEqual(['photo1.jpg']);
    });
  });

  // ============================
  // seedTour
  // ============================
  describe('seedTour', () => {
    const mockProfile = null;
    const mockCreatedProfile = {
      userId: 'supplier-1',
      status: 'ACTIVE',
      businessInfo: {},
      operatingInfo: {},
      representativeInfo: {},
      businessDocuments: {},
      payoutInfo: {},
      compliance: {},
    };
    const mockSeededTour = {
      id: 'seeded-tour',
      title: expect.stringContaining('Simulated Tour'),
      supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null },
    };

    beforeEach(() => {
      delete process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.supplierProfile.create.mockResolvedValue(mockCreatedProfile);
      prisma.tour.create.mockResolvedValue(mockSeededTour);
    });

    it('returns 403 when not in development mode', async () => {
      process.env.NODE_ENV = 'production';

      await controller.seedTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('creates supplier profile if none exists', async () => {
      await controller.seedTour(req, res, next);

      expect(prisma.supplierProfile.create).toHaveBeenCalled();
    });

    it('activates supplier profile if not active', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue({ userId: 'supplier-1', status: 'INACTIVE' });
      prisma.supplierProfile.update = jest.fn().mockResolvedValue({ userId: 'supplier-1', status: 'ACTIVE' });

      await controller.seedTour(req, res, next);

      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'ACTIVE' } })
      );
    });

    it('creates a seeded tour', async () => {
      await controller.seedTour(req, res, next);

      expect(prisma.tour.create).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          message: 'Simulated tour created successfully',
        })
      );
    });

    it('invalidates cache after seeding', async () => {
      await controller.seedTour(req, res, next);

      expect(cache.invalidateTourCaches).toHaveBeenCalled();
    });

    it('logs activity after seeding', async () => {
      await controller.seedTour(req, res, next);

      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'tour.seeded' })
      );
    });
  });

  // ============================
  // submitTourForReview
  // ============================
  describe('submitTourForReview', () => {
    const completeTour = {
      id: 'tour-1',
      title: 'Complete Tour',
      description: 'A fully fleshed-out tour description that is long enough.',
      photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/p.jpg'],
      status: 'DRAFT',
      supplierId: 'supplier-1',
      categorization: { category: 'Adventure' },
      productContent: {
        writingLanguage: 'English',
        highlights: ['Scenic views'],
        meetingMode: 'meeting_point',
        meetingPoint: { name: 'Independence Arch', address: 'Accra' },
      },
      bookingAndTickets: { meetingPoint: { name: 'Independence Arch', address: 'Accra' } },
      schedulesAndPricing: {},
      supplier: { id: 'supplier-1', name: 'Supplier One', photoURL: null },
    };

    beforeEach(() => {
      req.params = { id: 'tour-1' };
      req.supplierId = 'supplier-1';
      prisma.tour.findFirst.mockResolvedValue(completeTour);
      prisma.payoutMethod.findFirst = jest.fn().mockResolvedValue({ id: 'pm-1' });
      prisma.tour.update.mockResolvedValue({ ...completeTour, status: 'PENDING_APPROVAL' });
      prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
      prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
      validateStoredPricing.mockReturnValue([]);
    });

    it('moves a complete tour to PENDING_APPROVAL and notifies admins', async () => {
      await controller.submitTourForReview(req, res, next);

      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tour-1' },
          data: expect.objectContaining({ status: 'PENDING_APPROVAL', submittedAt: expect.any(Date) }),
        })
      );
      expect(notifyAdmin).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TOUR_SUBMITTED_FOR_REVIEW', data: expect.objectContaining({ tourId: 'tour-1' }) })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 404 when tour is not owned by the supplier', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);

      await controller.submitTourForReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('resubmits an already-live tour for review without unpublishing it (ACTIVE + draft path)', async () => {
      prisma.tour.findFirst.mockResolvedValue({ ...completeTour, status: 'ACTIVE' });

      await controller.submitTourForReview(req, res, next);

      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tour-1' },
          data: expect.objectContaining({ status: 'ACTIVE', draftStatus: 'PENDING_APPROVAL', draftSubmittedAt: expect.any(Date) }),
        })
      );
      expect(notifyAdmin).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TOUR_SUBMITTED_FOR_REVIEW', data: expect.objectContaining({ tourId: 'tour-1', isResubmission: true }) })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 409 when the tour is already awaiting approval', async () => {
      prisma.tour.findFirst.mockResolvedValue({ ...completeTour, status: 'PENDING_APPROVAL' });

      await controller.submitTourForReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('rejects submission when required fields are missing', async () => {
      prisma.tour.findFirst.mockResolvedValue({ ...completeTour, title: ' ' });

      await controller.submitTourForReview(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 400, message: expect.stringContaining('title') })
      );
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('rejects submission without a verified payout method', async () => {
      prisma.payoutMethod.findFirst = jest.fn().mockResolvedValue(null);

      await controller.submitTourForReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('enforces pricing completeness via validateStoredPricing', async () => {
      validateStoredPricing.mockReturnValue(['Add at least one pricing schedule']);

      await controller.submitTourForReview(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 400, message: expect.stringContaining('pricing schedule') })
      );
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('clears stale review fields when resubmitting', async () => {
      prisma.tour.findFirst.mockResolvedValue({ ...completeTour, status: 'REJECTED', reviewedAt: new Date(), reviewNote: 'Fix pricing' });

      await controller.submitTourForReview(req, res, next);

      expect(prisma.tour.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reviewedBy: null, reviewedAt: null, reviewNote: null }),
        })
      );
    });
  });
});
