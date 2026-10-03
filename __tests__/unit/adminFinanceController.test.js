jest.mock('../../src/core/services/prismaClient', () => ({
  payoutRequest: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), update: jest.fn() },
  payoutMethod: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  supplierProfile: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  booking: { aggregate: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../src/core/services/queue', () => ({ enqueueNotification: jest.fn(), enqueueEmail: jest.fn() }));
jest.mock('../../src/core/services/financeHelpers', () => ({ detachBookingFromActiveRequests: jest.fn(), unfreezeBookingAfterDispute: jest.fn() }));

const prisma = require('../../src/core/services/prismaClient');
const AppError = require('../../src/core/services/appError');
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
    // Fri 2 Oct 2026 → next runs: weekly Mon 5 Oct, twice-monthly 15 Oct,
    // monthly 1 Nov. The order must follow those dates, not insertion order.
    jest.setSystemTime(new Date(2026, 9, 2, 10, 0, 0));
    try {
      const rows = [profile('MONTHLY', 'Zed'), profile('WEEKLY', 'Ann'), profile('TWICE_MONTHLY', 'Bob')];
      prisma.supplierProfile.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows);
      prisma.supplierProfile.groupBy.mockResolvedValue([]);
      prisma.supplierProfile.count.mockResolvedValue(0);
      prisma.payoutMethod.findMany.mockResolvedValue([]);
      prisma.booking.aggregate.mockResolvedValue({ _sum: { supplierPayout: 0 }, _count: 0 });

      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await controller.getPayoutSchedules({ query: {} }, res, jest.fn());

      const payload = res.json.mock.calls[0][0].data;
      expect(payload.schedules.map((s) => s.plan.cycle)).toEqual(['WEEKLY', 'TWICE_MONTHLY', 'MONTHLY']);
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
