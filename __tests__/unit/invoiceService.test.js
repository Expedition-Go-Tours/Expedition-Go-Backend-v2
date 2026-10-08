// Unit tests for the finance v3 invoice service (automatic supplier invoicing).
// The job loop, estimate builder and mark-paid path are exercised against a
// mocked Prisma client; window/date math comes from the real v3 engine in
// payoutCycles.js.
jest.mock('../../src/core/services/prismaClient', () => {
  const tx = {
    invoice: { create: jest.fn(), update: jest.fn() },
    invoiceItem: { createMany: jest.fn() },
    booking: { updateMany: jest.fn() },
  };
  return {
    supplierProfile: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    booking: { findMany: jest.fn(), updateMany: jest.fn() },
    invoice: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    invoiceItem: { createMany: jest.fn() },
    payoutMethod: { findFirst: jest.fn() },
    $transaction: jest.fn((fn) => fn(tx)),
    __tx: tx,
  };
});

jest.mock('../../src/core/services/getConfig', () => jest.fn());
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn().mockResolvedValue(undefined),
  enqueueEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn() }));

const prisma = require('../../src/core/services/prismaClient');
const { enqueueNotification } = require('../../src/core/services/queue');
const { logActivity } = require('../../src/core/services/auditLogger');
const {
  buildInvoiceEstimate,
  approveInvoice,
  markInvoicePaid,
  generateDueInvoices,
  invoiceRunKey,
  normalizeReference,
  v3BookingsWhere,
  detachBookingFromInvoices,
} = require('../../src/core/services/invoiceService');
const { invoiceWindowFor } = require('../../src/core/services/payoutCycles');

const b = (id, travelDate, currency, gross, commission, net) => ({
  id,
  bookingNumber: `BK-${id}`,
  travelDate,
  currency,
  grossAmount: gross,
  platformCommission: commission,
  supplierPayout: net,
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
    Promise.resolve(where && where.payoutCyclePending ? [] : [])
  );
  prisma.supplierProfile.findUnique.mockResolvedValue(null);
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.invoice.findUnique.mockResolvedValue(null);
  prisma.invoice.findFirst.mockResolvedValue(null);
  prisma.payoutMethod.findFirst.mockResolvedValue({ id: 'pm-1', verified: true });
});

describe('v3BookingsWhere — the finance-v3 selection predicate', () => {
  it('selects only ELIGIBLE bookings by activity date inside the window', () => {
    const window = invoiceWindowFor(new Date(2026, 9, 10), 'TWICE_MONTHLY');
    const where = v3BookingsWhere({ supplierId: 'sup-1', window });
    expect(where.tour).toEqual({ supplierId: 'sup-1' });
    expect(where.isSimulated).toBe(false);
    expect(where.paymentStatus).toBe('SUCCEEDED');
    expect(where.status.in).toEqual(['CONFIRMED', 'COMPLETED', 'NO_SHOW']);
    // Only ELIGIBLE money is invoiced. Still-clearing bookings — including
    // tours whose activity date is still ahead — must never enter a payout.
    expect(where.payoutStatus).toBe('ELIGIBLE');
    expect(where.travelDate.gte).toEqual(new Date(2026, 9, 1));
    expect(where.travelDate.lte).toEqual(new Date(2026, 9, 15, 23, 59, 59, 999));
  });

  it('pays NO_SHOW bookings (non-refundable, supplier performed — GYG parity) and never refunded money', () => {
    const window = invoiceWindowFor(new Date(2026, 9, 10), 'TWICE_MONTHLY');
    const { status } = v3BookingsWhere({ supplierId: 'sup-1', window });
    expect(status.in).toContain('NO_SHOW');
    // Refunded/cancelled/pending money never enters an invoice.
    expect(status.in).not.toContain('CANCELLED');
    expect(status.in).not.toContain('REFUNDED');
    expect(status.in).not.toContain('PENDING');
  });
});

