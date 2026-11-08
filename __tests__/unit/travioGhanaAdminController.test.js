jest.mock('../../src/core/services/prismaClient', () => ({
  tour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn() },
  user: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  booking: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), groupBy: jest.fn(), update: jest.fn() },
  supplierProfile: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  travioGhanaTour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn() },
  travioAfricaTour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn() },
  expeditionTour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  review: { findMany: jest.fn(), count: jest.fn() },
  event: { findMany: jest.fn(), count: jest.fn() },
  auditLog: { findMany: jest.fn().mockResolvedValue([]) },
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
  'getOverview', 'getActivityFeed', 'getRevenueTrend', 'getTourPerformance', 'getUserGrowth', 'getFunnel', 'getCLV',
  'getGuestClaimAnalytics',
  'getSearchAnalytics', 'getTours', 'getTourDetail', 'updateTour', 'deleteTour',
  'getTourReviewQueue', 'reviewTour', 'searchTours', 'getBookings', 'getTodayBookings', 'getBookingById',
  'confirmPayment', 'getSuppliers', 'getSupplierDetail', 'suspendSupplier', 'activateSupplier',
  'getActiveUsers', 'getRecentSignups', 'searchUsers', 'getAiStatus', 'getFailedTours', 'getPendingReviews',
  'moderateReview', 'getMe', 'getNotifications', 'getUnreadCount', 'getNotificationStats',
  'acknowledgeNotification', 'acknowledgeAllNotifications',
];

