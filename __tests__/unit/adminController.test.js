jest.mock('../../utils/prismaClient', () => ({
  booking: { aggregate: jest.fn(), count: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
  user: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  adminRole: { findUnique: jest.fn() },
  tour: { findMany: jest.fn(), count: jest.fn() },
  event: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  auditLog: { findMany: jest.fn() },
  supplierProfile: {},
  $queryRaw: jest.fn(),
}));

jest.mock('../../utils/imageOptimizer', () => ({
  cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`),
}));
jest.mock('../../utils/cacheHelper', () => ({ getOrSet: jest.fn((key, fn) => fn()), invalidateKeys: jest.fn(() => Promise.resolve()) }));

const prisma = require('../../utils/prismaClient');
const { cloudinaryUrl } = require('../../utils/imageOptimizer');
const controller = require('../../controllers/adminController');

describe('adminController', () => {
  let req, res, next;

  const mockAgg = (overrides = {}) => ({
    _sum: { total: '5000', supplierPayout: '4000', commissionAmount: '800' },
    ...overrides,
  });
  const mockCount = () => 42;
  const mockGroupBy = () => [];

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    prisma.booking.aggregate.mockResolvedValue(mockAgg());
    prisma.booking.count.mockResolvedValue(mockCount());
    prisma.booking.groupBy.mockResolvedValue(mockGroupBy());
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(mockCount());
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.tour.findMany.mockResolvedValue([]);
    prisma.tour.count.mockResolvedValue(0);
    prisma.event.findMany.mockResolvedValue([]);
    prisma.event.count.mockResolvedValue(0);
    prisma.event.groupBy.mockResolvedValue([]);
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
    cloudinaryUrl.mockImplementation((url, size) => `https://cdn.example.com/${size}/${url}`);
  });

  // ============================
  // getOverview
  // ============================
  describe('getOverview', () => {
    const mockTopTours = [
      { id: 't1', title: 'Top Tour', coverPhoto: 'cover.jpg', totalBookings: 50, totalRevenue: '25000', averageRating: 4.8, reviewCount: 20 },
    ];
    const mockTopSuppliers = [
      { id: 's1', name: 'Top Supplier', email: 's@t.com', photoURL: 'p.jpg', totalEarnings: '50000', totalBookings: 100, averageRating: 4.5 },
    ];
    const mockBookingDist = [
      { status: 'CONFIRMED', _count: 20 },
      { status: 'PENDING', _count: 5 },
    ];
    const mockEvents = [
      { id: 'e1', name: 'tour.created', userId: 'u1', resource: 'Tour', resourceId: 't1', properties: {}, createdAt: new Date() },
    ];
    const mockUsers = [{ id: 'u1', name: 'User One' }];

    beforeEach(() => {
      prisma.$queryRaw
        .mockResolvedValueOnce(mockTopTours)
        .mockResolvedValueOnce(mockTopSuppliers);
      prisma.booking.groupBy.mockResolvedValue(mockBookingDist);
      prisma.event.findMany.mockResolvedValue(mockEvents);
      prisma.user.findMany.mockResolvedValue(mockUsers);
      prisma.event.count.mockResolvedValue(100);
    });

    it('returns platform overview with all data sections', async () => {
      await controller.getOverview(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            overview: expect.objectContaining({
              revenue: expect.any(Object),
              bookings: expect.any(Object),
              signups: expect.any(Object),
              activeUsers: expect.any(Number),
            }),
            topTours: expect.any(Array),
            topSuppliers: expect.any(Array),
            bookingStatusDistribution: expect.any(Array),
            eventFeed: expect.any(Array),
            totalEvents: expect.any(Number),
          }),
        })
      );
    });

    it('formats event feed with user names', async () => {
      await controller.getOverview(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.eventFeed[0].userName).toBe('User One');
    });

    it('handles missing user names gracefully', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await controller.getOverview(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.eventFeed[0].userName).toBeNull();
    });

    it('handles null revenue sums safely', async () => {
      prisma.booking.aggregate.mockResolvedValue({
        _sum: { total: null, supplierPayout: null, commissionAmount: null },
      });

      await controller.getOverview(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.overview.revenue.today.revenue).toBe(0);
    });
  });

  // ============================
  // getRevenueTrend
  // ============================
  describe('getRevenueTrend', () => {
    it('returns monthly revenue breakdown', async () => {
      const raw = [
        { month: new Date('2026-01-01'), bookings: 10, revenue: '5000', commission: '800', supplierPayout: '4000' },
      ];
      prisma.$queryRaw.mockResolvedValue(raw);

      await controller.getRevenueTrend(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            months: expect.any(Array),
          }),
        })
      );
    });
  });

  // ============================
  // getUserGrowth
  // ============================
  describe('getUserGrowth', () => {
    it('returns monthly user signup data', async () => {
      const raw = [
        { month: new Date('2026-01-01'), total: 50, customers: 40, suppliers: 10 },
      ];
      prisma.$queryRaw.mockResolvedValue(raw);

      await controller.getUserGrowth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ growth: raw }),
        })
      );
    });
  });

  // ============================
  // getTourPerformance
  // ============================
  describe('getTourPerformance', () => {
    const mockTours = [
      { id: 't1', title: 'Tour 1', slug: 'tour-1', status: 'ACTIVE', coverPhoto: 'c.jpg', totalBookings: 10, totalRevenue: '5000', averageRating: 4.5, reviewCount: 5, viewCount: 100, createdAt: new Date(), supplier: { id: 's1', name: 'S1' }, _count: { bookings: 10 } },
    ];

    beforeEach(() => {
      prisma.tour.findMany.mockResolvedValue(mockTours);
      prisma.tour.count.mockResolvedValue(1);
    });

    it('returns paginated tour performance data', async () => {
      await controller.getTourPerformance(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tours: expect.any(Array),
            pagination: expect.objectContaining({
              currentPage: 1,
              totalCount: 1,
            }),
          }),
        })
      );
    });

    it('filters by status when provided', async () => {
      req.query.status = 'active';

      await controller.getTourPerformance(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'ACTIVE' }),
        })
      );
    });

    it('filters by categorisation when category is provided', async () => {
      req.query.category = 'Adventure';

      await controller.getTourPerformance(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            categorization: { path: ['category'], equals: 'Adventure' },
          }),
        })
      );
    });

    it('validates sortBy against allowed list', async () => {
      req.query.sortBy = 'invalidField';

      await controller.getTourPerformance(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { totalRevenue: 'desc' },
        })
      );
    });

    it('parses page and limit parameters', async () => {
      req.query = { page: '2', limit: '10' };
      prisma.tour.count.mockResolvedValue(25);

      await controller.getTourPerformance(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        })
      );
      const body = res.json.mock.calls[0][0];
      expect(body.data.pagination.totalPages).toBe(3);
    });

    it('skips status filter when value is "all"', async () => {
      req.query.status = 'all';

      await controller.getTourPerformance(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
        })
      );
    });
  });

  // ============================
  // getFunnel
  // ============================
  describe('getFunnel', () => {
    const mockEventGroup = Array.from({ length: 10 }, (_, i) => ({ userId: `u${i}`, _count: 1 }));

    beforeEach(() => {
      prisma.event.groupBy.mockResolvedValue(mockEventGroup);
      prisma.$queryRaw.mockResolvedValue([]);
    });

    it('returns funnel with conversion rates', async () => {
      await controller.getFunnel(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            funnel: expect.any(Array),
            conversionRates: expect.any(Object),
            dailyTrend: expect.any(Array),
          }),
        })
      );
    });

    it('respects period query parameter', async () => {
      req.query.period = '7d';

      await controller.getFunnel(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handles zero view users gracefully', async () => {
      prisma.event.groupBy.mockResolvedValue([]);

      await controller.getFunnel(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.conversionRates.overall).toBe(0);
    });
  });

  // ============================
  // getCLV
  // ============================
  describe('getCLV', () => {
    const mockBasicStats = [{ totalCustomers: 100, totalBookings: 250, avgBookingValue: '200.00', totalRevenue: '50000.00' }];
    const mockRepeatRate = [{ totalCustomers: 100, repeatCustomers: 30, repeatRate: '30.0', avgBookingsPerCustomer: '2.5' }];
    const mockDistribution = [
      { bookingCount: '1', customers: 70, percentage: '70.0' },
      { bookingCount: '2', customers: 20, percentage: '20.0' },
    ];
    const mockTopCustomers = [
      { id: 'u1', name: 'Top Customer', email: 'c@t.com', totalBookings: 5, totalSpent: '2500.00', avgBookingValue: '500.00', lastBookingDate: new Date() },
    ];
    const mockCohorts = [
      { signupMonth: new Date('2026-01-01'), users: 20, bookings: 30, revenue: '6000.00', bookingsPerUser: '1.5', revenuePerUser: '300.00' },
    ];

    beforeEach(() => {
      prisma.$queryRaw
        .mockResolvedValueOnce(mockBasicStats)
        .mockResolvedValueOnce(mockRepeatRate)
        .mockResolvedValueOnce(mockDistribution)
        .mockResolvedValueOnce(mockTopCustomers)
        .mockResolvedValueOnce(mockCohorts);
    });

    it('returns CLV analytics with all sections', async () => {
      await controller.getCLV(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            overview: expect.objectContaining({
              totalCustomers: 100,
              totalRevenue: '50000.00',
            }),
            repeatRate: expect.any(Object),
            distribution: expect.any(Array),
            topCustomers: expect.any(Array),
            cohorts: expect.any(Array),
          }),
        })
      );
    });
  });

  // ============================
  // getSearchAnalytics
  // ============================
  describe('getSearchAnalytics', () => {
    const mockTotalSearches = [{ totalSearches: 500, uniqueSearchers: 100, zeroResultSearches: 25, zeroResultRate: '5.0' }];
    const mockTopQueries = [{ query: 'safari', searches: 50, uniqueUsers: 30, avgResults: '8.5' }];
    const mockZeroResult = [{ query: 'rare tour', searches: 5, uniqueUsers: 4 }];
    const mockDailyTrend = [{ day: new Date(), searches: 20, searchesWithResults: 18 }];
    const mockOutcome = [{ searchers: 100, viewersAfterSearch: 40, bookersAfterSearch: 10 }];

    beforeEach(() => {
      prisma.$queryRaw
        .mockResolvedValueOnce(mockTotalSearches)
        .mockResolvedValueOnce(mockTopQueries)
        .mockResolvedValueOnce(mockZeroResult)
        .mockResolvedValueOnce(mockDailyTrend)
        .mockResolvedValueOnce(mockOutcome);
    });

    it('returns search analytics with all sections', async () => {
      await controller.getSearchAnalytics(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            overview: expect.objectContaining({
              totalSearches: 500,
              uniqueSearchers: 100,
            }),
            topQueries: expect.any(Array),
            zeroResultQueries: expect.any(Array),
            dailyTrend: expect.any(Array),
            searchOutcome: expect.any(Object),
          }),
        })
      );
    });

    it('respects period query parameter', async () => {
      req.query.period = '90d';

      await controller.getSearchAnalytics(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // getCartAbandonment
  // ============================
  describe('getCartAbandonment', () => {
    const mockCartMetrics = [{ cartsCreated: 200, cartsConverted: 50, abandonmentRate: '75.0' }];
    const mockCartByTour = [{ tourId: 't1', cartsAdded: 30, converted: 10 }, { tourId: null, cartsAdded: 5, converted: 0 }];
    const mockDailyAbandonment = [{ day: new Date(), cartsAdded: 10, converted: 3, abandonmentRate: '70.0' }];

    beforeEach(() => {
      prisma.$queryRaw
        .mockResolvedValueOnce(mockCartMetrics)
        .mockResolvedValueOnce(mockCartByTour)
        .mockResolvedValueOnce(mockDailyAbandonment);
      prisma.tour.findMany.mockResolvedValue([{ id: 't1', title: 'Tour One' }]);
    });

    it('returns cart abandonment analytics', async () => {
      await controller.getCartAbandonment(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            overview: expect.objectContaining({
              cartsCreated: 200,
              cartsConverted: 50,
              abandonmentRate: 75.0,
            }),
            byTour: expect.any(Array),
            dailyTrend: expect.any(Array),
          }),
        })
      );
    });

    it('enriches abandoned tours with titles', async () => {
      await controller.getCartAbandonment(req, res, next);

      const body = res.json.mock.calls[0][0];
      const t1 = body.data.byTour.find((t) => t.tourId === 't1');
      expect(t1.tourTitle).toBe('Tour One');
    });

    it('shows Unknown for missing tour IDs', async () => {
      await controller.getCartAbandonment(req, res, next);

      const body = res.json.mock.calls[0][0];
      const nullTour = body.data.byTour.find((t) => t.tourId === null);
      expect(nullTour.tourTitle).toBe('Unknown');
    });

    it('skips tour enrichment when no tourIds', async () => {
      prisma.$queryRaw.mockReset();
      prisma.$queryRaw
        .mockResolvedValueOnce(mockCartMetrics)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(mockDailyAbandonment);

      await controller.getCartAbandonment(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.byTour).toEqual([]);
      expect(body.data.overview.cartsCreated).toBe(200);
    });
  });

  // ============================
  // getRecentSignups
  // ============================
  describe('getRecentSignups', () => {
    it('returns users from last 30 days', async () => {
      const users = [{ id: 'u1', name: 'New User', email: 'n@u.com', photoURL: null, roles: ['customer'], createdAt: new Date() }];
      prisma.user.findMany.mockResolvedValue(users);

      await controller.getRecentSignups(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ users }),
        })
      );
    });

    it('filters by last 30 days', async () => {
      await controller.getRecentSignups(req, res, next);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        })
      );
    });
  });

  // ============================
  // getActiveUsers
  // ============================
  describe('getActiveUsers', () => {
    it('returns active users from last 30 days', async () => {
      const users = [{ id: 'u1', name: 'Active User', email: 'a@u.com', photoURL: 'p.jpg', roles: ['customer'], lastLoginAt: new Date() }];
      prisma.user.findMany.mockResolvedValue(users);

      await controller.getActiveUsers(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ users }),
        })
      );
    });

    it('filters by active and lastLoginAt', async () => {
      await controller.getActiveUsers(req, res, next);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            active: true,
            lastLoginAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        })
      );
    });
  });

  // ============================
  // getTodayBookings
  // ============================
  describe('getTodayBookings', () => {
    it('returns today bookings with customer and tour details', async () => {
      const bookings = [
        { id: 'b1', total: 200, status: 'CONFIRMED', customer: { id: 'c1', name: 'Customer', email: 'c@t.com' }, tour: { id: 't1', title: 'Tour', supplier: { id: 's1', name: 'Supplier' } } },
      ];
      prisma.booking.findMany.mockResolvedValue(bookings);

      await controller.getTodayBookings(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ bookings }),
        })
      );
    });

    it('queries with date range for today', async () => {
      await controller.getTodayBookings(req, res, next);

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({
              gte: expect.any(Date),
              lt: expect.any(Date),
            }),
          }),
        })
      );
    });
  });

  // ============================
  // searchUsers
  // ============================
  describe('searchUsers', () => {
    it('searches users by name or email', async () => {
      const users = [
        { id: 'u1', name: 'John Doe', email: 'john@test.com', photoURL: null, roles: ['customer'] },
      ];
      prisma.user.findMany.mockResolvedValue(users);

      req.query = { q: 'john' };

      await controller.searchUsers(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            users: expect.arrayContaining([
              expect.objectContaining({ name: 'John Doe' }),
            ]),
          }),
        })
      );
    });

    it('filters by role when provided', async () => {
      req.query = { q: '', role: 'supplier' };

      await controller.searchUsers(req, res, next);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roles: { has: 'supplier' },
          }),
        })
      );
    });

    it('optimizes photoURL through cloudinary', async () => {
      const users = [{ id: 'u1', name: 'User', email: 'u@t.com', photoURL: 'photo.jpg', roles: ['customer'] }];
      prisma.user.findMany.mockResolvedValue(users);

      await controller.searchUsers(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.users[0].photoURL).toBe('https://cdn.example.com/64/photo.jpg');
    });
  });

  // ============================
  // getMe
  // ============================
  describe('getMe', () => {
    it('returns the authenticated admin profile', async () => {
      const user = {
        id: 'admin-1',
        name: 'Admin User',
        email: 'admin@test.com',
        photoURL: 'avatar.jpg',
        roles: ['admin'],
        adminRoleId: 'role-1',
        adminRole: { id: 'role-1', name: 'Super Admin' },
      };
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.adminRole.findUnique.mockResolvedValue({
        id: 'role-1',
        name: 'Super Admin',
        permissions: [{ permission: { key: 'dashboard.*' } }],
      });

      await controller.getMe(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: 'admin-1',
            name: 'Admin User',
            photoURL: 'https://cdn.example.com/80/avatar.jpg',
          }),
        })
      );
    });

    it('queries by req.user.id', async () => {
      await controller.getMe(req, res, next);

      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-1' },
        })
      );
    });
  });
});