describe('buildInvoiceEstimate — the "Next payout" projection', () => {
  it('returns the pending window with per-currency net totals and processing dates', async () => {
    prisma.booking.findMany.mockResolvedValue([
      b('b1', new Date(2026, 9, 3), 'USD', 100, 15, 85),
      // Second cleared booking inside the same (still-pending) window.
      b('b2', new Date(2026, 9, 5), 'USD', 50, 7.5, 42.5),
    ]);
    const est = await buildInvoiceEstimate({
      supplierId: 'sup-1',
      cycle: 'TWICE_MONTHLY',
      now: new Date(2026, 9, 7, 10, 0), // Wed 7 Oct — slot A Oct is pending
    });
    expect(est.window.label).toBe('Oct 1–15');
    expect(est.window.slot).toBe('A');
    expect(est.window.invoicedOn).toEqual(new Date(2026, 9, 16));
    expect(est.window.paidOn).toEqual(new Date(2026, 9, 20));
    expect(est.bookingCount).toBe(2);
    expect(est.grossTotal).toBe(150);
    expect(est.commissionTotal).toBe(22.5);
    expect(est.netTotal).toBe(127.5);
    expect(est.byCurrency).toHaveLength(1);
    expect(est.byCurrency[0]).toMatchObject({ currency: 'USD', bookingCount: 2, netTotal: 127.5 });
  });

  it('groups mixed currencies separately', async () => {
    prisma.booking.findMany.mockResolvedValue([
      b('b1', new Date(2026, 9, 3), 'USD', 100, 15, 85),
      b('b2', new Date(2026, 9, 4), 'EUR', 200, 30, 170),
    ]);
    const est = await buildInvoiceEstimate({ supplierId: 'sup-1', cycle: 'TWICE_MONTHLY', now: new Date(2026, 9, 7) });
    expect(est.byCurrency.map((g) => g.currency).sort()).toEqual(['EUR', 'USD']);
    expect(est.netTotal).toBe(255);
  });

  it('resets to the next window after the pending window has invoiced', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    const est = await buildInvoiceEstimate({ supplierId: 'sup-1', cycle: 'TWICE_MONTHLY', now: new Date(2026, 9, 21) });
    expect(est.window.label).toBe('Oct 16–31');
    expect(est.window.invoicedOn).toEqual(new Date(2026, 10, 2)); // Sun 1 Nov → Mon 2 Nov
  });

  it('returns a zeroed estimate for an unknown cadence', async () => {
    const est = await buildInvoiceEstimate({ supplierId: 'sup-1', cycle: 'WEEKLY', now: new Date(2026, 9, 7) });
    expect(est.window).toBeNull();
    expect(est.bookingCount).toBe(0);
    expect(est.netTotal).toBe(0);
  });
});

