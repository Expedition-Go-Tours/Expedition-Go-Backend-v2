jest.mock('../../src/core/services/prismaClient', () => ({
  payoutRequest: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn() },
  booking: { aggregate: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  payout: { aggregate: jest.fn() },
  invoice: { findMany: jest.fn(), aggregate: jest.fn(), findFirst: jest.fn(), create: jest.fn(), count: jest.fn() },
  payoutMethod: { findFirst: jest.fn() },
  supplierProfile: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../../src/core/services/getConfig', () => jest.fn());
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn().mockResolvedValue(undefined),
  enqueueEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn() }));
jest.mock('../../src/core/services/channelEmbeds', () => ({
  approvalPayoutRequest: jest.fn(() => ({ content: 'embed', opts: {} })),
}));

// Keep the real date helpers and the real request-window math — only the
// pieces that need a supplier or a database are stubbed. The window itself is
// stubbed here because its arithmetic is covered in payoutRuns.test.js; this
// file is about what the controller does with it.
// Spread the real module: payoutRuns needs `formatCycleLabel` at require time,
// and only these three need to be controllable here.
jest.mock('../../src/core/services/payoutCycles', () => {
  const actual = jest.requireActual('../../src/core/services/payoutCycles');
  return {
    ...actual,
    getRequestWindow: jest.fn(),
    getCurrentCycle: jest.fn(() => ({ start: new Date(2026, 9, 1), end: new Date(2026, 9, 15), label: 'Oct 1–15' })),
    getClearanceBufferDays: jest.fn(() => 7),
  };
});

jest.mock('../../src/core/services/payoutRuns', () => {
  const actual = jest.requireActual('../../src/core/services/payoutRuns');
  return {
    ...actual,
    getSupplierPayoutPlan: jest.fn(),
    getSupplierRequestWindow: jest.fn(),
    resolvePayoutMethod: jest.fn(),
    selectEligibleBookings: jest.fn(),
    createRequestsForBookings: jest.fn(),
    notifyPayoutRequestsCreated: jest.fn().mockResolvedValue(undefined),
  };
});

const prisma = require('../../src/core/services/prismaClient');
const { logActivity } = require('../../src/core/services/auditLogger');
const { getRequestWindow } = require('../../src/core/services/payoutCycles');
const {
  getSupplierPayoutPlan,
  getSupplierRequestWindow,
  resolvePayoutMethod,
  selectEligibleBookings,
  createRequestsForBookings,
  notifyPayoutRequestsCreated,
} = require('../../src/core/services/payoutRuns');
const financeController = require('../../src/core/domain/financeController');

const schedule = (over = {}) => ({
  autoManaged: true,
  cycle: 'TWICE_MONTHLY',
  scheduleLabel: 'Twice a month — paid on the 1st & 15th',
  autoRunsEnabled: true,
  nextRunAt: new Date(2026, 10, 1),
  ...over,
});

const openWindow = {
  open: true,
  opensAt: new Date(2026, 9, 15),
  closesAt: new Date(2026, 9, 17, 23, 59, 59, 999),
  cycle: { start: new Date(2026, 9, 1), end: new Date(2026, 9, 14, 23, 59, 59, 999), label: 'Oct 1–14' },
  runDay: new Date(2026, 9, 15),
  source: 'schedule',
};

const closedWindow = { ...openWindow, open: false };

const createdRequest = {
  id: 'pr1',
  requestNumber: 'PR-20261015-000001',
  currency: 'USD',
  amount: 420,
  bookingCount: 3,
  status: 'PROCESSING',
  items: [],
};

