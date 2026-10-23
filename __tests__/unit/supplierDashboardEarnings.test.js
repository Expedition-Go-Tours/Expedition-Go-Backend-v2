/**
 * The dashboard's "Total Earnings" card.
 *
 * Two rules this pins, both learned from numbers that were wrong on screen:
 *
 *  1. EARNINGS ARE PER CURRENCY. The old aggregate summed every currency into
 *     one figure printed as "$" — GH₵200 and $200 became "$400". The scalar is
 *     returned only for a single-currency account.
 *  2. ZERO IS A MEASUREMENT. An account with no paid bookings must read 0,
 *     not null/"unknown" — those are different statements to a supplier.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  supplierProfile: { findUnique: jest.fn() },
  tour: { groupBy: jest.fn(), findMany: jest.fn() },
  booking: { groupBy: jest.fn(), aggregate: jest.fn() },
  review: { count: jest.fn() },
}));
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/offerStatus', () => ({
  computeOfferStatus: jest.fn(() => ({})),
}));

const prisma = require('../../src/core/services/prismaClient');
const makeSupplierController = require('../../src/core/supplier');

const controller = makeSupplierController('ghana');

async function invokeDashboard() {
  const req = { supplierId: 'supplier-1', user: { id: 'user-1' } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await controller.getDashboard(req, res, next);
  return res.json.mock.calls[0][0].data;
}

/** booking.groupBy is asked three different shapes — answer each in kind. */
function stubBookings({ earnings = [], byStatus = [], byTour = [] } = {}) {
  prisma.booking.groupBy.mockImplementation(({ by }) => {
    const key = (by || []).join(',');
    if (key === 'currency') return Promise.resolve(earnings);
    if (key === 'tourId') return Promise.resolve(byTour);
    return Promise.resolve(byStatus);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.supplierProfile.findUnique.mockResolvedValue({ userId: 'supplier-1' });
  prisma.tour.groupBy.mockResolvedValue([{ status: 'ACTIVE', _count: 3 }]);
  prisma.review.count.mockResolvedValue(0);
  prisma.tour.findMany.mockResolvedValue([]);
  stubBookings();
});

describe('Total Earnings is per currency', () => {
  it('returns the scalar and the currency for a single-currency account', async () => {
    stubBookings({
      earnings: [{ currency: 'USD', _sum: { supplierPayout: 4707.66, grossAmount: 5531 }, _count: { _all: 38 } }],
    });

    const data = await invokeDashboard();

    expect(data.earnings.totalEarnings).toBe(4707.66);
    expect(data.earnings.currency).toBe('USD');
    expect(data.earnings.byCurrency).toEqual([
      { currency: 'USD', supplierCut: 4707.66, gross: 5531, bookings: 38 },
    ]);
  });

  it('refuses to invent a total when two currencies are held', async () => {
    stubBookings({
      earnings: [
        { currency: 'GHS', _sum: { supplierPayout: 200, grossAmount: 240 }, _count: { _all: 1 } },
        { currency: 'USD', _sum: { supplierPayout: 100, grossAmount: 120 }, _count: { _all: 2 } },
      ],
    });

    const data = await invokeDashboard();

    // GH₵200 + $100 is NOT $300 — the scalar goes null and the UI walks
    // byCurrency instead.
    expect(data.earnings.totalEarnings).toBeNull();
    expect(data.earnings.currency).toBeNull();
    expect(data.earnings.byCurrency).toEqual([
      { currency: 'GHS', supplierCut: 200, gross: 240, bookings: 1 },
      { currency: 'USD', supplierCut: 100, gross: 120, bookings: 2 },
    ]);
  });

  it('reports a real zero for an account that has earned nothing', async () => {
    stubBookings({ earnings: [] });

    const data = await invokeDashboard();

    // 0 is a measurement ("nothing earned yet"); null would say "we do not
    // know", which is a different thing to tell a supplier.
    expect(data.earnings.totalEarnings).toBe(0);
    expect(data.earnings.currency).toBe('USD');
    expect(data.earnings.byCurrency).toEqual([]);
  });

  it('counts only SUCCEEDED bookings — refunds and unpaid reservations earn nothing', async () => {
    stubBookings({ earnings: [{ currency: 'USD', _sum: { supplierPayout: 50 }, _count: { _all: 1 } }] });

    await invokeDashboard();

    const [call] = prisma.booking.groupBy.mock.calls.filter(([{ by }]) => by.includes('currency'));
    expect(call[0].where).toEqual({
      tour: { supplierId: 'supplier-1' },
      isSimulated: false,
      paymentStatus: 'SUCCEEDED',
    });
    expect(call[0].by).toEqual(['currency']);
  });
});
