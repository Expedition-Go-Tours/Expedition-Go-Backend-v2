jest.mock('../../src/core/services/prismaClient', () => {
  const prisma = {
    stayProperty: { findMany: jest.fn(), findFirst: jest.fn(), groupBy: jest.fn() },
    stayAvailabilityOverride: { findFirst: jest.fn() },
    stayBooking: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
    },
    stayOffer: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    stayOfferTarget: { deleteMany: jest.fn(), createMany: jest.fn() },
    stayReview: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
    },
    bookingCounter: { upsert: jest.fn() },
    systemConfig: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((arg) => (
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg)
  ));
  return prisma;
});

const prisma = require('../../src/core/services/prismaClient');
const bookings = require('../../src/brands/ghana/staysBookingsController');
const offers = require('../../src/brands/ghana/staysOffersController');
const analytics = require('../../src/brands/ghana/staysAnalyticsController');
const shared = require('../../src/brands/ghana/staysShared');

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

const NOW = new Date('2026-10-26T12:00:00.000Z');

function bookingRow(overrides = {}) {
  return {
    id: 'sb-1',
    bookingNumber: 'TRG-S-1',
    supplierId: 'sup-1',
    propertyId: 'sp-1',
    property: { id: 'sp-1', name: 'Akwaaba Coast Hotel' },
    roomId: 'r1',
    roomName: 'Deluxe King Room',
    ratePlanId: 'plan-r1',
    ratePlanName: 'Standard rate',
    guestName: 'Ama Mensah',
    guestEmail: 'ama@example.com',
    guestPhone: '+233200000000',
    checkIn: new Date('2026-11-10T00:00:00.000Z'),
    checkOut: new Date('2026-11-12T00:00:00.000Z'),
    nights: 2,
    guests: 2,
    amount: 240,
    currency: 'GHS',
    status: 'NEW',
    paymentStatus: 'PENDING',
    cancellationReason: null,
    cancellationNote: null,
    refundAmount: null,
    countsTowardRate: null,
    specialRequests: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('stays booking serialization', () => {
  it('maps enum statuses and date-only fields to the dashboard vocabulary', () => {
    const out = shared.serializeStayBooking(bookingRow({ status: 'CHECKED_IN' }));
    expect(out).toEqual(expect.objectContaining({
      guest: 'Ama Mensah',
      propertyName: 'Akwaaba Coast Hotel',
      room: 'Deluxe King Room',
      from: '2026-11-10',
      to: '2026-11-12',
      status: 'Checked in',
      amount: 240,
    }));
  });
});

describe('staysBookingsController', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      supplierId: 'sup-1',
      body: {},
      query: {},
      params: {},
    };
    res = makeRes();
    next = jest.fn();
    prisma.bookingCounter.upsert.mockResolvedValue({ count: 1 });
    prisma.systemConfig.findUnique.mockResolvedValue(null);
  });

  it('creates a manual booking with nights, price and commission', async () => {
    prisma.stayProperty.findFirst.mockResolvedValue({
      id: 'sp-1',
      name: 'Akwaaba Coast Hotel',
      data: {
        currency: 'GHS',
        rooms: [{ id: 'r1', name: 'Deluxe King Room', count: 4, price: 120 }],
        ratePlans: [{ id: 'plan-r1', roomId: 'r1', name: 'Standard rate', price: 120 }],
      },
    });
    prisma.stayBooking.count.mockResolvedValue(0);
    prisma.stayAvailabilityOverride.findFirst.mockResolvedValue(null);
    prisma.stayBooking.create.mockResolvedValue(bookingRow());

    req.body = {
      propertyId: 'sp-1',
      roomId: 'r1',
      guestName: '  Ama Mensah  ',
      guestEmail: 'ama@example.com',
      guestPhone: '+233200000000',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
    };

    await bookings.createBooking(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const payload = prisma.stayBooking.create.mock.calls[0][0].data;
    expect(payload).toEqual(expect.objectContaining({
      supplierId: 'sup-1',
      guestName: 'Ama Mensah',
      nights: 2,
      amount: 240,
      currency: 'GHS',
      status: 'NEW',
      origin: 'SUPPLIER_CREATED',
      commissionRate: 0.15,
      platformCommission: 36,
      supplierPayout: 204,
    }));
    expect(payload.bookingNumber).toMatch(/^TRG-S-/);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rejects an invalid status transition', async () => {
    prisma.stayBooking.findFirst.mockResolvedValue({ id: 'sb-1', status: 'NEW' });
    req.params = { id: 'sb-1' };
    req.body = { status: 'Completed' };

    await bookings.updateBookingStatus(req, res, next);

    expect(prisma.stayBooking.update).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  it('confirms a new booking', async () => {
    prisma.stayBooking.findFirst.mockResolvedValue({ id: 'sb-1', status: 'NEW' });
    prisma.stayBooking.update.mockResolvedValue(bookingRow({ status: 'CONFIRMED' }));

    req.params = { id: 'sb-1' };
    req.body = { status: 'Confirmed' };

    await bookings.updateBookingStatus(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.stayBooking.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sb-1' },
      data: { status: 'CONFIRMED' },
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('computes the cancellation summary from real bookings', async () => {
    const rows = [
      ...Array.from({ length: 7 }, () => ({ status: 'CONFIRMED', amount: 100, cancellationReason: null })),
      ...Array.from({ length: 2 }, () => ({ status: 'CANCELLED', amount: 100, cancellationReason: 'Supplier cancelled' })),
      { status: 'NO_SHOW', amount: 100, cancellationReason: 'Guest did not arrive' },
    ];
    prisma.stayBooking.findMany.mockResolvedValue(rows);

    await bookings.getCancellationSummary(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      data: expect.objectContaining({
        eligibleBookings: 10,
        cancelled: 2,
        confirmed: 7,
        cancellationRate: 20,
        status: 'High',
        bookingValueLost: 300,
      }),
    });
  });
});

describe('staysOffersController', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { supplierId: 'sup-1', body: {}, query: {}, params: {} };
    res = makeRes();
    next = jest.fn();
  });

  it('returns offers with a derived status and target names', async () => {
    prisma.stayOffer.findMany.mockResolvedValue([{
      id: 'offer-1',
      supplierId: 'sup-1',
      name: 'Weekend escape',
      offerType: 'LIMITED_TIME',
      discountType: 'PERCENTAGE',
      discountPercentage: 15,
      fixedDiscountValue: null,
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      endDate: new Date('2026-11-30T00:00:00.000Z'),
      isActive: true,
      capacityType: 'UNLIMITED',
      maxSpots: null,
      spotsSold: 0,
      timeSlotMode: 'ALL_DAYS',
      specificWeekdays: [],
      targets: [{
        propertyId: 'sp-1',
        propertyName: null,
        roomId: 'r1',
        roomLabel: 'Deluxe King Room',
        property: { id: 'sp-1', name: 'Akwaaba Coast Hotel' },
      }],
    }]);

    await offers.listOffers(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.offers[0]).toEqual(expect.objectContaining({
      status: 'active',
      targets: [expect.objectContaining({
        propertyId: 'sp-1',
        propertyName: 'Akwaaba Coast Hotel',
        roomId: 'r1',
      })],
    }));
  });
});

describe('staysAnalyticsController', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { supplierId: 'sup-1', body: {}, query: {}, params: {} };
    res = makeRes();
    next = jest.fn();
  });

  it('summarises properties, bookings, earnings and reviews', async () => {
    prisma.stayProperty.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: 2 },
      { status: 'DRAFT', _count: 1 },
    ]);
    prisma.stayBooking.count.mockResolvedValue(5);
    prisma.stayBooking.aggregate.mockResolvedValue({ _sum: { amount: 1200 } });
    prisma.stayReview.aggregate.mockResolvedValue({ _avg: { rating: 4.5 }, _count: 4 });

    await analytics.getAnalyticsSummary(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      data: {
        properties: { active: 2, total: 3 },
        bookings: { total: 5 },
        earnings: { totalEarnings: 1200 },
        reviews: { averageRating: 4.5, total: 4 },
      },
    });
  });
});
