/**
 * The Performance page's period model.
 *
 * The page this replaces mixed an all-time payout with a month-on-month delta
 * and a 90-day booking count on one row. These tests pin the rule that makes
 * that impossible: every figure resolves through one window, and its delta
 * compares the same-length window immediately before it.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findMany: jest.fn() },
  tour: { findMany: jest.fn(), findFirst: jest.fn() },
  supplierProfile: { findUnique: jest.fn() },
  review: { count: jest.fn() },
}));
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

const prisma = require('../../src/core/services/prismaClient');
const controller = require('../../src/core/domain/supplierController');

const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

async function invoke(handler, query = {}, params = {}) {
  const req = { supplierId: 'supplier-1', user: { id: 'user-1' }, query, params };
  const res = makeRes();
  const next = jest.fn();
  await handler(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0].data;
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.supplierProfile.findUnique.mockResolvedValue({ averageRating: 4.6 });
  prisma.review.count.mockImplementation(({ where }) => Promise.resolve(where.rating ? 4 : 50));
  prisma.tour.findMany.mockResolvedValue([]);
});

describe('getAnalyticsSummary', () => {
  beforeEach(() => {
    prisma.booking.findMany.mockImplementation(({ where }) => {
      if (where.paymentStatus === 'SUCCEEDED') {
        return Promise.resolve([
          { grossAmount: 1000, supplierPayout: 850, paidAt: daysAgo(1) },
          { grossAmount: 500, supplierPayout: 425, paidAt: daysAgo(45) },
        ]);
      }
      return Promise.resolve([
        { status: 'CONFIRMED', createdAt: daysAgo(2) },
        { status: 'PENDING', createdAt: daysAgo(3) },
        { status: 'CONFIRMED', createdAt: daysAgo(40) },
      ]);
    });
  });

  it('splits revenue and bookings into the current and previous window', async () => {
    const data = await invoke(controller.getAnalyticsSummary, { period: '30d' });

    expect(data.period.key).toBe('30d');
    expect(data.revenue.gross).toBe(1000);
    expect(data.revenue.payout).toBe(850);
    expect(data.revenue.previousGross).toBe(500);
    expect(data.revenue.previousPayout).toBe(425);
    expect(data.bookings.total).toBe(2);
    expect(data.bookings.previousTotal).toBe(1);
    expect(data.bookings.confirmed).toBe(1);
    expect(data.bookings.pending).toBe(1);
  });

  it('bases average booking value on paid bookings, not every booking', async () => {
    const data = await invoke(controller.getAnalyticsSummary, { period: '30d' });

    // $1,000 paid on one booking, while two bookings were created.
    expect(data.bookings.paid).toBe(1);
    expect(data.bookings.avgValue).toBe(1000);
  });

  it('reports rating with its review count and low-rating share', async () => {
    const data = await invoke(controller.getAnalyticsSummary, { period: '30d' });

    expect(data.rating).toEqual({ average: 4.6, count: 50, lowShare: 8 });
  });

  it('falls back to 30 days for an unknown period', async () => {
    const data = await invoke(controller.getAnalyticsSummary, { period: 'yesterday' });
    expect(data.period.key).toBe('30d');
  });
});

describe('getAnalyticsTimeseries', () => {
  it('draws 30 daily buckets for a 30 day window', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    const data = await invoke(controller.getAnalyticsTimeseries, { period: '30d' });

    expect(data.granularity).toBe('day');
    expect(data.buckets).toHaveLength(30);
    expect(data.previous).toHaveLength(30);
  });

  it('draws 12 monthly buckets for a year', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { createdAt: daysAgo(1), paidAt: daysAgo(1), grossAmount: 300, paymentStatus: 'SUCCEEDED' },
    ]);
    const data = await invoke(controller.getAnalyticsTimeseries, { period: '12m' });

    expect(data.granularity).toBe('month');
    expect(data.buckets).toHaveLength(12);
    expect(data.previous).toHaveLength(12);
    expect(data.buckets.reduce((sum, bucket) => sum + bucket.revenue, 0)).toBe(300);
  });

  it('buckets revenue by paid date and bookings by creation date', async () => {
    // Paid yesterday for a booking created 200 days ago: the money belongs to
    // this window, the booking does not.
    prisma.booking.findMany.mockResolvedValue([
      { createdAt: daysAgo(200), paidAt: daysAgo(1), grossAmount: 900, paymentStatus: 'SUCCEEDED' },
    ]);
    const data = await invoke(controller.getAnalyticsTimeseries, { period: '30d' });

    expect(data.buckets.reduce((sum, bucket) => sum + bucket.revenue, 0)).toBe(900);
    expect(data.buckets.reduce((sum, bucket) => sum + bucket.bookings, 0)).toBe(0);
  });
});

describe('getProductAnalytics', () => {
  it('filters by the selected period and only counts paid revenue', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { tourId: 't1', grossAmount: 100, supplierPayout: 80, paymentStatus: 'SUCCEEDED' },
      { tourId: 't1', grossAmount: 400, supplierPayout: 320, paymentStatus: 'PENDING' },
    ]);
    prisma.tour.findMany.mockResolvedValue([
      { id: 't1', title: 'Cape Coast Castle', coverPhoto: null, averageRating: 4.7 },
    ]);

    const data = await invoke(controller.getProductAnalytics, { period: '90d' });

    expect(prisma.booking.findMany.mock.calls[0][0].where.createdAt).toEqual({
      gte: expect.any(Date),
      lte: expect.any(Date),
    });
    expect(data.products[0]).toMatchObject({
      tourId: 't1',
      bookings: 2,
      revenue: 100,
      payout: 80,
    });
  });
});

describe('getProductPerformance', () => {
  const paid = { grossAmount: 1000, supplierPayout: 800, paidAt: daysAgo(1), status: 'CONFIRMED', createdAt: daysAgo(6), travelDate: daysAgo(-4), paymentStatus: 'SUCCEEDED' };
  const previousPaid = { grossAmount: 500, supplierPayout: 400, paidAt: daysAgo(45), status: 'CONFIRMED', createdAt: daysAgo(50), travelDate: daysAgo(40) };
  const cancelled = {
    id: 'b-cancelled',
    grossAmount: 200,
    supplierPayout: 160,
    paidAt: daysAgo(8),
    createdAt: daysAgo(20),
    travelDate: daysAgo(1),
    cancelledAt: daysAgo(2),
    status: 'CANCELLED',
    cancellationOrigin: 'SUPPLIER',
    cancellationCode: 'VEHICLE_BREAKDOWN',
    countsTowardRate: true,
    paymentStatus: 'SUCCEEDED',
  };

  it('refuses a tour that is not the supplier’s', async () => {
    prisma.tour.findFirst.mockResolvedValue(null);
    const res = makeRes();
    const next = jest.fn();

    await controller.getProductPerformance(
      { supplierId: 'supplier-1', params: { tourId: 'other' }, query: { period: '30d' } },
      res,
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('returns revenue, the booking window and cancellations for one product', async () => {
    prisma.tour.findFirst.mockResolvedValue({
      id: 't1', title: 'Shai Hills Safari', coverPhoto: null, averageRating: 4.5,
    });
    prisma.review.count.mockImplementation(({ where }) => Promise.resolve(where.rating ? 1 : 10));
    prisma.booking.findMany.mockResolvedValue([paid, previousPaid, cancelled]);

    const data = await invoke(controller.getProductPerformance, { period: '30d' }, { tourId: 't1' });

    expect(data.product).toMatchObject({ id: 't1', name: 'Shai Hills Safari' });
    expect(data.revenue).toMatchObject({ gross: 1200, payout: 960, paid: 2, previousGross: 500 });
    expect(data.bookings.total).toBe(2); // created inside the window: paid + cancelled
    expect(data.bookings.leadTime.averageDays).toBeGreaterThan(0);
    expect(data.bookings.leadTime.distribution.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);
    expect(data.cancellations).toMatchObject({
      total: 1,
      supplierCaused: 1,
      atRisk: 1,
      rate: 100,
      lostValue: 200,
    });
    expect(data.series.buckets).toHaveLength(30);
    expect(data.series.previous).toHaveLength(30);
  });

  it('scopes the series to the product and buckets paid money by paid date', async () => {
    prisma.tour.findFirst.mockResolvedValue({
      id: 't1', title: 'Shai Hills Safari', coverPhoto: null, averageRating: 4.5,
    });
    prisma.booking.findMany.mockResolvedValue([paid]);
    prisma.review.count.mockResolvedValue(0);

    const data = await invoke(controller.getProductPerformance, { period: '30d' }, { tourId: 't1' });

    expect(prisma.booking.findMany.mock.calls[0][0].where.tourId).toBe('t1');
    expect(data.series.buckets.reduce((sum, bucket) => sum + bucket.revenue, 0)).toBe(1000);
  });
});
