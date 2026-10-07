jest.mock('../../src/core/services/prismaClient', () => ({
  payoutRequest: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), update: jest.fn() },
  payoutMethod: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  supplierProfile: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  booking: { aggregate: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  tour: { findMany: jest.fn() },
  invoice: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), findUnique: jest.fn() },
  invoiceItem: { findMany: jest.fn(), delete: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn().mockResolvedValue(undefined) }));
// Key-aware: getMinThreshold and autoRunsEnabled both read through this, and
// without it every schedule falls to defaults — minimum threshold 0, runs on —
// which makes two of the five readiness reasons untestable.
jest.mock('../../src/core/services/getConfig', () => {
  const fn = jest.fn(async (key, defaultValue) => {
    if (key === 'payout.min_threshold') return fn.__minThreshold ?? 0;
    if (key === 'payout.auto_generate_enabled') return fn.__autoRuns ?? 'true';
    return defaultValue;
  });
  fn.clearCache = () => {};
  return fn;
});
jest.mock('../../src/core/services/queue', () => ({ enqueueNotification: jest.fn(() => Promise.resolve()), enqueueEmail: jest.fn(() => Promise.resolve()) }));
// Spreading the real module matters: the controller also pulls
// payoutBookingsWhere / eligibleBookingsWhere from here, and stubbing this
// module with only the two transaction helpers used to make those undefined
// and blow up every schedule query.
jest.mock('../../src/core/services/financeHelpers', () => {
  const actual = jest.requireActual('../../src/core/services/financeHelpers');
  return {
    ...actual,
    detachBookingFromActiveRequests: jest.fn(),
    unfreezeBookingAfterDispute: jest.fn(),
  };
});

const prisma = require('../../src/core/services/prismaClient');
const getConfig = require('../../src/core/services/getConfig');
const AppError = require('../../src/core/services/appError');
const { eligibleBookingsWhere } = require('../../src/core/services/financeHelpers');
const controller = require('../../src/core/domain/adminFinanceController');

describe('adminFinanceController.completePayoutRequest — reference validation', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: { id: 'pr-1' }, body: {}, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    prisma.payoutRequest.findFirst.mockResolvedValue({
      id: 'pr-1',
      supplierId: 's-1',
      items: [],
      payoutMethod: { type: 'BANK_TRANSFER' },
    });
  });

  const expectBadRequest = async (reference) => {
    req.body = { reference };
    await controller.completePayoutRequest(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(400);
    expect(res.json).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  it('rejects a missing reference', () => expectBadRequest(undefined));
  it('rejects a whitespace-only reference', () => expectBadRequest('   '));
  it('rejects placeholder junk like "test"', () => expectBadRequest('test'));
  it('rejects "n/a" case-insensitively', () => expectBadRequest('N/A'));
  it('rejects references shorter than 4 characters', () => expectBadRequest('ab'));
  it('rejects references longer than 100 characters', () => expectBadRequest('x'.repeat(101)));
});

