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
  findBookingsGaNeverReceived,
  reportBookingsGaNeverReceived,
} = require('../../src/core/services/ga4DeliveryCheck');
const ga4Reporting = require('../../src/core/services/ga4Reporting');

const NOW = new Date('2026-10-31T12:00:00.000Z').getTime();

beforeEach(() => {
  prisma.booking.findMany.mockReset();
  prisma.booking.findMany.mockResolvedValue([]);
  jest.spyOn(ga4Reporting, 'isConfigured').mockReturnValue(true);
  jest.spyOn(ga4Reporting, 'fetchPurchaseLedger').mockResolvedValue([]);
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

/**
 * The distinction these tests exist for: `ga4ReportedAt` records a 2xx, and GA
 * answers 204 to an unusable API secret. Only consulting GA's own reports
 * catches a booking the database believes is delivered and GA never kept.
 */
describe('reportBookingsGaNeverReceived — asks GA, not our own ledger', () => {
  it('flags a purchase GA does not contain even though the database says delivered', async () => {
    // ga4ReportedAt is deliberately not selected or filtered: the point is that
    // this check does not consult it.
    prisma.booking.findMany.mockResolvedValue([
      { bookingNumber: 'TRG-1', paidAt: new Date('2026-10-25T10:00:00Z'), ga4ReportedAt: new Date('2026-10-25T10:00:05Z'), grossAmount: 160 },
      { bookingNumber: 'TRG-2', paidAt: new Date('2026-10-25T11:00:00Z'), ga4ReportedAt: null, grossAmount: 90 },
    ]);
    ga4Reporting.fetchPurchaseLedger.mockResolvedValue([
      { transactionId: 'TRG-1', revenue: 160, transactions: 1, itemsPurchased: 1 },
    ]);

    const result = await reportBookingsGaNeverReceived({ now: NOW });

    expect(result).toEqual({ skipped: null, count: 1, revenue: 90, bookings: ['TRG-2'] });
    const message = console.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(message).toContain('marked delivered in');
    expect(message).toContain('GA4');
    expect(message).toContain('204 to an unusable API secret');
    expect(message).toContain('ga4-reconcile.js --backfill');
  });

  it('is silent when GA holds every consented purchase', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { bookingNumber: 'TRG-1', paidAt: new Date('2026-10-25T10:00:00Z'), ga4ReportedAt: new Date('2026-10-25T10:00:05Z'), grossAmount: 160 },
    ]);
    ga4Reporting.fetchPurchaseLedger.mockResolvedValue([
      { transactionId: 'TRG-1', revenue: 160, transactions: 1, itemsPurchased: 1 },
    ]);

    const result = await reportBookingsGaNeverReceived({ now: NOW });

    expect(result).toEqual({ skipped: null, count: 0, revenue: 0, bookings: [] });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports "not configured" rather than a clean zero nobody checked', async () => {
    jest.spyOn(ga4Reporting, 'isConfigured').mockReturnValue(false);

    const result = await reportBookingsGaNeverReceived({ now: NOW });

    expect(result.skipped).toBe('read-side-not-configured');
    expect(result.count).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
    expect(ga4Reporting.fetchPurchaseLedger).not.toHaveBeenCalled();
  });

  it('stays silent on a booking backfilled moments ago, however old the payment', async () => {
    // The false positive this rule exists for: paid a week ago, sent a minute
    // ago. GA has not had time to report it, so absence means nothing yet.
    prisma.booking.findMany.mockResolvedValue([
      { bookingNumber: 'TRG-RECENT', paidAt: new Date(NOW - 7 * 24 * 60 * 60 * 1000), ga4ReportedAt: new Date(NOW - 60 * 1000), grossAmount: 160 },
    ]);
    ga4Reporting.fetchPurchaseLedger.mockResolvedValue([]);

    const result = await reportBookingsGaNeverReceived({ now: NOW });

    expect(result.count).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('measures age from the send, not the payment date', async () => {
    // Paid recently but reported long ago (a late-settled pay-later booking):
    // GA has had the event for days, so absence is real.
    prisma.booking.findMany.mockResolvedValue([
      { bookingNumber: 'TRG-OLDFLASH', paidAt: new Date(NOW - 5 * 60 * 60 * 1000), ga4ReportedAt: new Date(NOW - 60 * 24 * 60 * 60 * 1000), grossAmount: 90 },
    ]);
    ga4Reporting.fetchPurchaseLedger.mockResolvedValue([]);

    const result = await reportBookingsGaNeverReceived({ now: NOW });

    expect(result.count).toBe(1);
    expect(result.bookings).toEqual(['TRG-OLDFLASH']);
  });

  it('queries GA through today, since a backfill may be dated by the send', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { bookingNumber: 'TRG-DUE', paidAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000), ga4ReportedAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000), grossAmount: 160 },
    ]);

    await findBookingsGaNeverReceived({ now: NOW });

    const { gte } = prisma.booking.findMany.mock.calls[0][0].where.paidAt;
    expect(gte.getTime()).toBe(NOW - 7 * 24 * 60 * 60 * 1000);
    // No upper bound on paidAt: recent bookings are fetched and then aged
    // client-side by their send time.
    expect(prisma.booking.findMany.mock.calls[0][0].where.paidAt.lte).toBeUndefined();

    const range = ga4Reporting.fetchPurchaseLedger.mock.calls[0][0];
    expect(range.to).toBe(new Date(NOW).toISOString().slice(0, 10));
  });

  it('asks GA only for consented bookings with a client_id', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    await findBookingsGaNeverReceived({ now: NOW });

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.analyticsConsent).toBe(true);
    expect(where.gaClientId).toEqual({ not: null });
    expect(where.paymentStatus.in).toEqual(['SUCCEEDED', 'REFUNDED']);
  });
});
