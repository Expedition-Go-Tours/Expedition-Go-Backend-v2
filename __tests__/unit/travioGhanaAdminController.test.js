jest.mock('../../src/core/services/prismaClient', () => ({
  tour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn() },
  user: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  booking: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn() },
  supplierProfile: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  travioGhanaTour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn() },
  travioAfricaTour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn() },
  expeditionTour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  review: { findMany: jest.fn(), count: jest.fn() },
  event: { findMany: jest.fn(), count: jest.fn() },
  notification: { findMany: jest.fn(), count: jest.fn(), updateMany: jest.fn() },
  $queryRaw: jest.fn().mockResolvedValue([]),
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
  invalidateTourCaches: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));

const ghanaAdmin = require('../../src/brands/ghana/adminController');
const africaAdmin = require('../../src/brands/africa/adminController');
const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');
const { enqueueNotification } = require('../../src/core/services/queue');

const EXPECTED_FUNCTIONS = [
  'getOverview', 'getRevenueTrend', 'getTourPerformance', 'getUserGrowth', 'getFunnel', 'getCLV',
  'getSearchAnalytics', 'getCartAbandonment', 'getTours', 'getTourDetail', 'updateTour', 'deleteTour',
  'getTourReviewQueue', 'reviewTour', 'searchTours', 'getBookings', 'getTodayBookings', 'getBookingById',
  'confirmPayment', 'getSuppliers', 'getSupplierDetail', 'suspendSupplier', 'activateSupplier',
  'getActiveUsers', 'getRecentSignups', 'searchUsers', 'getAiStatus', 'getFailedTours', 'getPendingReviews',
  'moderateReview', 'getMe', 'getNotifications', 'getUnreadCount', 'getNotificationStats',
  'acknowledgeNotification', 'acknowledgeAllNotifications',
];

describe('admin controller brand factory (Phase 2b)', () => {
  it('Ghana admin exports all 36 functions + makeAdminController', () => {
    for (const name of EXPECTED_FUNCTIONS) expect(typeof ghanaAdmin[name]).toBe('function');
    expect(typeof ghanaAdmin.makeAdminController).toBe('function');
  });

  it('Africa admin exports the same 36 functions (reuses the factory)', () => {
    for (const name of EXPECTED_FUNCTIONS) expect(typeof africaAdmin[name]).toBe('function');
    expect(Object.keys(africaAdmin)).toHaveLength(36);
  });

  it('factory produces distinct brand instances (ghana vs africa)', () => {
    const ghana = ghanaAdmin.makeAdminController('ghana');
    const africa = ghanaAdmin.makeAdminController('africa');
    expect(ghana).not.toBe(africa);
    for (const name of EXPECTED_FUNCTIONS) expect(typeof ghana[name]).toBe('function');
  });
});

describe('reviewTour (brand-scoped) — supplier notification', () => {
  const TOUR_RECORD = {
    tourId: 'tour-1',
    id: 'listing-1',
    tour: { id: 'tour-1', title: 'Akosomobo Tour', slug: 'akosomobo-tour', supplierId: 'supplier-1' },
  };

  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.travioGhanaTour.findFirst.mockResolvedValue(TOUR_RECORD);
    prisma.tour.update.mockResolvedValue({ id: 'tour-1', slug: 'akosomobo-tour' });
    req = {
      params: { id: 'listing-1' },
      body: { action: 'approve' },
      user: { id: 'admin-1' },
    };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  it('approve → enqueues TOUR_APPROVED to the tour supplier', async () => {
    await ghanaAdmin.reviewTour(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.tour.update).toHaveBeenCalledWith({
      where: { id: 'tour-1' },
      data: { status: 'ACTIVE', reviewedBy: 'admin-1', reviewedAt: expect.any(Date), reviewNote: null },
    });
    expect(cache.invalidateTourCaches).toHaveBeenCalledWith('tour-1', 'akosomobo-tour');
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'supplier-1',
      type: 'TOUR_APPROVED',
      title: 'Tour Approved',
      message: expect.stringContaining('Akosomobo Tour'),
      data: expect.objectContaining({ tourId: 'tour-1', status: 'ACTIVE', reason: null }),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('flag → enqueues TOUR_FLAGGED with the reason and stores reviewNote', async () => {
    req.body = { action: 'flag', reason: 'Photos are blurry' };

    await ghanaAdmin.reviewTour(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.tour.update).toHaveBeenCalledWith({
      where: { id: 'tour-1' },
      data: { status: 'REJECTED', reviewedBy: 'admin-1', reviewedAt: expect.any(Date), reviewNote: 'Photos are blurry' },
    });
    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'supplier-1',
      type: 'TOUR_FLAGGED',
      title: 'Tour Needs Changes',
      message: expect.stringContaining('Photos are blurry'),
      data: expect.objectContaining({ tourId: 'tour-1', status: 'REJECTED', reason: 'Photos are blurry' }),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('notification failure never fails the approval', async () => {
    enqueueNotification.mockRejectedValueOnce(new Error('redis down'));

    await ghanaAdmin.reviewTour(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