describe('adminFinanceController.getPayoutSchedules — triage order', () => {
  const profile = (cycle, name) => ({
    id: `sp-${name}`,
    userId: `u-${name}`,
    status: 'ACTIVE',
    payoutCycle: cycle,
    payoutCycleEffectiveAt: new Date(2026, 9, 1),
    payoutCyclePending: null,
    payoutCyclePendingAt: null,
    user: { id: `u-${name}`, name, email: `${name.toLowerCase()}@example.com` },
  });

  it('lists the supplier whose payout run is due soonest first', async () => {
    jest.useFakeTimers();
    // Fri 2 Oct 2026 → next runs: twice-monthly 15 Oct (Ann, Bob), monthly
    // 1 Nov (Zed). The order must follow those dates, then name, not insertion.
    jest.setSystemTime(new Date(2026, 9, 2, 10, 0, 0));
    try {
      const rows = [profile('MONTHLY', 'Zed'), profile('TWICE_MONTHLY', 'Ann'), profile('TWICE_MONTHLY', 'Bob')];
      prisma.supplierProfile.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows);
      prisma.supplierProfile.groupBy.mockResolvedValue([]);
      prisma.supplierProfile.count.mockResolvedValue(0);
      prisma.payoutMethod.findMany.mockResolvedValue([]);
      // Batched page aggregate: grouped by tour, mapped back to supplier. An
      // empty array means no supplier has anything eligible.
      prisma.booking.groupBy.mockResolvedValue([]);

      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await controller.getPayoutSchedules({ query: {} }, res, jest.fn());

      const payload = res.json.mock.calls[0][0].data;
      expect(payload.schedules.map((s) => s.plan.cycle)).toEqual(['TWICE_MONTHLY', 'TWICE_MONTHLY', 'MONTHLY']);
      expect(payload.pagination.totalCount).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('adminFinanceController.getPayoutRequests — column sort', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    prisma.payoutRequest.findMany.mockResolvedValue([]);
    prisma.payoutRequest.count.mockResolvedValue(0);
    prisma.payoutRequest.groupBy.mockResolvedValue([]);
  });

  /** Pull the orderBy Prisma was actually called with. */
  const orderBy = () => prisma.payoutRequest.findMany.mock.calls[0][0].orderBy;

  const run = async () => {
    await controller.getPayoutRequests(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.payoutRequest.findMany).toHaveBeenCalledTimes(1);
  };

  it('defaults to newest first with a deterministic tie-break', async () => {
    await run();
    expect(orderBy()).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('sorts by amount descending when asked', async () => {
    req.query.sortBy = 'amount';
    req.query.sortOrder = 'desc';
    await run();
    expect(orderBy()).toEqual([{ amount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('honours ascending order', async () => {
    req.query.sortBy = 'createdAt';
    req.query.sortOrder = 'asc';
    await run();
    expect(orderBy()[0]).toEqual({ createdAt: 'asc' });
  });

  it('always tie-breaks so pagination cannot repeat or skip rows', async () => {
    req.query.sortBy = 'requestNumber';
    req.query.sortOrder = 'asc';
    await run();
    const ob = orderBy();
    expect(ob).toHaveLength(3);
    expect(ob[1]).toEqual({ createdAt: 'desc' });
    expect(ob[2]).toEqual({ id: 'desc' });
  });

  // The whitelist is the only thing standing between a query param and
  // `orderBy`. If it ever widens to pass-through, this test starts failing.
  it('ignores an unknown column instead of forwarding it to Prisma', async () => {
    req.query.sortBy = 'supplierId';
    await run();
    expect(orderBy()).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('ignores a prototype-pollution style column name', async () => {
    req.query.sortBy = '__proto__';
    await run();
    expect(orderBy()).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('treats an unrecognised direction as descending', async () => {
    req.query.sortBy = 'amount';
    req.query.sortOrder = 'ASC; DROP TABLE payoutRequest';
    await run();
    expect(orderBy()[0]).toEqual({ amount: 'desc' });
  });

  it('passes a comma-separated status list through for non-exclusive facets', async () => {
    req.query.status = 'PROCESSING, APPROVED ,PROCESSING';
    await run();
    expect(prisma.payoutRequest.findMany.mock.calls[0][0].where.status).toEqual({
      in: ['PROCESSING', 'APPROVED', 'PROCESSING'],
    });
  });
});

describe('adminFinanceController.getPayoutRequests — bookingCount', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    prisma.payoutRequest.count.mockResolvedValue(0);
    prisma.payoutRequest.groupBy.mockResolvedValue([]);
  });

  const runWith = async (items) => {
    prisma.payoutRequest.findMany.mockResolvedValue(
      items.map((it, i) => ({ id: `pr-${i}`, amount: '100.00', supplierId: 's-1', items: it })),
    );
    await controller.getPayoutRequests(req, res, next);
    expect(next).not.toHaveBeenCalled();
    return res.json.mock.calls[0][0].data.requests;
  };

  // The client type declares bookingCount but the endpoint used to omit it,
  // so the Bookings column was blank and the dialogs said "undefined bookings".
  it('emits bookingCount derived from the included items', async () => {
    const out = await runWith([
      [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }],
      [{ id: 'i4' }],
      [],
    ]);
    expect(out.map((r) => r.bookingCount)).toEqual([3, 1, 0]);
  });

  it('reports 0 rather than undefined when a request somehow has no items array', async () => {
    prisma.payoutRequest.findMany.mockResolvedValue([
      { id: 'pr-x', amount: '10.00', supplierId: 's-1' },
    ]);
    await controller.getPayoutRequests(req, res, next);
    const out = res.json.mock.calls[0][0].data.requests;
    expect(out[0].bookingCount).toBe(0);
  });
});

// The reason a run will or will not fire. A zero in the "Eligible now" column
// is meaningless on its own — the schedules list is 38 zeros out of 40
// suppliers — so the reason has to be right, and it has to be the first thing
// that would make the scheduler skip this supplier.
describe('adminFinanceController.getPayoutSchedules — readiness', () => {
  const profile = {
    id: 'sp-1',
    userId: 'u-1',
    status: 'ACTIVE',
    payoutCycle: 'TWICE_MONTHLY',
    payoutCycleEffectiveAt: new Date(2026, 9, 1),
    payoutCyclePending: null,
    payoutCyclePendingAt: null,
    user: { id: 'u-1', name: 'Acme Tours', email: 'acme@example.com' },
  };

  /** amount = every booking is its own tour, so amount === booking count. */
  const readiness = async ({ method = true, amounts = [], minThreshold = 0, autoRuns = 'true' }) => {
    getConfig.__minThreshold = minThreshold;
    getConfig.__autoRuns = autoRuns;

    prisma.supplierProfile.findMany.mockResolvedValue([profile]);
    prisma.supplierProfile.groupBy.mockResolvedValue([]);
    prisma.supplierProfile.count.mockResolvedValue(0);
    prisma.payoutMethod.findMany.mockResolvedValue(method ? [{ supplierId: 'u-1' }] : []);
    prisma.booking.groupBy.mockResolvedValue(
      amounts.map((amount, i) => ({ tourId: `t-${i}`, _sum: { supplierPayout: amount }, _count: { _all: 1 } })),
    );
    prisma.tour.findMany.mockResolvedValue(
      amounts.map((_, i) => ({ id: `t-${i}`, supplierId: 'u-1' })),
    );

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.getPayoutSchedules({ query: {} }, res, jest.fn());
    if (!res.json.mock.calls[0]) throw new Error('response not produced');
    return res.json.mock.calls[0][0].data.schedules[0].readiness;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getConfig.__minThreshold = 0;
    getConfig.__autoRuns = 'true';
  });

  it('reports NO_METHOD first — a destination is what the run needs', async () => {
    // Funds and threshold are both satisfied; the missing method still wins.
    const r = await readiness({ method: false, amounts: [500], minThreshold: 10 });
    expect(r.code).toBe('NO_METHOD');
    expect(r.kind).toBe('blocked');
    expect(r.detail).toBeTruthy();
  });

  it('reports NOTHING_ELIGIBLE when there is a method but no money', async () => {
    const r = await readiness({ amounts: [] });
    expect(r.code).toBe('NOTHING_ELIGIBLE');
    expect(r.kind).toBe('idle');
  });

  it('reports BELOW_MINIMUM when the pot is under the configured floor', async () => {
    const r = await readiness({ amounts: [10], minThreshold: 50 });
    expect(r.code).toBe('BELOW_MINIMUM');
    // The label must name the floor, or the number is not actionable.
    expect(r.label).toContain('50.00');
  });

  it('reports SCHEDULER_PAUSED only when nothing else is wrong', async () => {
    const r = await readiness({ amounts: [500], minThreshold: 10, autoRuns: 'false' });
    expect(r.code).toBe('SCHEDULER_PAUSED');
  });

  it('reports READY when funds, method, floor and switch all pass', async () => {
    const r = await readiness({ amounts: [500], minThreshold: 10, autoRuns: 'true' });
    expect(r.code).toBe('READY');
    expect(r.kind).toBe('ready');
  });

  it('does not flag the pause when the supplier has no method anyway', async () => {
    // Leading with the global switch would bury the supplier-specific fault.
    const r = await readiness({ method: false, amounts: [], autoRuns: 'false' });
    expect(r.code).toBe('NO_METHOD');
  });
});


describe('adminFinanceController.getSupplierEligibleBookings', () => {
  const profile = {
    id: 'sp-1',
    userId: 'u-1',
    status: 'ACTIVE',
    payoutCycle: 'TWICE_MONTHLY',
    payoutCycleEffectiveAt: new Date(2026, 9, 1),
    payoutCyclePending: null,
    payoutCyclePendingAt: null,
    user: { id: 'u-1', name: 'Acme Tours', email: 'acme@example.com' },
  };

  const call = async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await controller.getSupplierEligibleBookings({ params: { supplierId: 'u-1' } }, res, next);
    return { res, next };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getConfig.__minThreshold = 0;
    getConfig.__autoRuns = 'true';
    prisma.supplierProfile.findUnique.mockResolvedValue(profile);
    prisma.payoutMethod.count.mockResolvedValue(1);
  });

  const rows = [
    // Fri 2 Oct 2026 → next TWICE_MONTHLY run Thu 15 Oct, covering Oct 1–14.
    // One booking falls inside that window, one does not — the endpoint must
    // still return the shared predicate untouched (windows are applied only
    // when a request is actually built, so the list cannot disagree with pay).
    { id: 'b-in', bookingNumber: 'GHA-100', travelDate: new Date(2026, 9, 5), supplierPayout: 100, currency: 'USD', status: 'COMPLETED', paymentStatus: 'SUCCEEDED', createdAt: new Date(2026, 9, 1), tour: { title: 'Kakum Canopy Walk' } },
    { id: 'b-out', bookingNumber: 'GHA-200', travelDate: new Date(2026, 8, 10), supplierPayout: 50, currency: 'USD', status: 'CONFIRMED', paymentStatus: 'SUCCEEDED', createdAt: new Date(2026, 8, 20), tour: { title: 'Cape Coast Castle' } },
  ];

  it('queries with the shared predicate, so it cannot disagree with what gets paid', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 9, 2, 10, 0, 0));
    try {
      prisma.booking.findMany.mockResolvedValue([]);
      const { res } = await call();
      const where = prisma.booking.findMany.mock.calls[0][0].where;
      expect(where).toEqual(eligibleBookingsWhere('u-1'));
      expect(res.status).toHaveBeenCalledWith(200);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns the line items, and a total equal to the sum of the rows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 9, 2, 10, 0, 0));
    try {
      prisma.booking.findMany.mockResolvedValue(rows);
      const { res } = await call();
      const data = res.json.mock.calls[0][0].data;

      expect(data.bookings).toHaveLength(2);
      expect(data.eligibleBalance.bookingCount).toBe(2);
      // The expanded detail must total exactly what the row cell claims.
      expect(data.eligibleBalance.amount).toBe(
        data.bookings.reduce((s, b) => s + b.supplierPayout, 0),
      );
      expect(data.bookings.map((b) => b.tourTitle)).toEqual(['Kakum Canopy Walk', 'Cape Coast Castle']);
      expect(data.readiness.code).toBe('READY');
    } finally {
      jest.useRealTimers();
    }
  });

  it('marks bookings outside the labelled window and reports the straddle', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 9, 2, 10, 0, 0));
    try {
      prisma.booking.findMany.mockResolvedValue(rows);
      const { res } = await call();
      const data = res.json.mock.calls[0][0].data;

      expect(data.period).not.toBeNull();
      expect(data.period.label).toBeTruthy();

      const byId = Object.fromEntries(data.bookings.map((b) => [b.id, b]));
      // 5 Oct sits inside Oct 1–14; 10 Sep predates the window.
      expect(byId['b-in'].inPeriod).toBe(true);
      expect(byId['b-out'].inPeriod).toBe(false);
      // Genuine and normal: the pot is "cleared so far", the label is the run.
      expect(data.straddlesPeriod).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sorts longest-waiting money first', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 9, 2, 10, 0, 0));
    try {
      prisma.booking.findMany.mockResolvedValue([...rows].reverse());
      await call();
      expect(prisma.booking.findMany.mock.calls[0][0].orderBy).toEqual([
        { travelDate: 'asc' },
        { createdAt: 'asc' },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('404s for a supplier that does not exist', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue(null);
    const { res, next } = await call();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Finance v3 — admin invoice queue
// ---------------------------------------------------------------------------
const { enqueueNotification } = require('../../src/core/services/queue');

describe('adminFinanceController.getInvoices (v3)', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'admin-1', email: 'a@x.com' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  it('lists invoices with supplier context and per-status totals', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-20261016-0001',
        status: 'INVOICED',
        grossTotal: '100',
        commissionTotal: '17',
        netTotal: '83',
        currency: 'USD',
        bookingCount: 1,
        items: [{ id: 'i1' }],
        supplier: { id: 's1', name: 'Supplier One', email: 's@t.com' },
        payoutMethod: null,
      },
    ]);
    prisma.invoice.count.mockResolvedValue(1);
    prisma.invoice.groupBy.mockResolvedValue([
      { status: 'INVOICED', _count: { _all: 1 }, _sum: { netTotal: '83' } },
    ]);

    await controller.getInvoices(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0].data;
    expect(data.invoices[0].netTotal).toBe(83);
    expect(data.invoices[0].bookingCount).toBe(1);
    expect(data.pagination.totalCount).toBe(1);
    expect(data.summary.statusCounts.INVOICED).toBe(1);
    expect(data.summary.totalAmount).toBe(83);
  });

  it('filters by comma-separated status and passes search to counts', async () => {
    req.query = { status: 'INVOICED,PAID', search: 'INV-2026' };
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoice.count.mockResolvedValue(0);
    prisma.invoice.groupBy.mockResolvedValue([]);

    await controller.getInvoices(req, res, next);

    const where = prisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['INVOICED', 'PAID']);
    expect(where.OR).toBeDefined();
    const countWhere = prisma.invoice.count.mock.calls[0][0].where;
    expect(countWhere.OR).toBeDefined();
  });

  it('sorts only whitelisted columns and rejects prototype keys', async () => {
    req.query = { sortBy: 'netTotal', sortOrder: 'asc' };
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoice.count.mockResolvedValue(0);
    prisma.invoice.groupBy.mockResolvedValue([]);

    await controller.getInvoices(req, res, next);
    expect(prisma.invoice.findMany.mock.calls[0][0].orderBy[0]).toEqual({ netTotal: 'asc' });

    req.query = { sortBy: '__proto__', sortOrder: 'desc' };
    await controller.getInvoices(req, res, next);
    // Falls back to newest-first because __proto__ is not whitelisted.
    expect(prisma.invoice.findMany.mock.calls[1][0].orderBy[0]).toEqual({ createdAt: 'desc' });
  });
});

describe('adminFinanceController.getInvoiceById (v3)', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: { id: 'inv-1' }, body: {}, user: { id: 'admin-1', email: 'a@x.com' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  it('returns the invoice with booking line items (money as numbers)', async () => {
    prisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-20261016-0001',
      status: 'PAID',
      grossTotal: '100',
      commissionTotal: '17',
      netTotal: '83',
      bookingCount: 1,
      supplier: { id: 's1' },
      payoutMethod: null,
      items: [
        {
          id: 'i1',
          grossAmount: '100',
          platformCommission: '17',
          supplierPayout: '83',
          currency: 'USD',
          booking: { id: 'bk-1', bookingNumber: 'BK-1', status: 'CONFIRMED', paymentStatus: 'PAID', payoutStatus: 'PAID', customer: { name: 'C' }, tour: { title: 'T' } },
        },
      ],
    });

    await controller.getInvoiceById(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    const invoice = res.json.mock.calls[0][0].data.invoice;
    expect(invoice.netTotal).toBe(83);
    expect(typeof invoice.items[0].supplierPayout).toBe('number');
    expect(invoice.items[0].supplierPayout).toBe(83);
  });

  it('404s for an unknown invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue(null);
    await controller.getInvoiceById(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});

describe('adminFinanceController.markInvoicePaid (v3)', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: { id: 'inv-1' }, body: {}, user: { id: 'admin-1', email: 'a@x.com' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  it('rejects a missing reference without touching the database', async () => {
    req.body = {};
    await controller.markInvoicePaid(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('marks the invoice paid and notifies the supplier', async () => {
    const tx = {
      invoice: { update: jest.fn().mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-20261016-0001', status: 'PAID', reference: 'WB-1420' }) },
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(tx));
    prisma.invoice.findUnique
      .mockResolvedValueOnce({ id: 'inv-1', invoiceNumber: 'INV-20261016-0001', status: 'INVOICED', items: [{ bookingId: 'bk-1' }] })
      .mockResolvedValueOnce({ invoiceNumber: 'INV-20261016-0001', supplierId: 's-1', currency: 'USD', netTotal: '83', reference: 'WB-1420', paidAt: new Date() });
    req.body = { reference: 'WB-1420' };

    await controller.markInvoicePaid(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(tx.invoice.update).toHaveBeenCalled();
    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['bk-1'] } }, data: { payoutStatus: 'PAID' } })
    );
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 's-1', type: 'INVOICE_PAID' })
    );
  });
});