async function invoke(body = {}) {
  const req = { supplierId: 'sup1', body, user: { id: 'admin1' } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await financeController.createPayoutRequest(req, res, next);
  return { res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.payoutRequest.findFirst.mockResolvedValue(null);
  resolvePayoutMethod.mockResolvedValue({ id: 'pm1', verified: true });
  selectEligibleBookings.mockResolvedValue([{ id: 'b1', currency: 'USD', supplierPayout: 420 }]);
  createRequestsForBookings.mockResolvedValue({ requests: [createdRequest], feesDeducted: 0 });
  notifyPayoutRequestsCreated.mockResolvedValue(undefined);
  logActivity.mockResolvedValue(undefined);
  getRequestWindow.mockResolvedValue({
    open: true,
    start: new Date(2026, 9, 1),
    end: new Date(2026, 9, 15),
    label: 'Oct 1–15',
    cycle: { start: new Date(2026, 9, 1), end: new Date(2026, 9, 15), label: 'Oct 1–15' },
  });
});

describe('createPayoutRequest — enrolled suppliers', () => {
  it('refuses outside the supplier own run window, with a 409 not a TypeError', async () => {
    // The branch used to shadow the catchAsync `next` callback with a date
    // string and then call it, so it threw "next is not a function" instead of
    // returning this response. Catching that is the point of this test.
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(closedWindow);

    const { res, next } = await invoke();

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/generated automatically/i);
    expect(err.message).toMatch(/can request manually between/i);
    expect(err.message).toMatch(/next payout is scheduled for/i);
    expect(createRequestsForBookings).not.toHaveBeenCalled();
  });

  it('accepts a request while the run window is open', async () => {
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(openWindow);

    const { res, next } = await invoke();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(createRequestsForBookings).toHaveBeenCalledTimes(1);
    expect(createRequestsForBookings.mock.calls[0][0]).toMatchObject({
      supplierId: 'sup1',
      autoGenerated: false,
    });
    // Labelled with the period that run pays, matching the auto-generated run.
    expect(createRequestsForBookings.mock.calls[0][0].cycleWindow.label).toBe('Oct 1–14');
  });

  it('lets a paused scheduler fall back to a manual request at any time', async () => {
    // autoRunsEnabled:false means the window is irrelevant — funds must never
    // be stranded because the scheduler is switched off.
    getSupplierPayoutPlan.mockResolvedValue(schedule({ autoRunsEnabled: false }));
    getSupplierRequestWindow.mockReturnValue(null);

    const { res, next } = await invoke();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(getSupplierRequestWindow).not.toHaveBeenCalled();
    expect(createRequestsForBookings).toHaveBeenCalledTimes(1);
  });
});

