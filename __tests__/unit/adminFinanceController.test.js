jest.mock('../../utils/prismaClient', () => ({
  payoutRequest: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), update: jest.fn() },
  payoutMethod: { findMany: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/queue', () => ({ enqueueNotification: jest.fn(), enqueueEmail: jest.fn() }));
jest.mock('../../utils/financeHelpers', () => ({ detachBookingFromActiveRequests: jest.fn(), unfreezeBookingAfterDispute: jest.fn() }));

const prisma = require('../../utils/prismaClient');
const AppError = require('../../utils/appError');
const controller = require('../../controllers/adminFinanceController');

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
