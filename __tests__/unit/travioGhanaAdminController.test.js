jest.mock('../../utils/prismaClient', () => ({
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

jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));

const ghanaAdmin = require('../../controllers/travioGhanaAdminController');
const africaAdmin = require('../../controllers/travioAfricaAdminController');

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