describe('generateDueInvoices — the hourly scheduled job', () => {
  const now = new Date(2026, 9, 21, 2, 0); // Wed 21 Oct — slot A Oct (invoiced 16 Oct) is due

  it('creates one runKey invoice per window+currency and claims the bookings', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    prisma.booking.findMany.mockResolvedValue([
      b('b1', new Date(2026, 8, 5), 'USD', 100, 15, 85), // slot A September (invoiced 16 Sep — due)
      b('b2', new Date(2026, 9, 5), 'USD', 50, 7.5, 42.5), // slot A October (invoiced 16 Oct — due)
    ]);
    prisma.__tx.invoice.create.mockResolvedValueOnce({ id: 'inv-sep', invoiceNumber: 'INV-SEP', netTotal: 85, currency: 'USD' });
    prisma.__tx.invoice.create.mockResolvedValueOnce({ id: 'inv-oct', invoiceNumber: 'INV-OCT', netTotal: 42.5, currency: 'USD' });

    const report = await generateDueInvoices(now);

    expect(report.invoicesCreated).toBe(2);
    expect(report.bookingsInvoiced).toBe(2);
    const keys = prisma.__tx.invoice.create.mock.calls.map((c) => c[0].data.runKey).sort();
    const expected = [
      invoiceRunKey('sup-1', invoiceWindowFor(new Date(2026, 8, 5), 'TWICE_MONTHLY'), 'USD'),
      invoiceRunKey('sup-1', invoiceWindowFor(new Date(2026, 9, 5), 'TWICE_MONTHLY'), 'USD'),
    ].sort();
    expect(keys).toEqual(expected);
    // Scheduled invoices carry the runKey and snapshot the window dates.
    const dataSep = prisma.__tx.invoice.create.mock.calls[0][0].data;
    expect(dataSep.runKey).toContain('sup-1');
    expect(dataSep.paymentScheduledAt).toEqual(invoiceWindowFor(new Date(2026, 8, 5), 'TWICE_MONTHLY').paidOn);
    expect(prisma.__tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { payoutStatus: 'INVOICED' } })
    );
    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'sup-1', type: 'INVOICE_GENERATED' }));
  });

  it('sweeps every payable status, NO_SHOW included, in the scheduled run', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    prisma.booking.findMany.mockResolvedValue([b('b1', new Date(2026, 9, 5), 'USD', 100, 15, 85)]);
    prisma.__tx.invoice.create.mockResolvedValue({ id: 'inv-a', invoiceNumber: 'INV-A', netTotal: 85, currency: 'USD' });

    await generateDueInvoices(now);

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['CONFIRMED', 'COMPLETED', 'NO_SHOW']);
    // Clearing (PENDING) bookings are never swept into an invoice.
    expect(where.payoutStatus).toBe('ELIGIBLE');
  });

  it('is idempotent — a re-fire with no remaining bookings does nothing', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    prisma.booking.findMany.mockResolvedValue([]); // everything already invoiced
    const report = await generateDueInvoices(now);
    expect(report.invoicesCreated).toBe(0);
    expect(report.skippedNoFunds).toBe(1);
    expect(prisma.__tx.invoice.create).not.toHaveBeenCalled();
  });

  it('appends delay-confirmed bookings to the existing INVOICED invoice', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    prisma.booking.findMany.mockResolvedValue([
      b('b1', new Date(2026, 9, 5), 'USD', 100, 15, 85), // landed after the invoice ran
    ]);
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-existing', status: 'INVOICED' });
    prisma.__tx.invoiceItem.createMany.mockResolvedValue({ count: 1 });

    const report = await generateDueInvoices(now);

    expect(report.invoicesCreated).toBe(0);
    expect(report.appendedBookings).toBe(1);
    expect(prisma.__tx.invoiceItem.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ invoiceId: 'inv-existing', bookingId: 'b1' })]) })
    );
    expect(prisma.__tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-existing' },
        data: expect.objectContaining({ netTotal: { increment: 85 } }),
      })
    );
  });

  it('appends bookings to an APPROVED invoice too — approved does not mean closed', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    prisma.booking.findMany.mockResolvedValue([
      b('b1', new Date(2026, 9, 5), 'USD', 100, 15, 85), // late booking after finance approved
    ]);
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-approved', status: 'APPROVED' });
    prisma.__tx.invoiceItem.createMany.mockResolvedValue({ count: 1 });

    const report = await generateDueInvoices(now);

    expect(report.invoicesCreated).toBe(0);
    expect(report.appendedBookings).toBe(1);
    expect(prisma.__tx.invoiceItem.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ invoiceId: 'inv-approved', bookingId: 'b1' })]) })
    );
  });

  it('raises a catch-up invoice when a booking only clears after its window was paid', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    prisma.booking.findMany.mockResolvedValue([b('b1', new Date(2026, 9, 5), 'USD', 100, 15, 85)]);
    // The window's scheduled invoice is settled: the booking cannot join it.
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-paid', status: 'PAID' });
    prisma.__tx.invoice.create.mockResolvedValue({ id: 'inv-catchup', invoiceNumber: 'INV-CATCHUP', netTotal: 85, currency: 'USD' });

    const report = await generateDueInvoices(now);

    // The money is ELIGIBLE, so it must not be stranded on a closed window: it
    // is raised on its own invoice, WITHOUT a runKey (runKey is unique per
    // window+currency, and this window already has one).
    expect(report.invoicesCreated).toBe(1);
    expect(report.bookingsInvoiced).toBe(1);
    expect(report.windows).toBe(0); // a catch-up is not a new window
    const data = prisma.__tx.invoice.create.mock.calls[0][0].data;
    expect(data.runKey).toBeNull();
    expect(data.netTotal).toBe(85);
    expect(data.cycleLabel).toBe('Oct 1–15');
    expect(prisma.__tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { payoutStatus: 'INVOICED' } })
    );
    // It is created (not appended) — the settled invoice is left untouched.
    expect(prisma.__tx.invoiceItem.createMany).not.toHaveBeenCalled();
    expect(prisma.__tx.invoice.update).not.toHaveBeenCalled();
  });

  it('skips suppliers without a verified payout method — their bookings wait', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    prisma.payoutMethod.findFirst.mockResolvedValue(null);
    const report = await generateDueInvoices(now);
    expect(report.skippedNoMethod).toBe(1);
    expect(report.invoicesCreated).toBe(0);
  });

  it('splits mixed currencies under separate runKeys', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    const windowOct = invoiceWindowFor(new Date(2026, 9, 5), 'TWICE_MONTHLY');
    prisma.booking.findMany.mockResolvedValue([
      b('b1', new Date(2026, 9, 5), 'USD', 100, 15, 85),
      b('b2', new Date(2026, 9, 6), 'EUR', 200, 30, 170),
    ]);
    prisma.__tx.invoice.create.mockResolvedValueOnce({ id: 'inv-usd', invoiceNumber: 'INV-USD', netTotal: 85, currency: 'USD' });
    prisma.__tx.invoice.create.mockResolvedValueOnce({ id: 'inv-eur', invoiceNumber: 'INV-EUR', netTotal: 170, currency: 'EUR' });

    const report = await generateDueInvoices(now);
    expect(report.invoicesCreated).toBe(2);
    const keys = prisma.__tx.invoice.create.mock.calls.map((c) => c[0].data.runKey).sort();
    expect(keys).toEqual([
      invoiceRunKey('sup-1', windowOct, 'EUR'),
      invoiceRunKey('sup-1', windowOct, 'USD'),
    ].sort());
  });

  it('does not invoice bookings whose window invoice date has not arrived (they stay on the estimate)', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    // travelDate Nov 5 → slot A Nov, invoiced 16 Nov — later than `now`.
    prisma.booking.findMany.mockResolvedValue([b('b1', new Date(2026, 10, 5), 'USD', 100, 15, 85)]);
    const report = await generateDueInvoices(now);
    expect(report.invoicesCreated).toBe(0);
    expect(report.bookingsInvoiced).toBe(0);
    expect(prisma.__tx.invoice.create).not.toHaveBeenCalled();
  });

  it('backfills a window the job missed on its invoice date', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    // Job missed 16 Oct; runs 3 days later — the window is still due.
    prisma.booking.findMany.mockResolvedValue([b('b1', new Date(2026, 9, 5), 'USD', 100, 15, 85)]);
    prisma.__tx.invoice.create.mockResolvedValue({ id: 'inv-a', invoiceNumber: 'INV-A', netTotal: 85, currency: 'USD' });
    const report = await generateDueInvoices(new Date(2026, 9, 19, 1, 0));
    expect(report.invoicesCreated).toBe(1);
  });
});