describe('createPayoutRequest — one open request per period', () => {
  it('blocks a second request for the same period and names the open one', async () => {
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(openWindow);
    prisma.payoutRequest.findFirst.mockResolvedValue({ requestNumber: 'PR-20261015-000042' });

    const { res, next } = await invoke();

    expect(res.status).not.toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('PR-20261015-000042');
    expect(createRequestsForBookings).not.toHaveBeenCalled();
  });

  it('checks the supplier whose request this is', async () => {
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(openWindow);

    await invoke();

    const where = prisma.payoutRequest.findFirst.mock.calls[0][0].where;
    expect(where.supplierId).toBe('sup1');
    expect(where.status.in).toEqual(['PROCESSING', 'APPROVED']);
    // Terminal states must not block: rejected/cancelled requests release the
    // bookings, so the supplier is free to ask again.
    expect(where.status.in).not.toContain('REJECTED');
    expect(where.status.in).not.toContain('CANCELLED');
  });

  it('allows a request when the only open one is from a different period', async () => {
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(openWindow);
    // Nothing overlapping: the guard returns null and the request proceeds.
    prisma.payoutRequest.findFirst.mockResolvedValue(null);

    const { res } = await invoke();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('createPayoutRequest — legacy window flow', () => {
  it('refuses with a 400 when the calendar window is shut', async () => {
    getSupplierPayoutPlan.mockResolvedValue({ autoManaged: false, cycle: null });
    getRequestWindow.mockResolvedValue({
      open: false,
      start: new Date(2026, 10, 1),
      end: new Date(2026, 10, 5),
      label: 'Nov 1–15',
      cycle: { start: new Date(2026, 10, 1), end: new Date(2026, 10, 5), label: 'Nov 1–15' },
    });

    const { next } = await invoke();

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/withdrawal window is closed/i);
    expect(getSupplierRequestWindow).not.toHaveBeenCalled();
  });

  it('does not consult the schedule window when the supplier is not enrolled', async () => {
    getSupplierPayoutPlan.mockResolvedValue({ autoManaged: false, cycle: null });

    const { res } = await invoke();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(getSupplierRequestWindow).not.toHaveBeenCalled();
    expect(getRequestWindow).toHaveBeenCalled();
  });
});

// The dashboard's ability to tell the truth while a payout is in flight. The bug
// this exists to prevent: the page showed a disabled "Request payout - $0.00"
// while finance was holding $1,263.46, because the summary could report only a
// bare request *count* and nothing about the request itself.
describe('getFinanceSummary — a payout in flight', () => {
  const activeRequest = {
    id: 'pr9',
    requestNumber: 'PR-20261005-998363WCYJ',
    amount: 1263.46,
    currency: 'USD',
    status: 'PROCESSING',
    bookingCount: 12,
    autoGenerated: true,
    cycleLabel: 'Sep 28 – Oct 4',
    cycleStartDate: new Date(2026, 8, 28),
    cycleEndDate: new Date(2026, 9, 4, 23, 59, 59, 999),
    createdAt: new Date(2026, 9, 5, 0, 26),
  };

  async function invokeSummary() {
    const req = { supplierId: 'sup1' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await financeController.getFinanceSummary(req, res, next);
    return { next, data: res.json.mock.calls[0][0].data };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Two booking.aggregate calls: ELIGIBLE then PENDING.
    prisma.booking.aggregate
      .mockResolvedValueOnce({ _sum: { supplierPayout: 0 }, _count: 0 })
      .mockResolvedValueOnce({ _sum: { supplierPayout: 433.5 }, _count: 2 });
    prisma.payout.aggregate.mockResolvedValue({ _sum: { amount: 586.5 } });
    prisma.payoutRequest.findMany.mockResolvedValue([activeRequest]);
    prisma.booking.findFirst.mockResolvedValue({ travelDate: new Date(2026, 9, 6) });
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.groupBy.mockResolvedValue([
      { payoutStatus: 'PENDING', _count: { _all: 2 } },
      { payoutStatus: 'REQUESTED', _count: { _all: 12 } },
      { payoutStatus: 'CANCELLED', _count: { _all: 1 } },
    ]);
    // Finance v3: no open invoices, no paid invoices by default.
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { netTotal: 0 } });
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(closedWindow);
  });

  it('exposes the in-flight request in full, not just a count', async () => {
    const { data } = await invokeSummary();

    expect(data.inReview.requestCount).toBe(1);
    expect(data.inReview.latestRequest).toMatchObject({
      id: 'pr9',
      reference: 'PR-20261005-998363WCYJ',
      amount: 1263.46,
      status: 'PROCESSING',
      bookingCount: 12,
      // Distinguishes "you asked" from "we paid you automatically", which the
      // page shows differently.
      autoGenerated: true,
      cycleLabel: 'Sep 28 – Oct 4',
    });
    expect(data.inReview.latestRequest.createdAt).toBeInstanceOf(Date);
  });

  it('counts every payout bucket, including the empty ones', async () => {
    const { data } = await invokeSummary();

    // Every key present so the UI never has to tell 0 from missing, and so the
    // filter chips can be labelled with real numbers.
    expect(data.payoutCounts).toEqual({
      PENDING: 2,
      ELIGIBLE: 0,
      REQUESTED: 12,
      INVOICED: 0,
      PAID: 0,
      DISPUTED: 0,
      CANCELLED: 1,
    });
  });

  it('asks for the newest request first', async () => {
    await invokeSummary();

    expect(prisma.payoutRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } })
    );
  });

  it('reports null rather than omitting the key when nothing is in flight', async () => {
    prisma.payoutRequest.findMany.mockResolvedValue([]);

    const { data } = await invokeSummary();

    expect(data.inReview.latestRequest).toBeNull();
    expect(data.inReview.total).toBe(0);
  });

  it('dates the next clearance from the travel date plus the buffer', async () => {
    const { data } = await invokeSummary();

    // getClearanceBufferDays is mocked to 7 above, so a 6 Oct travel date
    // clears on 13 Oct — the date the dashboard shows instead of "pending".
    expect(data.nextEligibleAt).toEqual(new Date(2026, 9, 13));
  });

  it('promises no clearance date when nothing is pending', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);

    const { data } = await invokeSummary();

    expect(data.nextEligibleAt).toBeNull();
  });

  it('never promises a clearance date for a disputed booking', async () => {
    await invokeSummary();

    // The eligibility sweep freezes bookings under an open dispute, so the
    // promise has to be made under the same rule or the date is a lie.
    expect(prisma.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          disputes: { none: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } },
        }),
      })
    );
  });

  // ── Finance v3 ──

  it('reports the v3 "Your balance" from unpaid invoices, per currency', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: 'inv-1', invoiceNumber: 'INV-A', currency: 'USD', netTotal: 500, bookingCount: 2, cycleLabel: 'Oct 1–15', paymentScheduledAt: new Date(2026, 9, 20) },
      { id: 'inv-2', invoiceNumber: 'INV-B', currency: 'EUR', netTotal: 200, bookingCount: 1, cycleLabel: 'Oct 1–15', paymentScheduledAt: new Date(2026, 9, 20) },
    ]);

    const { data } = await invokeSummary();

    expect(data.balance.openInvoiceCount).toBe(2);
    expect(data.balance.bookingCount).toBe(3);
    expect(data.balance.byCurrency).toEqual([
      { currency: 'USD', amount: 500 },
      { currency: 'EUR', amount: 200 },
    ]);
  });

  it('shows the next-payout estimate for the pending window with processing dates', async () => {
    const { data } = await invokeSummary();

    expect(data.nextPayout).not.toBeNull();
    expect(data.nextPayout.window.cycle).toBe('TWICE_MONTHLY');
    expect(data.nextPayout.window.label).toMatch(/^\w{3} \d+–\d+$/);
    expect(data.nextPayout.window.start).toBeInstanceOf(Date);
    expect(data.nextPayout.window.end).toBeInstanceOf(Date);
    expect(data.nextPayout.window.invoicedOn).toBeInstanceOf(Date);
    expect(data.nextPayout.window.paidOn).toBeInstanceOf(Date);
    expect(data.nextPayout.bookingCount).toBe(0);
    expect(data.nextPayout.netTotal).toBe(0);
    expect(data.nextPayout.byCurrency).toEqual([]);
    // The estimate must use the finance-v3 predicate (PENDING future tours
    // included), not the v2 ELIGIBLE-only eligibility clause.
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          payoutStatus: { in: ['PENDING', 'ELIGIBLE'] },
          tour: { supplierId: 'sup1' },
        }),
      })
    );
  });

  it('returns null nextPayout for an unenrolled supplier and keeps the legacy window', async () => {
    getSupplierPayoutPlan.mockResolvedValue(schedule({ autoManaged: false, cycle: null }));
    getRequestWindow.mockReturnValue({
      open: false,
      start: new Date(2026, 9, 1),
      end: new Date(2026, 9, 15, 23, 59, 59, 999),
      label: 'Oct 1–15',
    });

    const { data } = await invokeSummary();

    expect(data.nextPayout).toBeNull();
    expect(data.withdrawalWindow).toMatchObject({ source: 'window' });
  });

  it('folds v3 paid invoices into the lifetime paid-out total', async () => {
    // Legacy Payout rows: 586.5 (beforeEach) + paid invoices: 250.
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { netTotal: 250 } });

    const { data } = await invokeSummary();

    expect(data.paidOut.total).toBe(836.5);
  });

  it('keeps the legacy v2 fields so the current Finance page keeps rendering', async () => {
    const { data } = await invokeSummary();

    expect(data.availableBalance).toBeDefined();
    expect(data.pendingClearance).toBeDefined();
    expect(data.inReview).toBeDefined();
    expect(data.withdrawalWindow).toBeDefined();
    expect(data.nextEligibleAt).toBeDefined();
    expect(data.currentCycle).toBeDefined();
    expect(data.payoutPlan).toBeDefined();
  });
});

