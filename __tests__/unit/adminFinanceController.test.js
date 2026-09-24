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
