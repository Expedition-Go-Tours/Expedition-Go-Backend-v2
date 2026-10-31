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
const {
  findUnreportedPurchases,
  reportUnreportedPurchases,
  findUnderreportedRefunds,
  reportUnreportedRefunds,
} = require('../../src/core/services/ga4DeliveryCheck');

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

describe('findUnderreportedRefunds', () => {
  it('only considers refunds whose purchase GA already confirmed', async () => {
    await findUnderreportedRefunds({ now: NOW });

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.analyticsConsent).toBe(true);
    expect(where.gaClientId).toEqual({ not: null });
    // A purchase that never landed is the purchase alarm's problem; its refund
    // is carried by the same backfill.
    expect(where.ga4ReportedAt).toEqual({ not: null });
    expect(where.refundAmount).toEqual({ gt: 0 });
  });

  it('gives the refund send the same grace period as the purchase send', async () => {
    await findUnderreportedRefunds({ now: NOW, graceMs: 60 * 60 * 1000, lookbackMs: 7 * 24 * 60 * 60 * 1000 });

    const { gte, lte } = prisma.booking.findMany.mock.calls[0][0].where.refundedAt;
    expect(lte.getTime()).toBe(NOW - 60 * 60 * 1000);
    expect(gte.getTime()).toBe(NOW - 7 * 24 * 60 * 60 * 1000);
  });

  it('measures the shortfall rather than asking whether any refund was confirmed', async () => {
    prisma.booking.findMany.mockResolvedValue([
      // Nothing reported yet: the whole refund is missing.
      { bookingNumber: 'TRG-1', refundAmount: 100, ga4RefundReportedAmount: null },
      // A partial refund was reported, the rest was not.
      { bookingNumber: 'TRG-2', refundAmount: 100, ga4RefundReportedAmount: 60 },
      // Fully reported: silent.
      { bookingNumber: 'TRG-3', refundAmount: 40, ga4RefundReportedAmount: 40 },
      // Cent-level noise is not a missing event.
      { bookingNumber: 'TRG-4', refundAmount: 40, ga4RefundReportedAmount: 39.999 },
    ]);

    const rows = await findUnderreportedRefunds({ now: NOW });

    expect(rows.map((r) => [r.bookingNumber, r.shortfall])).toEqual([
      ['TRG-1', 100],
      ['TRG-2', 40],
    ]);
  });
});

describe('reportUnreportedRefunds', () => {
  it('says nothing when every refund was confirmed', async () => {
    const result = await reportUnreportedRefunds({ now: NOW });

    expect(result).toEqual({ count: 0, revenue: 0, bookings: [] });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('names the shortfall and the command that fixes it', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { bookingNumber: 'TRG-9', refundAmount: 35, ga4RefundReportedAmount: null },
      { bookingNumber: 'TRG-10', refundAmount: 100, ga4RefundReportedAmount: 60 },
    ]);

    const result = await reportUnreportedRefunds({ now: NOW });

    expect(result).toEqual({ count: 2, revenue: 75, bookings: ['TRG-9', 'TRG-10'] });
    const message = console.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(message).toContain('2 consented refund(s) worth $75.00');
    expect(message).toContain('TRG-9, TRG-10');
    expect(message).toContain('still counting this money as revenue');
    expect(message).toContain('ga4-reconcile.js --backfill');
  });
});