describe('getMyInvoices — the supplier invoice history (finance v3)', () => {
  async function invokeList(query = {}) {
    const req = { supplierId: 'sup1', query };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await financeController.getMyInvoices(req, res, next);
    return { next, data: res.json.mock.calls[0][0].data };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.invoice.count.mockResolvedValue(1);
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-20261016-123456ab',
        status: 'INVOICED',
        cycle: 'TWICE_MONTHLY',
        cycleLabel: 'Oct 1–15',
        cycleStartDate: new Date(2026, 9, 1),
        cycleEndDate: new Date(2026, 9, 15, 23, 59, 59, 999),
        invoicedAt: new Date(2026, 9, 16, 0, 0),
        paymentScheduledAt: new Date(2026, 9, 20),
        paidAt: null,
        reference: null,
        grossTotal: 150,
        commissionTotal: 25.5,
        netTotal: 124.5,
        currency: 'USD',
        bookingCount: 2,
        payoutMethodId: 'pm-1',
        _count: { items: 2 },
      },
    ]);
  });

  it('returns the invoice history with money snapshots and item counts', async () => {
    const { data } = await invokeList();

    expect(data.invoices).toHaveLength(1);
    expect(data.invoices[0]).toMatchObject({
      invoiceNumber: 'INV-20261016-123456ab',
      status: 'INVOICED',
      cycleLabel: 'Oct 1–15',
      netTotal: 124.5,
      grossTotal: 150,
      commissionTotal: 25.5,
      bookingCount: 2,
      itemCount: 2,
    });
    expect(data.pagination).toEqual({ currentPage: 1, limit: 20, totalCount: 1, totalPages: 1 });
  });

  it('filters by status when asked', async () => {
    await invokeList({ status: 'PAID' });

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { supplierId: 'sup1', status: 'PAID' } })
    );
  });
});