describe('admin controller brand factory (Phase 2b)', () => {
  it('Ghana admin exports all 37 functions + makeAdminController', () => {
    for (const name of EXPECTED_FUNCTIONS) expect(typeof ghanaAdmin[name]).toBe('function');
    expect(typeof ghanaAdmin.makeAdminController).toBe('function');
  });

  it('Africa admin exports the same 37 functions (reuses the factory)', () => {
    for (const name of EXPECTED_FUNCTIONS) expect(typeof africaAdmin[name]).toBe('function');
    expect(Object.keys(africaAdmin)).toHaveLength(37);
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

describe('getBookings — payment source filter', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.count.mockResolvedValue(0);
    prisma.booking.groupBy.mockResolvedValue([]);
    req = { query: {}, params: {}, body: {}, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
  });

  it('passes a normalised provider through to the query', async () => {
    req.query = { paymentProvider: 'paypal' };

    await ghanaAdmin.getBookings(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paymentProvider: 'PAYPAL' }),
      }),
    );
  });

  it('rejects an unknown provider before touching the database', async () => {
    req.query = { paymentProvider: 'CASH' };

    await ghanaAdmin.getBookings(req, res, next);

    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('active users — tile and list answer the same question', () => {
  let req;
  let res;
  let next;
  let captured;

  const userAggRow = [{
    activeToday: 5,
    activePrevious: 2,
    signupsToday: 1,
    signupsYesterday: 0,
    signupsWeek: 2,
    signupsMonth: 3,
    signupsYtd: 9,
    totalEvents: 40,
  }];

  // The overview runs several raw queries in parallel; the active-users one is
  // identified by the fragment only the new definition produces, so the test
  // does not depend on which of them settles first.
  //
  // `$queryRaw` is a tagged template, so without the real client the mock gets
  // the raw arguments: a strings array plus its values, where an interpolated
  // `Prisma.sql` fragment is still a nested Sql rather than being spliced in.
  // Render both layers back into one readable statement.
  const renderRaw = (args) => {
    const text = [String(args[0] || '')]
      .concat(args.slice(1).map((value) => {
        if (value && typeof value.text === 'string') return value.text;
        if (Array.isArray(value?.strings)) return value.strings.join('');
        return '';
      }))
      .join(' ');
    const values = args.slice(1).flatMap((value) =>
      (value && Array.isArray(value.values)) ? value.values : [value],
    );
    return { text, values };
  };

  const mockRaw = (activeRow = []) => {
    prisma.$queryRaw.mockImplementation((...args) => {
      const rendered = renderRaw(args);
      if (rendered.text.includes('active_accounts')) {
        captured.push(rendered);
        return Promise.resolve(activeRow);
      }
      return Promise.resolve([]);
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    captured = [];
    prisma.auditLog = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.user.findMany.mockResolvedValue([]);
    prisma.event.findMany.mockResolvedValue([]);
    req = { query: { period: 'this_month', tzOffsetMinutes: '0' }, params: {}, body: {}, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
  });

  it('counts accounts that signed in or acted on this storefront, not logins alone', async () => {
    mockRaw(userAggRow);

    await ghanaAdmin.getOverview(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const overview = res.json.mock.calls[0][0].data.overview;
    expect(overview.activeUsers).toBe(5);
    expect(overview.activeUsersPrevious).toBe(2);

    const sql = captured[0];
    // Branch 1: a Ghana-role account that signed in inside the window.
    expect(sql.text).toContain('"lastLoginAt"');
    // Branch 2: brand-tagged events, with the Expedition roll-up and the
    // legacy name prefix for rows written before the brand column existed.
    expect(sql.values).toEqual(expect.arrayContaining(['ghana', 'expedition', 'ghana.%', 'expedition.%']));
    expect(sql.text).toContain('count(DISTINCT id)');
    // `Prisma.join` stringifies a Sql separator, so an object separator would
    // ship `[object Object]` straight into Postgres (caught only by running
    // the statement, not by looking at it).
    expect(sql.text).not.toContain('[object Object]');
  });

  it('gives the drill-down the same window as the tile', async () => {
    mockRaw([{ id: 'u1', lastActiveAt: new Date('2026-11-03T10:00:00.000Z') }]);
    prisma.user.findMany.mockResolvedValue([{
      id: 'u1',
      name: 'Expedition-Go Tours LTD',
      email: 'ops@expeditiongo.test',
      photoURL: null,
      roles: ['supplier', 'ghana'],
      lastLoginAt: new Date('2026-11-05T08:28:49.172Z'),
    }]);
    req.query = { period: 'last_month', tzOffsetMinutes: '0' };

    await ghanaAdmin.getActiveUsers(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const users = res.json.mock.calls[0][0].data.users;
    expect(users).toHaveLength(1);
    // The list shows when the person last did something, not last signed in.
    expect(users[0].lastActiveAt).toEqual(new Date('2026-11-03T10:00:00.000Z'));
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ active: true }),
    }));

    // `last_month` is a whole calendar month ending on the 1st, in the
    // viewer's timezone — the same bounds getOverview passes to the count.
    const [, start, end] = captured[0].values;
    expect(start).toBeInstanceOf(Date);
    expect(end).toBeInstanceOf(Date);
    expect(end.getDate()).toBe(1);
    const days = (end - start) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
  });

  it('returns nobody when the window is empty, without querying profiles', async () => {
    mockRaw([]);

    await ghanaAdmin.getActiveUsers(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.users).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe('getGuestClaimAnalytics — brand-scoped guest claims', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.booking.findMany.mockResolvedValue([]);
    req = { query: { period: '30d' }, params: {}, body: {}, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
  });

  it('counts guest vs claimed bookings and ignores claim logs for other brands', async () => {
    prisma.booking.count
      .mockResolvedValueOnce(10)   // guest bookings created in period
      .mockResolvedValueOnce(4)    // …of which claimed
      .mockResolvedValueOnce(30)   // account bookings created in period
      .mockResolvedValueOnce(50)   // guest bookings, lifetime
      .mockResolvedValueOnce(20)   // …of which claimed, lifetime
      .mockResolvedValueOnce(150); // account bookings, lifetime
    prisma.auditLog.findMany.mockResolvedValue([
      { resourceId: 'b1', createdAt: new Date('2026-11-05T00:00:00Z') },
      { resourceId: 'b1', createdAt: new Date('2026-11-06T00:00:00Z') }, // duplicate
      { resourceId: 'africa-booking', createdAt: new Date('2026-11-05T00:00:00Z') },
    ]);
    prisma.booking.findMany.mockResolvedValue([
      { id: 'b1', createdAt: new Date('2026-11-01T00:00:00Z') },
    ]);

    await ghanaAdmin.getGuestClaimAnalytics(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0].data;
    expect(body.guestBookings).toBe(10);
    expect(body.claimRate).toBe(40);
    expect(body.guestShare).toBe(25);
    expect(body.claimsInPeriod).toBe(1); // the other brand's claim is dropped
    expect(body.averageDaysToClaim).toBe(4);
    expect(body.lifetime.unclaimedGuestBookings).toBe(30);

    // Every count goes through the same Ghana booking filter as the rest of
    // the dashboard, so a walk-in or another brand's booking never leaks in.
    expect(prisma.booking.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ guestId: { not: null } }),
    });
  });
});
