/**
 * Supplier cancellation rate — GetYourGuide alignment.
 *
 * The rate is measured over the last N days by *date of cancellation*, and
 * the denominator is the set of bookings that were actually at risk in that
 * window: bookings that travelled plus cancellations made in the window.
 * Future travel dates must not dilute the rate, and a supplier cancellation
 * can never exceed 100% of eligible bookings.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findMany: jest.fn(), count: jest.fn() },
  notification: { findFirst: jest.fn() },
}));
jest.mock('../../src/core/services/queue', () => ({ enqueueNotification: jest.fn() }));

const prisma = require('../../src/core/services/prismaClient');
const controller = require('../../src/core/domain/cancellationController');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const daysAhead = (n) => new Date(Date.now() + n * DAY);

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function summaryOf(res) {
  return res.json.mock.calls[0][0].data;
}

function booking(overrides = {}) {
  return {
    id: `b-${Math.random().toString(36).slice(2)}`,
    status: 'COMPLETED',
    cancellationReason: null,
    cancellationCode: null,
    cancellationCategory: null,
    cancellationOrigin: null,
    countsTowardRate: null,
    cancelledAt: null,
    grossAmount: 100,
    travelDate: daysAgo(1),
    ...overrides,
  };
}

function supplierCancel(overrides = {}) {
  return booking({
    status: 'CANCELLED',
    cancellationOrigin: 'SUPPLIER',
    countsTowardRate: true,
    cancellationCode: 'GUIDE_UNAVAILABLE',
    cancelledAt: daysAgo(2),
    ...overrides,
  });
}

function customerCancel(overrides = {}) {
  return booking({
    status: 'CANCELLED',
    cancellationOrigin: 'CUSTOMER',
    countsTowardRate: false,
    cancellationCode: 'CUSTOMER_REQUESTED_CANCEL',
    cancelledAt: daysAgo(2),
    ...overrides,
  });
}

async function summary(bookings, query = {}) {
  prisma.booking.findMany.mockResolvedValue(bookings);
  const req = { user: { id: 'supplier-1' }, query: { days: 30, ...query } };
  const res = makeRes();
  await controller.getCancellationSummary(req, res);
  return summaryOf(res);
}

describe('getStatus — GetYourGuide bands', () => {
  it('waives the rating below 10 eligible bookings', () => {
    expect(controller.getStatus(50, 9)).toBe('Building performance record');
  });

  it('treats 1% as the pass mark', () => {
    expect(controller.getStatus(0, 10)).toBe('Excellent');
    expect(controller.getStatus(1, 10)).toBe('Excellent');
  });

  it('never labels 1–2% as healthy', () => {
    expect(controller.getStatus(1.1, 10)).toBe('Above standard');
    expect(controller.getStatus(2, 10)).toBe('Above standard');
  });

  it('separates at-risk from high', () => {
    expect(controller.getStatus(2.1, 10)).toBe('At risk');
    expect(controller.getStatus(5, 10)).toBe('At risk');
    expect(controller.getStatus(5.1, 10)).toBe('High');
  });
});

describe('getCancellationSummary — window and denominator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.count.mockResolvedValue(0);
  });

  it('excludes future travel dates from the denominator', async () => {
    // The live 30-day card used to show 56 bookings because five future
    // confirmations were counted alongside 40 completed and 11 cancelled.
    const bookings = [
      ...Array.from({ length: 40 }, () => booking({ status: 'COMPLETED' })),
      ...Array.from({ length: 5 }, () => booking({ status: 'CONFIRMED', travelDate: daysAhead(20) })),
      ...Array.from({ length: 11 }, () => customerCancel({ travelDate: daysAgo(3) })),
    ];

    prisma.booking.count.mockResolvedValue(5);
    const data = await summary(bookings);

    expect(data.eligibleBookings).toBe(51);
    expect(data.confirmed).toBe(0);
    expect(data.upcomingConfirmed).toBe(5);
    expect(data.completed).toBe(40);
    expect(data.cancelled).toBe(11);
    expect(data.supplierCausedCount).toBe(0);
    expect(data.excludedCancellations).toBe(11);
    expect(data.cancellationRate).toBe(0);
  });

  it('counts a supplier cancellation by cancellation date, even when the travel date is outside the window', async () => {
    const bookings = [
      supplierCancel({ travelDate: daysAgo(120), cancelledAt: daysAgo(5) }),
      ...Array.from({ length: 9 }, () => booking({ status: 'COMPLETED' })),
    ];

    const data = await summary(bookings);

    expect(data.supplierCausedCount).toBe(1);
    expect(data.eligibleBookings).toBe(10);
    expect(data.cancellationRate).toBe(10);
    expect(data.status).toBe('High');
  });

  it('counts a cancellation made ahead of a future travel date without exceeding 100%', async () => {
    const bookings = [supplierCancel({ travelDate: daysAhead(30), cancelledAt: daysAgo(1) })];

    const data = await summary(bookings);

    expect(data.supplierCausedCount).toBe(1);
    expect(data.eligibleBookings).toBe(1);
    expect(data.cancellationRate).toBe(100);
  });

  it('falls back to the travel date for legacy rows with no cancellation timestamp', async () => {
    const bookings = [
      supplierCancel({ cancelledAt: null, travelDate: daysAgo(4) }),
      ...Array.from({ length: 9 }, () => booking({ status: 'COMPLETED' })),
    ];

    const data = await summary(bookings);

    expect(data.supplierCausedCount).toBe(1);
    expect(data.eligibleBookings).toBe(10);
    expect(data.cancellationRate).toBe(10);
  });

  it('does not re-count a cancellation made before the window just because it travelled inside it', async () => {
    const bookings = [
      supplierCancel({ cancelledAt: daysAgo(45), travelDate: daysAgo(10) }),
      ...Array.from({ length: 10 }, () => booking({ status: 'COMPLETED' })),
    ];

    const data = await summary(bookings);

    // The cancellation belongs to the previous window; the travel slot is
    // not an at-risk booking either because it never travelled.
    expect(data.supplierCausedCount).toBe(0);
    expect(data.cancelled).toBe(0);
    expect(data.eligibleBookings).toBe(10);
    expect(data.cancellationRate).toBe(0);
  });

  it('returns the window it measured so the UI can label it', async () => {
    const data = await summary([booking()]);

    expect(data.days).toBe(30);
    expect(new Date(data.windowEnd).getTime()).toBeGreaterThan(new Date(data.windowStart).getTime());
    expect(new Date(data.windowEnd).getTime() - new Date(data.windowStart).getTime())
      .toBeGreaterThanOrEqual(29 * DAY);
  });

  it('queries both travel-window and cancellation-window bookings, with an upper bound on travel', async () => {
    await summary([booking()]);

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { travelDate: { gte: expect.any(Date), lte: expect.any(Date) } },
      { cancelledAt: { gte: expect.any(Date), lte: expect.any(Date) } },
    ]);
  });
});

describe('getCancellationRecords — same window as the summary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters by cancellation date and exposes cancelledOn', async () => {
    prisma.booking.findMany.mockResolvedValue([
      {
        id: 'r-1',
        status: 'CANCELLED',
        travelDate: daysAgo(2),
        cancelledAt: daysAgo(1),
        cancellationReason: 'Guide unavailable',
        cancellationCode: null,
        cancellationCategory: null,
        cancellationOrigin: 'SUPPLIER',
        countsTowardRate: null,
        cancellationNote: null,
        cancellationFee: null,
        refundStatus: null,
        bookingNumber: 'TRG-1',
        refundAmount: null,
        grossAmount: 250,
        tour: { id: 't-1', title: 'Shai Hills Safari' },
      },
    ]);

    const req = { user: { id: 'supplier-1' }, query: { days: 30 } };
    const res = makeRes();
    await controller.getCancellationRecords(req, res);

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.OR[0]).toEqual({ cancelledAt: { gte: expect.any(Date), lte: expect.any(Date) } });
    expect(where.OR[1]).toEqual({
      cancelledAt: null,
      travelDate: { gte: expect.any(Date), lte: expect.any(Date) },
    });

    const record = res.json.mock.calls[0][0].data.records[0];
    expect(record.cancelledOn).toBe(daysAgo(1).toISOString().split('T')[0]);
    // Resolved through the same predicate as the headline, so a legacy row
    // can no longer show "—" while still affecting the rate.
    expect(record.countsTowardRate).toBe(true);
  });

  it('orders records by cancellation date, newest first', async () => {
    const mk = (id, cancelledAt) => ({
      id,
      status: 'CANCELLED',
      travelDate: daysAgo(1),
      cancelledAt,
      cancellationReason: 'Changed plans',
      cancellationCode: null,
      cancellationCategory: null,
      cancellationOrigin: 'CUSTOMER',
      countsTowardRate: false,
      cancellationNote: null,
      cancellationFee: null,
      refundStatus: null,
      bookingNumber: id,
      refundAmount: null,
      grossAmount: 100,
      tour: { id: 't-1', title: 'Tour' },
    });

    prisma.booking.findMany.mockResolvedValue([
      mk('older', daysAgo(10)),
      mk('newer', daysAgo(1)),
      mk('middle', daysAgo(5)),
    ]);

    const req = { user: { id: 'supplier-1' }, query: { days: 30 } };
    const res = makeRes();
    await controller.getCancellationRecords(req, res);

    expect(res.json.mock.calls[0][0].data.records.map((r) => r.id)).toEqual([
      'newer',
      'middle',
      'older',
    ]);
  });
});
