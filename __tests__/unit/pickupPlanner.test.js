/**
 * Pickup planner backend: derived state + counts + stop ordering + filters,
 * the reorder endpoint, and the "picked up" marker (which must not email the
 * customer).
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  supplierProfile: { findUnique: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/core/services/stripeHelpers', () => ({
  createPaymentIntent: jest.fn(),
  createRefund: jest.fn(),
  calculateCommission: jest.fn(),
  getStripe: jest.fn(),
  ensureStripeCustomer: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const { enqueueEmail, enqueueNotification } = require('../../src/core/services/queue');
const controller = require('../../src/core/domain/bookingController');

const mockReq = (overrides = {}) => ({
  user: { id: 'user-1' },
  supplierId: 'sup-1',
  body: {},
  params: {},
  query: {},
  headers: {},
  ...overrides,
});
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const next = jest.fn();

const day = (d) => new Date(`${d}T00:00:00.000Z`);

function makeBooking(over = {}) {
  return {
    id: over.id,
    bookingNumber: over.id,
    status: 'CONFIRMED',
    travelDate: over.travelDate || day('2026-10-01'),
    selectedTime: over.selectedTime ?? '09:00',
    pickup: over.pickup,
    pickupOrder: over.pickupOrder ?? null,
    pickedUpAt: over.pickedUpAt ?? null,
    customer: { id: 'c1', name: 'Ann', email: 'a@b.c', phone: '0244', photoURL: null },
    tour: { id: 't1', title: 'City Tour', photos: [], bookingAndTickets: '{}' },
  };
}

const complete = { place: 'Kempinski Hotel', time: '08:00', instructions: 'Lobby' };
const missingInstructions = { place: 'Kempinski Hotel', time: '08:00' };
const deferred = { pickupLater: true };

describe('getPickupPlanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.supplierProfile.findUnique.mockResolvedValue({ status: 'ACTIVE' });
  });

  it('derives pickupState, returns range counts and sorts by stop order', async () => {
    prisma.booking.findMany.mockResolvedValue([
      makeBooking({ id: 'a', pickup: complete, selectedTime: '09:00' }),
      makeBooking({ id: 'b', pickup: missingInstructions, selectedTime: '07:00' }),
      makeBooking({ id: 'c', pickup: deferred, selectedTime: '06:00' }),
      makeBooking({ id: 'd', pickup: complete, selectedTime: '10:00', pickedUpAt: day('2026-10-01'), pickupOrder: 0 }),
    ]);

    const res = mockRes();
    await controller.getPickupPlanner(mockReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0].data;

    expect(payload.counts).toEqual({ all: 4, deferred: 1, incomplete: 1, confirmed: 2, pickedUp: 1 });
    // 'd' has pickupOrder 0, so it sorts first despite the later time; the rest
    // fall back to the pickup time (c 06:00, b 07:00, a 09:00).
    expect(payload.bookings.map((b) => b.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(payload.bookings.find((b) => b.id === 'c').pickupState).toBe('deferred');
    expect(payload.bookings.find((b) => b.id === 'b').pickupState).toBe('incomplete');
  });

  it('filters by pickupState and by picked-up', async () => {
    prisma.booking.findMany.mockResolvedValue([
      makeBooking({ id: 'a', pickup: complete }),
      makeBooking({ id: 'b', pickup: missingInstructions }),
      makeBooking({ id: 'c', pickup: complete, pickedUpAt: day('2026-10-01') }),
    ]);

    const res = mockRes();
    await controller.getPickupPlanner(mockReq({ query: { pickupState: 'incomplete' } }), res, next);
    expect(res.json.mock.calls[0][0].data.bookings.map((b) => b.id)).toEqual(['b']);
    // Counts are still computed over the whole range.
    expect(res.json.mock.calls[0][0].data.counts.all).toBe(3);

    const res2 = mockRes();
    await controller.getPickupPlanner(mockReq({ query: { pickedUp: 'true' } }), res2, next);
    expect(res2.json.mock.calls[0][0].data.bookings.map((b) => b.id)).toEqual(['c']);
  });

  it('rejects a non-ACTIVE supplier', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ status: 'PENDING' });
    await controller.getPickupPlanner(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});

describe('reorderPickupStops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.findMany.mockResolvedValue([{ id: 'b2' }, { id: 'b1' }]);
    prisma.$transaction.mockResolvedValue([]);
  });

  it('persists the stop position for every booking in order', async () => {
    const res = mockRes();
    await controller.reorderPickupStops(
      mockReq({ body: { date: '2026-10-01', order: ['b2', 'b1'] } }),
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b2' }, data: { pickupOrder: 0 } })
    );
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1' }, data: { pickupOrder: 1 } })
    );
  });

  it('rejects ids that are not this supplier\'s on that day', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: 'b2' }]);
    await controller.reorderPickupStops(
      mockReq({ body: { date: '2026-10-01', order: ['b2', 'b1'] } }),
      mockRes(),
      next
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires a date and a non-empty order', async () => {
    await controller.reorderPickupStops(mockReq({ body: { date: '2026-10-01', order: [] } }), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('updateBookingPickup — picked up', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.findFirst.mockResolvedValue({
      id: 'b1',
      customerId: 'c1',
      pickup: { place: 'Hotel', time: '08:00' },
      customer: { id: 'c1', name: 'Ann', email: 'a@b.c' },
    });
    prisma.booking.update.mockResolvedValue({ id: 'b1' });
  });

  it('marks a stop picked up without emailing the customer', async () => {
    const res = mockRes();
    await controller.updateBookingPickup(
      mockReq({ params: { id: 'b1' }, body: { pickedUp: true } }),
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1' }, data: { pickedUpAt: expect.any(Date) } })
    );
    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('still notifies the customer when the pickup details change', async () => {
    const res = mockRes();
    await controller.updateBookingPickup(
      mockReq({ params: { id: 'b1' }, body: { pickupTime: '09:30' } }),
      res,
      next
    );

    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1' }, data: { pickup: expect.objectContaining({ time: '09:30' }) } })
    );
    expect(enqueueEmail).toHaveBeenCalled();
    expect(enqueueNotification).toHaveBeenCalled();
  });
});
