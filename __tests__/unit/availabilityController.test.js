const { startOfDay, endOfDay, parseISO, addDays, format } = require('date-fns');

jest.mock('../../utils/prismaClient', () => ({
  tour: { findFirst: jest.fn() },
  tourDateOverride: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  booking: { findMany: jest.fn(), count: jest.fn() },
}));

jest.mock('../../utils/getConfig', () => jest.fn().mockResolvedValue('50'));

const prisma = require('../../utils/prismaClient');
const getConfig = require('../../utils/getConfig');
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
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'u-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    prisma.tour.findFirst.mockResolvedValue(mockTour);
    prisma.tourDateOverride.findMany.mockResolvedValue([]);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.count.mockResolvedValue(0);
    prisma.tourDateOverride.upsert.mockResolvedValue({ id: 'ov-1', date: new Date(), status: 'AVAILABLE' });
    prisma.tourDateOverride.deleteMany.mockResolvedValue({ count: 1 });
    getConfig.mockResolvedValue('50');
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
      req.query = { startDate: '2026-06-15', endDate: '2026-06-17' };
      await controller.getAvailability(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar).toHaveLength(3);
      expect(body.data.calendar[0]).toHaveProperty('date');
      expect(body.data.calendar[0]).toHaveProperty('status');
      expect(body.data.calendar[0]).toHaveProperty('timeSlots');
    });

    it('populates time slots from template', async () => {
      req.query = { startDate: '2026-06-15', endDate: '2026-06-15' };
      await controller.getAvailability(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar[0].timeSlots).toHaveLength(2);
    });

    it('uses override time slots when present', async () => {
      req.query = { startDate: '2026-06-15', endDate: '2026-06-15' };
      prisma.tourDateOverride.findMany.mockResolvedValue([
        { date: parseISO('2026-06-15'), status: 'LIMITED', capacity: 10, timeSlotOverrides: [{ time: '09:00', capacity: 10, booked: 2 }], notes: null },
      ]);

      await controller.getAvailability(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar[0].timeSlots).toEqual([{ time: '09:00', capacity: 10, booked: 2 }]);
    });

    it('uses override capacity when present', async () => {
      req.query = { startDate: '2026-06-15', endDate: '2026-06-15' };
      prisma.tourDateOverride.findMany.mockResolvedValue([
        { date: parseISO('2026-06-15'), status: 'AVAILABLE', capacity: 5, timeSlotOverrides: null, notes: null },
      ]);

      await controller.getAvailability(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar[0].capacity).toBe(5);
    });

    it('parses schedulesAndPricing JSON string', async () => {
      req.query = { startDate: '2026-06-15', endDate: '2026-06-15' };
      prisma.tour.findFirst.mockResolvedValue({ ...mockTour, schedulesAndPricing: JSON.stringify(mockTour.schedulesAndPricing) });

      await controller.getAvailability(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handles empty daysOfWeek (all days active)', async () => {
      req.query = { startDate: '2026-06-15', endDate: '2026-06-15' };
      prisma.tour.findFirst.mockResolvedValue({
        ...mockTour,
        schedulesAndPricing: { ...mockTour.schedulesAndPricing, availability: { daysOfWeek: [], timeSlots: ['10:00'] } },
      });

      await controller.getAvailability(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.calendar[0].isOperatingDay).toBe(true);
    });

    it('marks non-operating days as BLOCKED', async () => {
      req.query = { startDate: '2026-06-14', endDate: '2026-06-14' };
      const sunday = new Date('2026-06-14');
      expect(sunday.getDay()).toBe(0);

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
      req.params = { tourId: 'nonexistent', date: '2026-06-15' };
      prisma.tour.findFirst.mockResolvedValue(null);
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 for invalid status', async () => {
      req.params = { tourId: 't1', date: '2026-06-15' };
      req.body = { status: 'INVALID' };
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 for negative capacity', async () => {
      req.params = { tourId: 't1', date: '2026-06-15' };
      req.body = { capacity: -1 };
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 when capacity lower than existing bookings', async () => {
      req.params = { tourId: 't1', date: '2026-06-15' };
      req.body = { capacity: 2 };
      prisma.booking.count.mockResolvedValue(5);
      await controller.updateDateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('upserts override with all fields', async () => {
      req.params = { tourId: 't1', date: '2026-06-15' };
      req.body = { status: 'LIMITED', capacity: 15, timeSlotOverrides: [{ time: '10:00', capacity: 10 }], notes: 'Testing' };

      await controller.updateDateAvailability(req, res, next);

      expect(prisma.tourDateOverride.upsert).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('upserts override with minimal fields', async () => {
      req.params = { tourId: 't1', date: '2026-06-15' };
      req.body = {};

      await controller.updateDateAvailability(req, res, next);

      expect(prisma.tourDateOverride.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: 'AVAILABLE' }),
        })
      );
    });

    it('sets capacity null when not provided', async () => {
      req.params = { tourId: 't1', date: '2026-06-15' };
      req.body = { status: 'FULL' };

      await controller.updateDateAvailability(req, res, next);

      expect(prisma.tourDateOverride.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ capacity: null }),
        })
      );
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
      req.params = { tourId: 'nonexistent', date: '2026-06-15' };
      prisma.tour.findFirst.mockResolvedValue(null);
      await controller.removeDateOverride(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('removes override and returns success', async () => {
      req.params = { tourId: 't1', date: '2026-06-15' };

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
      req.body = { updates: Array.from({ length: 366 }, (_, i) => ({ date: '2026-01-01' })) };
      await controller.batchUpdateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when tour not found', async () => {
      req.params = { tourId: 'nonexistent' };
      req.body = { updates: [{ date: '2026-06-15' }] };
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
      req.body = { updates: [{ date: '2026-06-15', status: 'INVALID' }] };
      await controller.batchUpdateAvailability(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('processes batch updates and returns results', async () => {
      req.params = { tourId: 't1' };
      req.body = {
        updates: [
          { date: '2026-06-15', status: 'FULL' },
          { date: '2026-06-16', status: 'LIMITED', capacity: 10 },
        ],
      };

      await controller.batchUpdateAvailability(req, res, next);

      expect(prisma.tourDateOverride.upsert).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.count).toBe(2);
    });
  });
});
