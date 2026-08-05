const { parseISO, addDays, format } = require('date-fns');

jest.mock('../../utils/prismaClient', () => ({
  tour: { findFirst: jest.fn() },
  tourDateOverride: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  booking: { findMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../../utils/getConfig', () =>
  jest.fn(async (key) => {
    if (key === 'availability.limited_ratio') return '0.5';
    if (key === 'availability.full_ratio') return '1';
    return '50';
  })
);

// The calendar cache (availability:cal:{tourId}:*) would otherwise persist
// results across tests that reuse the same tour/date key with different DB
// mocks. Bypass caching entirely: always run the fetch function.
jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn(async (_key, fetchFn, _ttl) => fetchFn()),
  invalidateKeys: jest.fn().mockResolvedValue(undefined),
}));

const prisma = require('../../utils/prismaClient');
const controller = require('../../controllers/availabilityController');

describe('availabilityController', () => {
  let req, res, next;

const mockTour = {
  id: 't1',
  title: 'Test Tour',
  supplierId: 'u-1',
  schedulesAndPricing: {
    availability: {
      daysOfWeek: ['Monday', 'Wednesday', 'Friday'],
      timeSlots: ['10:00', '14:00'],
    },
    travelerDetails: {
      maxTravelersPerBooking: 20,
      maxParticipants: 10,
    },
  },
};

/** YYYY-MM-DD a few days from now — override writes reject past dates. */
const futureDate = (days = 30) => {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
};

/** Next occurrence of `weekday` (0=Sunday..6) from today — always future. */
const nextWeekday = (weekday) => {
  const today = new Date(Date.now() + 1 * 86400000);
  const diff = (weekday - today.getUTCDay() + 7) % 7;
  return format(addDays(today, diff), 'yyyy-MM-dd');
};

// Monday (1) and Wednesday (3) are operating days for mockTour; Sunday (0) is not.
const MON = nextWeekday(1);
const SUN = nextWeekday(0);

/**
 * Transaction mock used by the write endpoints. The tour lock query
 * (`SELECT id FROM ... FOR UPDATE`) returns a locked row; the live-bookings
 * aggregate returns the given traveler count.
 */
const makeTx = ({ hasTour = true, live = '0' } = {}) => ({
  $queryRawUnsafe: jest.fn().mockImplementation((query, ...args) => {
    if (query.includes('SELECT id FROM')) return hasTour ? [{ id: 't1' }] : [];
    if (query.includes('INSERT INTO "TourDateOverride"')) {
      // The bulk upsert derives one returned row per target date (arg $3).
      const dates = args[2] || [];
      return dates.map((d) => ({ id: `ov-${d}`, date: d, status: 'BLOCKED' }));
    }
    return [{ live }];
  }),
  tourDateOverride: { upsert: prisma.tourDateOverride.upsert },
});

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'u-1' }, supplierId: 'u-1' };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    prisma.tour.findFirst.mockResolvedValue(mockTour);
    prisma.tourDateOverride.findMany.mockResolvedValue([]);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.count.mockResolvedValue(0);
    prisma.tourDateOverride.upsert.mockResolvedValue({ id: 'ov-1', date: new Date(), status: 'AVAILABLE' });
    prisma.tourDateOverride.deleteMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(async (cb) => cb(makeTx()));
  });

  // ============================
  // computeAggregatedStatus (pure helper - tested through getAvailability)
  // ============================

  // ============================
  // getAvailability
  // ============================
  describe('getAvailability', () => {
    it('returns 400 when startDate or endDate missing', async () => {
      await controller.getAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 for invalid dates', async () => {
      req.query = { startDate: 'invalid', endDate: '2026-06-20' };
      await controller.getAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 when endDate before startDate', async () => {
      req.query = { startDate: '2026-06-20', endDate: '2026-06-15' };
      await controller.getAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 when range exceeds 366 days', async () => {
      req.query = { startDate: '2026-01-01', endDate: '2028-01-01' };
      await controller.getAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when tour not found', async () => {
      req.query = { startDate: '2026-06-15', endDate: '2026-06-20' };
      prisma.tour.findFirst.mockResolvedValue(null);
      await controller.getAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns availability calendar', async () => {
      req.query = { startDate: MON, endDate: format(addDays(parseISO(MON), 2), 'yyyy-MM-dd') };
      await controller.getAvailability(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar).toHaveLength(3);
      expect(body.data.calendar[0]).toHaveProperty('date');
      expect(body.data.calendar[0]).toHaveProperty('status');
      expect(body.data.calendar[0]).toHaveProperty('timeSlots');
    });

    it('populates time slots from template', async () => {
      req.query = { startDate: MON, endDate: MON };
      await controller.getAvailability(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar[0].timeSlots).toHaveLength(2);
    });

    it('uses override time slots when present', async () => {
      req.query = { startDate: MON, endDate: MON };
      prisma.tourDateOverride.findMany.mockResolvedValue([
        { date: parseISO(MON), status: 'LIMITED', capacity: 10, timeSlotOverrides: [{ time: '09:00', capacity: 10, booked: 2 }], notes: null },
      ]);

      await controller.getAvailability(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar[0].timeSlots).toEqual([{ time: '09:00', capacity: 10, booked: 0, remaining: 10 }]);
    });

    it('ignores override capacity and derives from builder max', async () => {
      req.query = { startDate: MON, endDate: MON };
      prisma.tourDateOverride.findMany.mockResolvedValue([
        { date: parseISO(MON), status: 'AVAILABLE', capacity: 5, timeSlotOverrides: null, notes: null },
      ]);

      await controller.getAvailability(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar[0].capacity).toBe(10);
      expect(body.data.calendar[0].status).toBe('AVAILABLE');
      expect(body.data.calendar[0].overrideStatus).toBe('AVAILABLE');
    });

    it('parses schedulesAndPricing JSON string', async () => {
      req.query = { startDate: MON, endDate: MON };
      prisma.tour.findFirst.mockResolvedValue({ ...mockTour, schedulesAndPricing: JSON.stringify(mockTour.schedulesAndPricing) });

      await controller.getAvailability(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handles empty daysOfWeek (all days active)', async () => {
      req.query = { startDate: MON, endDate: MON };
      prisma.tour.findFirst.mockResolvedValue({
        ...mockTour,
        schedulesAndPricing: { ...mockTour.schedulesAndPricing, availability: { daysOfWeek: [], timeSlots: ['10:00'] } },
      });

      await controller.getAvailability(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar[0].isOperatingDay).toBe(true);
    });

    it('marks non-operating days as BLOCKED', async () => {
      req.query = { startDate: SUN, endDate: SUN };
      const sunday = parseISO(SUN);
      expect(sunday.getUTCDay()).toBe(0);

      await controller.getAvailability(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar[0].status).toBe('BLOCKED');
    });
  });

  // ============================
  // updateDateAvailability
  // ============================
  describe('updateDateAvailability', () => {
    it('returns 400 for invalid date', async () => {
      req.params = { tourId: 't1', date: 'invalid' };
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when tour not found', async () => {
      req.params = { tourId: 'nonexistent', date: futureDate() };
      prisma.tour.findFirst.mockResolvedValue(null);
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 for invalid status', async () => {
      req.params = { tourId: 't1', date: futureDate() };
      req.body = { status: 'INVALID' };
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('rejects manual AVAILABLE/LIMITED/FULL statuses', async () => {
      for (const status of ['AVAILABLE', 'LIMITED', 'FULL']) {
        req.params = { tourId: 't1', date: futureDate() };
        req.body = { status };
        await controller.updateDateAvailability(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
        next.mockClear();
      }
    });

    it('returns 400 when blocking a date with live bookings', async () => {
      req.params = { tourId: 't1', date: futureDate() };
      req.body = { status: 'BLOCKED' };
      prisma.$transaction.mockImplementation(async (cb) => cb(makeTx({ live: '3' })));
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 for a past date', async () => {
      req.params = { tourId: 't1', date: '2020-01-01' };
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('rejects invalid time slot override entries', async () => {
      req.params = { tourId: 't1', date: futureDate() };
      req.body = { timeSlotOverrides: [{ time: '25:00', capacity: 10 }] };
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('upserts override with all fields', async () => {
      req.params = { tourId: 't1', date: futureDate() };
      req.body = { status: 'BLOCKED', timeSlotOverrides: [{ time: '10:00', capacity: 10 }], notes: 'Testing' };

      await controller.updateDateAvailability(req, res, next);

      expect(prisma.tourDateOverride.upsert).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('upserts override with minimal fields', async () => {
      req.params = { tourId: 't1', date: futureDate() };
      req.body = {};

      await controller.updateDateAvailability(req, res, next);

      expect(prisma.tourDateOverride.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: 'AVAILABLE' }),
        })
      );
    });

    it('creates an override without storing a capacity field', async () => {
      req.params = { tourId: 't1', date: futureDate() };
      req.body = { status: 'BLOCKED' };

      await controller.updateDateAvailability(req, res, next);

      expect(prisma.tourDateOverride.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: 'BLOCKED' }),
        })
      );
      const createArg = prisma.tourDateOverride.upsert.mock.calls[0][0].create;
      expect(createArg).not.toHaveProperty('capacity');
    });
  });

  // ============================
  // removeDateOverride
  // ============================
  describe('removeDateOverride', () => {
    it('returns 400 for invalid date', async () => {
      req.params = { tourId: 't1', date: 'invalid' };
      await controller.removeDateOverride(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when tour not found', async () => {
      req.params = { tourId: 'nonexistent', date: futureDate() };
      prisma.tour.findFirst.mockResolvedValue(null);
      await controller.removeDateOverride(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 for a past date', async () => {
      req.params = { tourId: 't1', date: '2020-01-01' };
      await controller.removeDateOverride(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('removes override and returns success', async () => {
      req.params = { tourId: 't1', date: futureDate() };

      await controller.removeDateOverride(req, res, next);

      expect(prisma.tourDateOverride.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tourId: 't1' }) })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // batchUpdateAvailability
  // ============================
  describe('batchUpdateAvailability', () => {
    it('returns 400 when updates is not a non-empty array', async () => {
      await controller.batchUpdateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 when updates exceeds 365', async () => {
      req.params = { tourId: 't1' };
      req.body = { updates: Array.from({ length: 366 }, () => ({ date: '2026-01-01' })) };
      await controller.batchUpdateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when tour not found', async () => {
      req.params = { tourId: 'nonexistent' };
      req.body = { updates: [{ date: futureDate() }] };
      prisma.tour.findFirst.mockResolvedValue(null);
      await controller.batchUpdateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 for invalid date format', async () => {
      req.params = { tourId: 't1' };
      req.body = { updates: [{ date: 'invalid' }] };
      await controller.batchUpdateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 for invalid status', async () => {
      req.params = { tourId: 't1' };
      req.body = { updates: [{ date: futureDate(), status: 'INVALID' }] };
      await controller.batchUpdateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 for a past date', async () => {
      req.params = { tourId: 't1' };
      req.body = { updates: [{ date: '2020-01-01', status: 'BLOCKED' }] };
      await controller.batchUpdateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('rejects non-BLOCKED statuses in batch', async () => {
      req.params = { tourId: 't1' };
      req.body = { updates: [{ date: futureDate(), status: 'FULL' }] };
      await controller.batchUpdateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('processes batch updates and returns results', async () => {
      req.params = { tourId: 't1' };
      req.body = {
        updates: [
          { date: futureDate(), status: 'BLOCKED' },
          { date: futureDate(31), status: 'BLOCKED' },
        ],
      };

      await controller.batchUpdateAvailability(req, res, next);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.count).toBe(2);
    });
  });
});
