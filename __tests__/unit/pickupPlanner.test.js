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
const missingTime = { areaName: 'East Legon', instructions: 'Lobby' };
const deferred = { pickupLater: true };

describe('getPickupPlanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.supplierProfile.findUnique.mockResolvedValue({ status: 'ACTIVE' });
  });

  it('derives pickupState, returns range counts and sorts by stop order', async () => {
    prisma.booking.findMany.mockResolvedValue([
      makeBooking({ id: 'a', pickup: complete, selectedTime: '09:00' }),
      makeBooking({ id: 'b', pickup: missingTime, selectedTime: '07:00' }),
      makeBooking({ id: 'c', pickup: deferred, selectedTime: '06:00' }),
      makeBooking({ id: 'd', pickup: complete, selectedTime: '10:00', pickedUpAt: day('2026-10-01'), pickupOrder: 0 }),
      makeBooking({ id: 'e', pickup: missingInstructions, selectedTime: '11:00' }),
    ]);

    const res = mockRes();
    await controller.getPickupPlanner(mockReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0].data;

    // Instructions are optional: 'e' has a location + time, so it is confirmed.
    expect(payload.counts).toEqual({ all: 5, deferred: 1, incomplete: 1, confirmed: 3, pickedUp: 1 });
    // 'd' has pickupOrder 0, so it sorts first despite the later time; the rest
    // fall back to the pickup time (c 06:00, b 07:00, a 09:00, e 11:00).
    expect(payload.bookings.map((b) => b.id)).toEqual(['d', 'c', 'b', 'a', 'e']);
    expect(payload.bookings.find((b) => b.id === 'c').pickupState).toBe('deferred');
    expect(payload.bookings.find((b) => b.id === 'b').pickupState).toBe('incomplete');
    expect(payload.bookings.find((b) => b.id === 'e').pickupState).toBe('confirmed');
  });

  it('excludes cancelled bookings unless explicitly requested', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    const res = mockRes();
    await controller.getPickupPlanner(mockReq(), res, next);

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ notIn: ['CANCELLED', 'REFUNDED'] });

    const res2 = mockRes();
    await controller.getPickupPlanner(mockReq({ query: { status: 'CANCELLED' } }), res2, next);
    expect(prisma.booking.findMany.mock.calls[1][0].where.status).toBe('CANCELLED');
  });

  it('rejects unknown status and pickup-state filters before querying Prisma', async () => {
    const res = mockRes();
    await controller.getPickupPlanner(mockReq({ query: { status: 'DELETED' } }), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.booking.findMany).not.toHaveBeenCalled();

    jest.clearAllMocks();
    prisma.supplierProfile.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    const res2 = mockRes();
    await controller.getPickupPlanner(mockReq({ query: { pickupState: 'unknown' } }), res2, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('searches the whole range by customer, booking number and address', async () => {
    prisma.booking.findMany.mockResolvedValue([
      makeBooking({ id: 'a', pickup: { address: { address: '12 Akuafo St, East Legon' }, time: '08:00' } }),
      makeBooking({ id: 'b', pickup: complete }),
    ]);
    const res = mockRes();
    await controller.getPickupPlanner(mockReq({ query: { q: 'akuafo' } }), res, next);
    expect(res.json.mock.calls[0][0].data.bookings.map((b) => b.id)).toEqual(['a']);
  });

  it('filters by pickupState and by picked-up', async () => {
    prisma.booking.findMany.mockResolvedValue([
      makeBooking({ id: 'a', pickup: complete }),
      makeBooking({ id: 'b', pickup: missingTime }),
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

  it('rejects a partial day order so hidden stops cannot be reshuffled', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]);
    await controller.reorderPickupStops(
      mockReq({ body: { date: '2026-10-01', order: ['b2', 'b1'] } }),
      mockRes(),
      next
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 400,
      message: expect.stringContaining('every stop'),
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids', async () => {
    await controller.reorderPickupStops(
      mockReq({ body: { date: '2026-10-01', order: ['b1', 'b1'] } }),
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
      status: 'CONFIRMED',
      customerId: 'c1',
      paymentTiming: 'now',
      paymentStatus: 'SUCCEEDED',
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

  it('suppresses pickup-details-updated email for unpaid reserve-now-pay-later bookings', async () => {
    prisma.booking.findFirst.mockResolvedValue({
      id: 'b1',
      status: 'CONFIRMED',
      customerId: 'c1',
      paymentTiming: 'later',
      paymentStatus: 'PENDING',
      pickup: { place: 'Hotel', time: '08:00' },
      customer: { id: 'c1', name: 'Ann', email: 'a@b.c' },
    });
    const res = mockRes();
    await controller.updateBookingPickup(
      mockReq({ params: { id: 'b1' }, body: { pickupTime: '09:30' } }),
      res,
      next
    );

    // In-app notification still fires (supplier still sees the change in dashboard)
    expect(enqueueNotification).toHaveBeenCalled();
    // Email is suppressed — pickup update merges into the charge-time confirmation
    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.pickupNotification).toEqual({
      changed: true,
      inAppQueued: true,
      emailQueued: false,
      emailSuppressedReason: 'AWAITING_PAYMENT',
    });
  });

  it('writes the canonical pickup address and mirrors the coordinates', async () => {
    const res = mockRes();
    await controller.updateBookingPickup(
      mockReq({
        params: { id: 'b1' },
        body: {
          pickupAddress: {
            name: 'Marriott Hotel',
            address: 'Marriott Hotel, Airport City, Accra',
            lat: 5.605,
            lng: -0.174,
          },
        },
      }),
      res,
      next
    );

    const snapshot = prisma.booking.update.mock.calls[0][0].data.pickup;
    expect(snapshot.address).toEqual({
      name: 'Marriott Hotel',
      address: 'Marriott Hotel, Airport City, Accra',
      lat: 5.605,
      lng: -0.174,
    });
    expect(snapshot.lat).toBe(5.605);
    expect(snapshot.lng).toBe(-0.174);
    // The old hotel label and zone were not resent, so they must be cleared;
    // otherwise the card shows the new street next to "Hotel" and "East Legon".
    expect(snapshot.areaName).toBe('');
    expect(snapshot.place).toBe('');
    expect(snapshot.locationName).toBe('');
    expect(snapshot.status).not.toBe('deferred');
    expect(res.json.mock.calls[0][0].data.pickupNotification.changed).toBe(true);
  });

  it('mirrors a legacy top-level pin into the canonical address', async () => {
    prisma.booking.findFirst.mockResolvedValue({
      id: 'b1',
      status: 'CONFIRMED',
      customerId: 'c1',
      paymentTiming: 'now',
      paymentStatus: 'SUCCEEDED',
      pickup: {
        place: 'Hotel',
        time: '08:00',
        address: { name: 'Hotel', address: '1 Main St, Accra', lat: 5.5, lng: -0.1 },
      },
    });
    const res = mockRes();
    await controller.updateBookingPickup(
      mockReq({ params: { id: 'b1' }, body: { lat: 5.611, lng: -0.201 } }),
      res,
      next
    );

    const snapshot = prisma.booking.update.mock.calls[0][0].data.pickup;
    expect(snapshot.lat).toBe(5.611);
    expect(snapshot.lng).toBe(-0.201);
    // The customer app/email read `pickup.address` — a legacy pin edit must
    // update its coordinates too, or the supplier and customer see different
    // points.
    expect(snapshot.address).toEqual({
      name: 'Hotel',
      address: '1 Main St, Accra',
      lat: 5.611,
      lng: -0.201,
    });
  });

  it('treats a legacy top-level pin move as a customer-visible change', async () => {
    const res = mockRes();
    await controller.updateBookingPickup(
      mockReq({ params: { id: 'b1' }, body: { lat: 5.611, lng: -0.201 } }),
      res,
      next
    );

    const snapshot = prisma.booking.update.mock.calls[0][0].data.pickup;
    expect(snapshot.lat).toBe(5.611);
    expect(snapshot.lng).toBe(-0.201);
    expect(enqueueNotification).toHaveBeenCalled();
    expect(enqueueEmail).toHaveBeenCalled();
  });

  it('keeps a deferred booking deferred when only instructions change', async () => {
    prisma.booking.findFirst.mockResolvedValue({
      id: 'b1',
      status: 'CONFIRMED',
      customerId: 'c1',
      paymentTiming: 'now',
      paymentStatus: 'SUCCEEDED',
      pickup: { pickupLater: true, status: 'deferred' },
    });

    const res = mockRes();
    await controller.updateBookingPickup(
      mockReq({ params: { id: 'b1' }, body: { instructions: 'Call on arrival' } }),
      res,
      next
    );

    const snapshot = prisma.booking.update.mock.calls[0][0].data.pickup;
    expect(snapshot.instructions).toBe('Call on arrival');
    expect(snapshot.pickupLater).toBe(true);
    expect(snapshot.status).toBe('deferred');
  });

  it('rejects edits on a cancelled booking', async () => {
    prisma.booking.findFirst.mockResolvedValue({
      id: 'b1',
      status: 'CANCELLED',
      customerId: 'c1',
      pickup: { place: 'Hotel', time: '08:00' },
    });

    await controller.updateBookingPickup(
      mockReq({ params: { id: 'b1' }, body: { pickupTime: '09:30' } }),
      mockRes(),
      next
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('reports no notification for an identical save', async () => {
    const res = mockRes();
    await controller.updateBookingPickup(
      mockReq({ params: { id: 'b1' }, body: { pickupTime: '08:00' } }),
      res,
      next
    );

    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.pickupNotification).toEqual({
      changed: false,
      inAppQueued: false,
      emailQueued: false,
      emailSuppressedReason: null,
    });
  });
});