describe('markInvoicePaid — finance records the real transfer', () => {
  it('marks the invoice paid and flips its bookings to PAID', async () => {
    prisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-1',
      status: 'APPROVED',
      items: [{ bookingId: 'b1' }, { bookingId: 'b2' }],
    });
    prisma.__tx.invoice.update.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-1',
      status: 'PAID',
      paidAt: new Date(2026, 9, 21),
      paidBy: 'admin-1',
      reference: 'TRX-987654',
    });

    const result = await markInvoicePaid({ invoiceId: 'inv-1', reference: 'TRX-987654', adminUserId: 'admin-1', adminEmail: 'fin@x.com' });

    expect(result.status).toBe('PAID');
    expect(prisma.__tx.invoice.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: 'PAID', paidBy: 'admin-1', reference: 'TRX-987654' })
    );
    expect(prisma.__tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['b1', 'b2'] } }, data: { payoutStatus: 'PAID' } })
    );
  });

  it('rejects placeholder references with a 400', async () => {
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1', status: 'INVOICED', items: [] });
    for (const bad of ['test', 'n/a', 'N/A', '', '   ', 'ab']) {
      await expect(markInvoicePaid({ invoiceId: 'inv-1', reference: bad, adminUserId: 'a', adminEmail: 'x' }))
        .rejects.toMatchObject({ statusCode: 400 });
    }
    expect(prisma.__tx.invoice.update).not.toHaveBeenCalled();
  });

  it('404s for an unknown invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue(null);
    await expect(markInvoicePaid({ invoiceId: 'nope', reference: 'TRX-123', adminUserId: 'a', adminEmail: 'x' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('409s when the invoice is still awaiting approval', async () => {
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1', status: 'INVOICED', items: [] });
    await expect(markInvoicePaid({ invoiceId: 'inv-1', reference: 'TRX-123', adminUserId: 'a', adminEmail: 'x' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('awaiting approval') });
    expect(prisma.__tx.invoice.update).not.toHaveBeenCalled();
  });

  it('409s when the invoice is not APPROVED (already PAID)', async () => {
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1', status: 'PAID', items: [] });
    await expect(markInvoicePaid({ invoiceId: 'inv-1', reference: 'TRX-123', adminUserId: 'a', adminEmail: 'x' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('approveInvoice — the maker–checker gate', () => {
  it('approves an INVOICED invoice and records who approved it', async () => {
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1', status: 'INVOICED' });
    prisma.invoice.update.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-1',
      status: 'APPROVED',
      approvedAt: new Date(),
      approvedBy: 'admin-1',
    });

    const result = await approveInvoice({ invoiceId: 'inv-1', adminUserId: 'admin-1', adminEmail: 'fin@x.com' });

    expect(result.status).toBe('APPROVED');
    const data = prisma.invoice.update.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({ status: 'APPROVED', approvedBy: 'admin-1' }));
    expect(data.approvedAt).toBeInstanceOf(Date);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invoice.approved', resourceId: 'inv-1' })
    );
  });

  it('404s for an unknown invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue(null);
    await expect(approveInvoice({ invoiceId: 'nope', adminUserId: 'a' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('409s when the invoice is not awaiting approval', async () => {
    for (const status of ['APPROVED', 'PAID', 'CANCELLED']) {
      prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1', status });
      await expect(approveInvoice({ invoiceId: 'inv-1', adminUserId: 'a' })).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
});

describe('normalizeReference', () => {
  it('normalises whitespace and returns the cleaned value', () => {
    expect(normalizeReference('  TRX-AB   123  ')).toEqual({ value: 'TRX-AB 123' });
  });
  it('flags placeholders and invalid lengths', () => {
    expect(normalizeReference('test').error).toBeDefined();
    expect(normalizeReference('N/A').error).toBeDefined();
    expect(normalizeReference('').error).toBeDefined();
    expect(normalizeReference('a'.repeat(101)).error).toBeDefined();
  });
});

describe('detachBookingFromInvoices — cancellation keeps unpaid invoices honest', () => {
  it('removes the line item and rebalances the invoice from its remaining items', async () => {
    const tx = {
      invoiceItem: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'item-1', invoiceId: 'inv-1' }])
          .mockResolvedValueOnce([
            { grossAmount: '100', platformCommission: '17', supplierPayout: '83' },
            { grossAmount: '50', platformCommission: '8.5', supplierPayout: '41.5' },
          ]),
        delete: jest.fn().mockResolvedValue({}),
      },
      invoice: { update: jest.fn().mockResolvedValue({}) },
    };

    const adjusted = await detachBookingFromInvoices(tx, 'bk-1');

    expect(adjusted).toBe(1);
    expect(tx.invoiceItem.delete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: { grossTotal: 150, commissionTotal: 25.5, netTotal: 124.5, bookingCount: 2 },
    });
  });

  it('cancels the invoice when its last item is removed', async () => {
    const tx = {
      invoiceItem: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'item-1', invoiceId: 'inv-1' }])
          .mockResolvedValueOnce([]),
        delete: jest.fn().mockResolvedValue({}),
      },
      invoice: { update: jest.fn().mockResolvedValue({}) },
    };

    const adjusted = await detachBookingFromInvoices(tx, 'bk-1');

    expect(adjusted).toBe(1);
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: { status: 'CANCELLED', grossTotal: 0, commissionTotal: 0, netTotal: 0, bookingCount: 0 },
    });
  });

  it('targets every unpaid invoice (INVOICED or APPROVED), never a PAID one', async () => {
    const tx = {
      invoiceItem: { findMany: jest.fn().mockResolvedValue([]), delete: jest.fn() },
      invoice: { update: jest.fn() },
    };

    await detachBookingFromInvoices(tx, 'bk-1');

    expect(tx.invoiceItem.findMany).toHaveBeenCalledWith({
      where: { bookingId: 'bk-1', invoice: { status: { in: ['INVOICED', 'APPROVED'] } } },
      select: { id: true, invoiceId: true },
    });
  });

  it('does not touch invoices that are already PAID', async () => {
    const tx = {
      invoiceItem: { findMany: jest.fn().mockResolvedValue([]), delete: jest.fn() },
      invoice: { update: jest.fn() },
    };

    const adjusted = await detachBookingFromInvoices(tx, 'bk-1');

    expect(adjusted).toBe(0);
    expect(tx.invoiceItem.delete).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('detaches bookings across multiple invoices in one pass', async () => {
    const tx = {
      invoiceItem: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { id: 'item-a', invoiceId: 'inv-a' },
            { id: 'item-b', invoiceId: 'inv-b' },
          ])
          .mockResolvedValueOnce([]) // inv-a left empty
          .mockResolvedValueOnce([{ grossAmount: '80', platformCommission: '13.6', supplierPayout: '66.4' }]), // inv-b keeps one
        delete: jest.fn().mockResolvedValue({}),
      },
      invoice: { update: jest.fn().mockResolvedValue({}) },
    };

    const adjusted = await detachBookingFromInvoices(tx, 'bk-1');

    expect(adjusted).toBe(2);
    expect(tx.invoice.update.mock.calls[0][0]).toEqual({
      where: { id: 'inv-a' },
      data: { status: 'CANCELLED', grossTotal: 0, commissionTotal: 0, netTotal: 0, bookingCount: 0 },
    });
    expect(tx.invoice.update.mock.calls[1][0]).toEqual({
      where: { id: 'inv-b' },
      data: { grossTotal: 80, commissionTotal: 13.6, netTotal: 66.4, bookingCount: 1 },
    });
  });
});