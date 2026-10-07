// Unit tests for the finance v3 invoice service (automatic supplier invoicing).
// The job loop, estimate builder, early-request accelerator and mark-paid path
// are exercised against a mocked Prisma client; window/date math comes from the
// real v3 engine in payoutCycles.js.
jest.mock('../../src/core/services/prismaClient', () => {
  const tx = {
    invoice: { create: jest.fn(), update: jest.fn() },
    invoiceItem: { createMany: jest.fn() },
    booking: { updateMany: jest.fn() },
  };
  return {
    supplierProfile: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    booking: { findMany: jest.fn(), updateMany: jest.fn() },
    invoice: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
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
const {
  buildInvoiceEstimate,
  markInvoicePaid,
  createInvoiceNow,
  generateDueInvoices,
  invoiceRunKey,
  normalizeReference,
  v3BookingsWhere,
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
  it('selects confirmed/paid bookings by activity date inside the window, including future tours', () => {
    const window = invoiceWindowFor(new Date(2026, 9, 10), 'TWICE_MONTHLY');
    const where = v3BookingsWhere({ supplierId: 'sup-1', window });
    expect(where.tour).toEqual({ supplierId: 'sup-1' });
    expect(where.isSimulated).toBe(false);
    expect(where.paymentStatus).toBe('SUCCEEDED');
    expect(where.status.in).toEqual(['CONFIRMED', 'COMPLETED']);
    // PENDING (future tours not yet travelled) + ELIGIBLE (travelled) both count.
    expect(where.payoutStatus.in).toEqual(['PENDING', 'ELIGIBLE']);
    expect(where.travelDate.gte).toEqual(new Date(2026, 9, 1));
    expect(where.travelDate.lte).toEqual(new Date(2026, 9, 15, 23, 59, 59, 999));
  });
});

describe('buildInvoiceEstimate — the "Next payout" projection', () => {
  it('returns the pending window with per-currency net totals and processing dates', async () => {
    prisma.booking.findMany.mockResolvedValue([
      b('b1', new Date(2026, 9, 3), 'USD', 100, 15, 85),
      // Future confirmed tour — travel date still ahead, payoutStatus PENDING.
      b('b2', new Date(2026, 9, 12), 'USD', 50, 7.5, 42.5),
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

describe('createInvoiceNow — the manual early-request accelerator', () => {
  it('creates an invoice for the pending window WITHOUT a runKey and claims the bookings', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({
      payoutCycle: 'TWICE_MONTHLY',
      payoutCyclePending: null,
      payoutCyclePendingAt: null,
    });
    prisma.booking.findMany.mockResolvedValue([
      b('b1', new Date(2026, 9, 3), 'USD', 100, 15, 85),
      b('b2', new Date(2026, 9, 12), 'USD', 50, 7.5, 42.5),
    ]);
    prisma.__tx.invoice.create.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-20261007-000000ab', netTotal: 127.5, currency: 'USD' });

    const invoices = await createInvoiceNow({ supplierId: 'sup-1', now: new Date(2026, 9, 7, 10, 0) });

    expect(invoices).toHaveLength(1);
    const data = prisma.__tx.invoice.create.mock.calls[0][0].data;
    expect(data.runKey).toBeUndefined(); // manual requests never carry a runKey
    expect(data.supplierId).toBe('sup-1');
    expect(data.cycle).toBe('TWICE_MONTHLY');
    expect(data.cycleLabel).toBe('Oct 1–15');
    expect(data.cycleStartDate).toEqual(new Date(2026, 9, 1));
    expect(data.cycleEndDate).toEqual(new Date(2026, 9, 15, 23, 59, 59, 999));
    expect(data.paymentScheduledAt).toEqual(new Date(2026, 9, 20));
    expect(data.payoutMethodId).toBe('pm-1');
    expect(data.netTotal).toBe(127.5);
    expect(data.bookingCount).toBe(2);
    expect(data.items.create).toHaveLength(2);
    // Bookings claimed atomically with the invoice.
    expect(prisma.__tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['b1', 'b2'] } }, data: { payoutStatus: 'INVOICED' } })
    );
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'sup-1', type: 'INVOICE_GENERATED' })
    );
  });

  it('rejects a supplier who is not enrolled on an automatic schedule', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ payoutCycle: null, payoutCyclePending: null, payoutCyclePendingAt: null });
    await expect(createInvoiceNow({ supplierId: 'sup-1' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('blocks a second open manual invoice for the same window', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ payoutCycle: 'TWICE_MONTHLY', payoutCyclePending: null, payoutCyclePendingAt: null });
    prisma.invoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-20261007-111111aa' });
    await expect(createInvoiceNow({ supplierId: 'sup-1', now: new Date(2026, 9, 7) })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('requires a verified payout method', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ payoutCycle: 'TWICE_MONTHLY', payoutCyclePending: null, payoutCyclePendingAt: null });
    prisma.payoutMethod.findFirst.mockResolvedValue(null);
    await expect(createInvoiceNow({ supplierId: 'sup-1', now: new Date(2026, 9, 7) })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects when there is nothing to invoice', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ payoutCycle: 'TWICE_MONTHLY', payoutCyclePending: null, payoutCyclePendingAt: null });
    prisma.booking.findMany.mockResolvedValue([]);
    await expect(createInvoiceNow({ supplierId: 'sup-1', now: new Date(2026, 9, 7) })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('creates one invoice per currency for a manual request', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ payoutCycle: 'TWICE_MONTHLY', payoutCyclePending: null, payoutCyclePendingAt: null });
    prisma.booking.findMany.mockResolvedValue([
      b('b1', new Date(2026, 9, 3), 'USD', 100, 15, 85),
      b('b2', new Date(2026, 9, 4), 'EUR', 200, 30, 170),
    ]);
    prisma.__tx.invoice.create.mockResolvedValueOnce({ id: 'inv-usd', invoiceNumber: 'INV-USD', netTotal: 85, currency: 'USD' });
    prisma.__tx.invoice.create.mockResolvedValueOnce({ id: 'inv-eur', invoiceNumber: 'INV-EUR', netTotal: 170, currency: 'EUR' });

    const invoices = await createInvoiceNow({ supplierId: 'sup-1', now: new Date(2026, 9, 7) });
    expect(invoices).toHaveLength(2);
    expect(prisma.__tx.invoice.create).toHaveBeenCalledTimes(2);
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

  it('leaves a PAID invoice untouched', async () => {
    prisma.supplierProfile.findMany.mockImplementation(({ where } = {}) =>
      Promise.resolve(where && where.payoutCyclePending ? [] : [{ userId: 'sup-1', payoutCycle: 'TWICE_MONTHLY' }])
    );
    prisma.booking.findMany.mockResolvedValue([b('b1', new Date(2026, 9, 5), 'USD', 100, 15, 85)]);
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-paid', status: 'PAID' });
    const report = await generateDueInvoices(now);
    expect(report.invoicesCreated).toBe(0);
    expect(report.appendedBookings).toBe(0);
    expect(prisma.__tx.invoice.create).not.toHaveBeenCalled();
    expect(prisma.__tx.invoiceItem.createMany).not.toHaveBeenCalled();
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
      status: 'INVOICED',
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

  it('409s when the invoice is not INVOICED', async () => {
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1', status: 'PAID', items: [] });
    await expect(markInvoicePaid({ invoiceId: 'inv-1', reference: 'TRX-123', adminUserId: 'a', adminEmail: 'x' }))
      .rejects.toMatchObject({ statusCode: 409 });
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