describe('requestEarlyPayout — the manual accelerator (finance v3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates one invoice per currency for the pending window and returns 201', async () => {
    const created = [
      { id: 'inv-usd', invoiceNumber: 'INV-USD', status: 'INVOICED', cycle: 'TWICE_MONTHLY', cycleLabel: 'Oct 1–15', cycleStartDate: new Date(2026, 9, 1), cycleEndDate: new Date(2026, 9, 15, 23, 59, 59, 999), invoicedAt: new Date(2026, 9, 7), paymentScheduledAt: new Date(2026, 9, 20), paidAt: null, reference: null, grossTotal: 100, commissionTotal: 15, netTotal: 85, currency: 'USD', bookingCount: 1, payoutMethodId: 'pm-1' },
    ];
    prisma.__tx = { invoice: { create: jest.fn().mockResolvedValue(created[0]) }, invoiceItem: { createMany: jest.fn() }, booking: { updateMany: jest.fn() } };
    prisma.$transaction.mockImplementation((fn) => fn(prisma.__tx));
    prisma.supplierProfile.findUnique.mockResolvedValue({ payoutCycle: 'TWICE_MONTHLY', payoutCyclePending: null, payoutCyclePendingAt: null });
    prisma.invoice.findFirst.mockResolvedValue(null);
    resolvePayoutMethod.mockResolvedValue({ id: 'pm-1', verified: true });
    prisma.booking.findMany.mockResolvedValue([
      { id: 'b1', bookingNumber: 'BK1', travelDate: new Date(2026, 9, 3), currency: 'USD', grossAmount: 100, platformCommission: 15, supplierPayout: 85 },
    ]);

    const req = { supplierId: 'sup1', body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await financeController.requestEarlyPayout(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    const data = res.json.mock.calls[0][0].data;
    expect(data.invoices).toHaveLength(1);
    expect(data.invoices[0]).toMatchObject({ invoiceNumber: 'INV-USD', netTotal: 85, status: 'INVOICED' });
    expect(prisma.__tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { payoutStatus: 'INVOICED' } })
    );
  });

  it('propagates a 409 when an open manual invoice already exists for the window', async () => {
    prisma.__tx = { invoice: { create: jest.fn() }, invoiceItem: { createMany: jest.fn() }, booking: { updateMany: jest.fn() } };
    prisma.$transaction.mockImplementation((fn) => fn(prisma.__tx));
    prisma.supplierProfile.findUnique.mockResolvedValue({ payoutCycle: 'TWICE_MONTHLY', payoutCyclePending: null, payoutCyclePendingAt: null });
    prisma.invoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-20261007-111111aa' });

    const req = { supplierId: 'sup1', body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await financeController.requestEarlyPayout(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    expect(res.status).not.toHaveBeenCalledWith(201);
  });
});
