/**
 * The alarm that should have caught the 2026-10-30 GA4 outage on day one.
 *
 * Every confirmed delivery carries `ga4ReportedAt`; a booking that owed GA a
 * purchase and has no stamp is a fault. These tests pin the query's filters —
 * especially that a *declined* consent or a missing client_id is never
 * reported as missing, because those are correct omissions, not failures.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findMany: jest.fn() },
}));

const prisma = require('../../src/core/services/prismaClient');
const { findUnreportedPurchases, reportUnreportedPurchases } = require('../../src/core/services/ga4DeliveryCheck');

const NOW = new Date('2026-10-31T12:00:00.000Z').getTime();

beforeEach(() => {
  prisma.booking.findMany.mockReset();
  prisma.booking.findMany.mockResolvedValue([]);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('findUnreportedPurchases', () => {
  it('only asks for bookings that owed GA an event and got no confirmation', async () => {
    await findUnreportedPurchases({ now: NOW });

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.analyticsConsent).toBe(true);
    expect(where.gaClientId).toEqual({ not: null });
    expect(where.ga4ReportedAt).toBeNull();
    expect(where.paymentStatus.in).toEqual(['SUCCEEDED', 'REFUNDED']);
  });

  it('leaves a grace period so a fire-and-forget send is not called missing', async () => {
    await findUnreportedPurchases({ now: NOW, graceMs: 60 * 60 * 1000, lookbackMs: 7 * 24 * 60 * 60 * 1000 });

    const { gte, lte } = prisma.booking.findMany.mock.calls[0][0].where.paidAt;
    expect(lte.getTime()).toBe(NOW - 60 * 60 * 1000);
    expect(gte.getTime()).toBe(NOW - 7 * 24 * 60 * 60 * 1000);
  });
});

describe('reportUnreportedPurchases', () => {
  it('says nothing when every consented purchase was confirmed', async () => {
    const result = await reportUnreportedPurchases({ now: NOW });

    expect(result).toEqual({ count: 0, revenue: 0, bookings: [] });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('names the bookings, the money and the fix when deliveries are missing', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { bookingNumber: 'TRG-1', grossAmount: 160, paidAt: new Date('2026-10-20T07:05:00Z') },
      { bookingNumber: 'TRG-2', grossAmount: 90, paidAt: new Date('2026-10-21T17:00:00Z') },
    ]);

    const result = await reportUnreportedPurchases({ now: NOW });

    expect(result).toEqual({ count: 2, revenue: 250, bookings: ['TRG-1', 'TRG-2'] });
    const message = console.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(message).toContain('2 consented purchase(s) worth $250.00');
    expect(message).toContain('TRG-1, TRG-2');
    expect(message).toContain('Measurement Protocol secret');
    expect(message).toContain('ga4-reconcile.js --backfill');
  });
});
