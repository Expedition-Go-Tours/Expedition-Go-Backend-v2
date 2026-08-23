jest.mock('../../utils/prismaClient', () => ({
  payout: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn().mockResolvedValue([]) },
  payoutRequest: { groupBy: jest.fn().mockResolvedValue([]) },
  payoutMethod: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  booking: { findMany: jest.fn() },
  supplierProfile: { update: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
}));

jest.mock('../../utils/queue', () => ({ enqueueNotification: jest.fn(), enqueueEmail: jest.fn() }));
jest.mock('../../utils/adminNotificationService', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/getConfig', () => jest.fn().mockResolvedValue('10'));

const prisma = require('../../utils/prismaClient');
const { enqueueNotification, enqueueEmail } = require('../../utils/queue');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const { logActivity } = require('../../utils/auditLogger');
const getConfig = require('../../utils/getConfig');
const controller = require('../../controllers/payoutController');

describe('payoutController', () => {
  let req, res, next;

  const mockPayout = {
    id: 'p-1',
    supplierId: 's-1',
    bookingId: 'b-1',
    amount: '500',
    fee: '10',
    commissionAmount: '10',
    currency: 'USD',
    status: 'PENDING',
    reason: null,
    reference: 'REF-001',
    notes: 'Test',
    paymentMethod: 'BANK_TRANSFER',
    approvedAt: new Date(),
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    booking: { bookingNumber: 'BN-001', total: '500', tour: { title: 'Tour' }, customer: { name: 'C', email: 'c@t.com' } },
    payoutMethod: { type: 'BANK_TRANSFER', bankName: 'Bank', paypalEmail: null },
    supplier: { name: 'Supplier', email: 's@t.com' },
  };

  const mockSupplier = { id: 's-1', name: 'Supplier', email: 's@t.com' };

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn(), send: jest.fn() };
    next = jest.fn();

    prisma.payout.findMany.mockResolvedValue([mockPayout]);
    prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, supplier: mockSupplier });
    prisma.payout.count.mockResolvedValue(1);
    prisma.payout.update.mockResolvedValue(mockPayout);
    prisma.payout.aggregate.mockResolvedValue({ _sum: { amount: 5000, fee: 200 } });
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.supplierProfile.update.mockResolvedValue({});
    prisma.payoutMethod.findFirst.mockResolvedValue({ id: 'pm-1', type: 'BANK_TRANSFER', isDefault: true });
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.$transaction.mockImplementation((arg) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg({ payout: prisma.payout, supplierProfile: prisma.supplierProfile });
    });
    enqueueNotification.mockResolvedValue();
    enqueueEmail.mockResolvedValue();
    notifyAdmin.mockResolvedValue();
    logActivity.mockResolvedValue();
    getConfig.mockResolvedValue('10');
  });

  // ============================
  // getMyPayouts
  // ============================
  describe('getMyPayouts', () => {
    it('returns supplier payouts with pagination', async () => {
      req.user = { id: 's-1' };
      req.supplierId = 's-1';
      await controller.getMyPayouts(req, res, next);

      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ supplierId: 's-1' }) })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ payouts: expect.any(Array), pagination: expect.any(Object) }) })
      );
    });

    it('filters by status when provided', async () => {
      req.user = { id: 's-1' };
      req.supplierId = 's-1';
      req.query = { status: 'PAID' };
      await controller.getMyPayouts(req, res, next);
      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'PAID' }) })
      );
    });

    it('supports pagination', async () => {
      req.user = { id: 's-1' };
      req.supplierId = 's-1';
      req.query = { page: '2', limit: '10' };
      prisma.payout.count.mockResolvedValue(25);
      await controller.getMyPayouts(req, res, next);
      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 })
      );
      const body = res.json.mock.calls[0][0];
      expect(body.data.pagination.totalPages).toBe(3);
    });
  });

  // ============================
  // getAllPayouts (admin)
  // ============================
  describe('getAllPayouts', () => {
    it('returns all pending/approved payouts with pagination', async () => {
      await controller.getAllPayouts(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ payouts: expect.any(Array) }) })
      );
    });

    it('filters by status', async () => {
      req.query = { status: 'PENDING' };
      await controller.getAllPayouts(req, res, next);
      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'PENDING' }) })
      );
    });

    it('handles pagination', async () => {
      req.query = { page: '1', limit: '5' };
      prisma.payout.count.mockResolvedValue(12);
      await controller.getAllPayouts(req, res, next);
      const body = res.json.mock.calls[0][0];
      expect(body.data.pagination.totalPages).toBe(3);
    });

    it('returns statusCounts for each lifecycle status', async () => {
      prisma.payout.groupBy.mockResolvedValue([
        { status: 'PENDING', _count: { _all: 2 } },
        { status: 'PROCESSING', _count: { _all: 1 } },
        { status: 'PAID', _count: { _all: 7 } },
      ]);
      await controller.getAllPayouts(req, res, next);
      const body = res.json.mock.calls[0][0];
      expect(body.data.statusCounts).toEqual({
        PENDING: 2,
        APPROVED: 0,
        PROCESSING: 1,
        PAID: 7,
        FAILED: 0,
        CANCELLED: 0,
      });
    });

    it('filters by search across supplier and booking', async () => {
      req.query = { search: 'john' };
      await controller.getAllPayouts(req, res, next);
      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              expect.objectContaining({
                OR: expect.arrayContaining([
                  expect.objectContaining({ supplier: expect.objectContaining({ name: expect.objectContaining({ contains: 'john' }) }) }),
                ]),
              }),
            ],
          }),
        })
      );
    });
  });

  // ============================
  // approvePayout (admin)
  // ============================
  describe('approvePayout', () => {
    it('returns 400 when payout does not meet min threshold', async () => {
      req.params = { id: 'p-1' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, amount: '5' });
      await controller.approvePayout(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 when payout not in PENDING status', async () => {
      req.params = { id: 'p-1' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, status: 'PAID' });
      await controller.approvePayout(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when payout not found', async () => {
      req.params = { id: 'nonexistent' };
      prisma.payout.findUnique.mockResolvedValue(null);
      await controller.approvePayout(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('approves payout and sends notifications', async () => {
      req.params = { id: 'p-1' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, payoutMethod: null, supplier: mockSupplier });

      await controller.approvePayout(req, res, next);

      expect(prisma.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'p-1' }, data: expect.objectContaining({ status: 'APPROVED' }) })
      );
      expect(enqueueNotification).toHaveBeenCalled();
      expect(enqueueEmail).toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout.approved' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handles notification failures gracefully', async () => {
      req.params = { id: 'p-1' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, payoutMethod: null, supplier: mockSupplier });
      enqueueNotification.mockRejectedValue(new Error('Queue error'));

      await controller.approvePayout(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // releasePayout (admin)
  // ============================
  describe('releasePayout', () => {
    it('returns 404 when payout not found', async () => {
      req.params = { id: 'nonexistent' };
      prisma.payout.findUnique.mockResolvedValue(null);
      await controller.releasePayout(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when payout not in APPROVED status', async () => {
      req.params = { id: 'p-1' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, status: 'PENDING' });
      await controller.releasePayout(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('releases payout in transaction', async () => {
      req.params = { id: 'p-1' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, status: 'APPROVED', amount: '500', supplier: mockSupplier });

      await controller.releasePayout(req, res, next);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(enqueueNotification).toHaveBeenCalled();
      expect(enqueueEmail).toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout.released' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handles queue failures gracefully', async () => {
      req.params = { id: 'p-1' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, status: 'APPROVED', amount: '500', supplier: mockSupplier });
      enqueueNotification.mockRejectedValue(new Error('Queue error'));

      await controller.releasePayout(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('moves APPROVED to PROCESSING (in transit), not PAID', async () => {
      req.params = { id: 'p-1' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, status: 'APPROVED', amount: '500', supplier: mockSupplier });

      await controller.releasePayout(req, res, next);

      expect(prisma.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSING' }) })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout.released' }));
    });
  });

  // ============================
  // settlePayout (admin)
  // ============================
  describe('settlePayout', () => {
    it('returns 404 when payout not found', async () => {
      req.params = { id: 'nonexistent' };
      prisma.payout.findUnique.mockResolvedValue(null);
      await controller.settlePayout(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when payout not in PROCESSING status', async () => {
      req.params = { id: 'p-1' };
      req.body = { reference: 'TXN-1' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, status: 'APPROVED' });
      await controller.settlePayout(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('settles a PROCESSING payout to PAID with reference', async () => {
      req.params = { id: 'p-1' };
      req.body = { reference: 'TXN-9' };
      prisma.payout.findUnique.mockResolvedValue({
        ...mockPayout,
        status: 'PROCESSING',
        supplier: mockSupplier,
        paymentMethod: 'BANK_TRANSFER',
        payoutMethodId: 'pm-1',
      });

      await controller.settlePayout(req, res, next);

      expect(prisma.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PAID',
            paidAt: expect.any(Date),
            reference: 'TXN-9',
          }),
        })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout.settled' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // failPayout (admin)
  // ============================
  describe('failPayout', () => {
    it('returns 400 when no reason provided', async () => {
      req.params = { id: 'p-1' };
      await controller.failPayout(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when payout not found', async () => {
      req.params = { id: 'nonexistent' };
      req.body = { reason: 'Insufficient funds' };
      prisma.payout.findUnique.mockResolvedValue(null);
      await controller.failPayout(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('fails payout with reason', async () => {
      req.params = { id: 'p-1' };
      req.body = { reason: 'Bank details invalid' };
      prisma.payout.findUnique.mockResolvedValue({ ...mockPayout, status: 'APPROVED', supplier: mockSupplier });

      await controller.failPayout(req, res, next);

      expect(prisma.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', notes: 'Bank details invalid' }) })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout.failed' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // getPayoutSummary (admin)
  // ============================
  describe('getPayoutSummary', () => {
    it('returns payout summary with lifecycle stats', async () => {
      prisma.payout.aggregate
        .mockResolvedValueOnce({ _count: 2, _sum: { amount: 1000 } })
        .mockResolvedValueOnce({ _count: 1, _sum: { amount: 500 } })
        .mockResolvedValueOnce({ _count: 3, _sum: { amount: 1500 } })
        .mockResolvedValueOnce({ _count: 1, _sum: { amount: 100 } })
        .mockResolvedValueOnce({ _count: 4, _sum: { amount: 4000, commissionAmount: 200 } });
      prisma.$queryRaw.mockResolvedValue([
        { month: new Date('2026-01-01'), count: 4, totalAmount: '4000', commission: '200' },
      ]);

      await controller.getPayoutSummary(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(res.status).toHaveBeenCalledWith(200);
      expect(body.data.pending).toEqual(expect.objectContaining({ count: 2, total: 1000 }));
      expect(body.data.processing).toEqual(expect.objectContaining({ count: 3, total: 1500 }));
      expect(body.data.approved).toEqual(expect.objectContaining({ count: 1, total: 500 }));
      expect(body.data.failed).toEqual(expect.objectContaining({ count: 1, total: 100 }));
      expect(body.data.outstanding).toEqual(expect.objectContaining({ count: 4, total: 2000 }));
      expect(body.data.paidThisMonth).toEqual(expect.objectContaining({ count: 4, total: 4000, commission: 200 }));
      expect(body.data.avgCommission).toBeCloseTo(0.05);
      expect(body.data.monthlyBreakdown).toEqual(expect.any(Array));
    });
  });

  // ============================
  // exportPayouts (admin)
  // ============================
  describe('exportPayouts', () => {
    it('exports payouts as CSV', async () => {
      prisma.payout.findMany.mockResolvedValue([mockPayout]);
      prisma.payout.count.mockResolvedValue(1);

      await controller.exportPayouts(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('ID'));
    });

    it('filters by status, supplierId, and date range', async () => {
      req.query = { status: 'PAID', supplierId: 's-1', startDate: '2026-01-01', endDate: '2026-12-31' };
      prisma.payout.findMany.mockResolvedValue([]);
      prisma.payout.count.mockResolvedValue(0);

      await controller.exportPayouts(req, res, next);

      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'PAID', supplierId: 's-1' }) })
      );
    });

    it('filters by search term', async () => {
      req.query = { search: 'safari co' };
      prisma.payout.findMany.mockResolvedValue([]);
      prisma.payout.count.mockResolvedValue(0);

      await controller.exportPayouts(req, res, next);

      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              expect.objectContaining({
                OR: expect.arrayContaining([
                  expect.objectContaining({ booking: expect.objectContaining({ bookingNumber: expect.objectContaining({ contains: 'safari co' }) }) }),
                ]),
              }),
            ],
          }),
        })
      );
    });

    it('handles empty payouts export', async () => {
      prisma.payout.findMany.mockResolvedValue([]);
      prisma.payout.count.mockResolvedValue(0);

      await controller.exportPayouts(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('ID'));
    });
  });
});
