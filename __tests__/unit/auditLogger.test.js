jest.mock('../../utils/prismaClient', () => ({
  auditLog: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    deleteMany: jest.fn(),
  },
  auditLogArchive: { createMany: jest.fn() },
  $transaction: jest.fn(),
}));

const prisma = require('../../utils/prismaClient');
const logger = require('../../utils/auditLogger');

// Interactive transaction helper: runs callback with a fake tx client that
// reuses the same auditLog mocks so assertions stay on prisma.auditLog.create.
function setupTx() {
  prisma.$transaction.mockImplementation((arg) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg({
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      auditLog: prisma.auditLog,
    });
  });
}

describe('auditLogger', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    setupTx();
    prisma.auditLog.create.mockResolvedValue({ id: 'log-1' });
    prisma.auditLog.findFirst.mockResolvedValue(null);
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    prisma.auditLog.groupBy.mockResolvedValue([]);
    prisma.auditLog.deleteMany.mockResolvedValue({ count: 10 });
    prisma.auditLogArchive.createMany.mockResolvedValue({ count: 1 });
  });

  describe('logActivity', () => {
    it('creates audit log entry with all fields', async () => {
      await logger.logActivity({
        userId: 'u-1',
        userEmail: 'u@t.com',
        ipAddress: '127.0.0.1',
        userAgent: 'Chrome',
        action: 'user.login',
        resource: 'User',
        resourceId: 'u-1',
        oldValues: { name: 'Old' },
        newValues: { name: 'New' },
        metadata: { source: 'web' },
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u-1',
          userEmail: 'u@t.com',
          action: 'user.login',
          resource: 'User',
          resourceId: 'u-1',
          oldValues: { name: 'Old' },
          newValues: { name: 'New' },
          metadata: { source: 'web' },
        }),
      });
    });

    it('computes a hash chain (hash + prevHash)', async () => {
      prisma.auditLog.findFirst.mockResolvedValue({ hash: 'abc123' });

      await logger.logActivity({ userId: 'u-1', action: 'user.login', resource: 'User', metadata: {} });

      const call = prisma.auditLog.create.mock.calls[0][0].data;
      expect(call.prevHash).toBe('abc123');
      expect(call.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sets null prevHash for the first entry', async () => {
      prisma.auditLog.findFirst.mockResolvedValue(null);

      await logger.logActivity({ userId: 'u-1', action: 'user.login', resource: 'User', metadata: {} });

      const call = prisma.auditLog.create.mock.calls[0][0].data;
      expect(call.prevHash).toBeNull();
      expect(call.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('handles null oldValues and newValues', async () => {
      await logger.logActivity({ userId: 'u-1', action: 'test', resource: 'Test', metadata: {} });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ oldValues: null, newValues: null }) })
      );
    });

    it('handles database errors without throwing', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('DB error'));
      await expect(logger.logActivity({ userId: 'u-1', action: 'test', resource: 'Test', metadata: {} })).resolves.not.toThrow();
    });
  });

  describe('logSecurityEvent', () => {
    it('logs security event via logActivity', async () => {
      await logger.logSecurityEvent({ userId: 'u-1', ipAddress: '1.2.3.4', event: 'brute_force', severity: 'high' });

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'security.brute_force', resource: 'Security' }),
        })
      );
    });
  });

  describe('logAuthEvent', () => {
    it('logs successful auth event', async () => {
      await logger.logAuthEvent({ userId: 'u-1', userEmail: 'u@t.com', event: 'login', success: true });

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'auth.login', resource: 'Authentication' }),
        })
      );
    });

    it('logs failed auth event', async () => {
      await logger.logAuthEvent({ userId: 'u-1', event: 'login', success: false });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'auth.login', resource: 'Authentication' }),
        })
      );
    });
  });

  describe('logPaymentEvent', () => {
    it('logs payment event with metadata', async () => {
      await logger.logPaymentEvent({ userId: 'u-1', bookingId: 'b-1', paymentIntentId: 'pi-1', amount: 100, currency: 'USD', event: 'succeeded' });

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'payment.succeeded', resource: 'Payment', resourceId: 'pi-1' }),
        })
      );
    });
  });

  describe('getAuditLogs', () => {
    it('returns paginated audit logs', async () => {
      prisma.auditLog.findMany.mockResolvedValue([{ id: 'log-1' }]);
      prisma.auditLog.count.mockResolvedValue(25);

      const result = await logger.getAuditLogs({ page: 2, limit: 10 });

      expect(result.logs).toHaveLength(1);
      expect(result.pagination.currentPage).toBe(2);
      expect(result.pagination.totalPages).toBe(3);
      expect(result.pagination.totalCount).toBe(25);
    });

    it('filters by userId, action, resource, email, resourceId, date range', async () => {
      const filters = {
        userId: 'u-1',
        userEmail: 'u@t.com',
        resourceId: 'r-1',
        action: 'login',
        resource: 'User',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      };
      await logger.getAuditLogs(filters);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'u-1',
            resourceId: 'r-1',
            resource: 'User',
            userEmail: { contains: 'u@t.com', mode: 'insensitive' },
            createdAt: expect.objectContaining({ gte: expect.any(Date), lte: expect.any(Date) }),
          }),
        })
      );
    });

    it('re-throws database errors', async () => {
      prisma.auditLog.findMany.mockRejectedValue(new Error('Query failed'));
      await expect(logger.getAuditLogs({})).rejects.toThrow('Query failed');
    });
  });

  describe('getAuditStats', () => {
    it('returns aggregated stats', async () => {
      prisma.auditLog.count.mockResolvedValueOnce(500);
      prisma.auditLog.groupBy.mockResolvedValueOnce([{ action: 'user.login', _count: 200 }]);
      prisma.auditLog.groupBy.mockResolvedValueOnce([{ resource: 'User', _count: 300 }]);
      prisma.auditLog.count.mockResolvedValueOnce(50);
      prisma.auditLog.findMany.mockResolvedValueOnce([{ id: 'log-1' }]);

      const result = await logger.getAuditStats(30);

      expect(result.totalLogs).toBe(500);
      expect(result.logsByAction).toEqual([{ action: 'user.login', _count: 200 }]);
      expect(result.logsByResource).toEqual([{ resource: 'User', _count: 300 }]);
      expect(result.securityEvents).toBe(50);
      expect(result.recentActivity).toHaveLength(1);
      expect(result.period).toBe('30 days');
    });

    it('re-throws errors', async () => {
      prisma.auditLog.count.mockRejectedValue(new Error('Stats error'));
      await expect(logger.getAuditStats()).rejects.toThrow('Stats error');
    });
  });

  describe('verifyAuditChain', () => {
    it('reports verified=true when chain is intact', async () => {
      const entry1 = { id: 'a', createdAt: new Date(), action: 'x', resource: 'R', prevHash: null, hash: 'h1' };
      const result = await logger.verifyAuditChain();
      expect(result).toEqual({
        verified: true,
        total: 0,
        breaks: [],
        firstBreakAt: null,
        firstBreakId: null,
      });
    });
  });

  describe('cleanupOldLogs', () => {
    it('archives (not deletes) logs older than specified days', async () => {
      const expired = [
        { id: 'old-1', userId: null, userEmail: null, ipAddress: null, userAgent: null, action: 'x', resource: 'R', resourceId: null, oldValues: null, newValues: null, metadata: null, prevHash: 'p', hash: 'h', createdAt: new Date() },
      ];
      prisma.auditLog.findMany.mockResolvedValueOnce(expired).mockResolvedValueOnce([]);

      const result = await logger.cleanupOldLogs(90);

      expect(prisma.auditLogArchive.createMany).toHaveBeenCalled();
      expect(prisma.auditLog.deleteMany).toHaveBeenCalled();
      expect(result).toEqual({ success: true, archivedCount: 1, cutoffDate: expect.any(Date) });
    });

    it('handles errors without throwing', async () => {
      prisma.auditLog.findMany.mockRejectedValue(new Error('Cleanup error'));
      const result = await logger.cleanupOldLogs(90);
      expect(result).toEqual({ success: false, error: 'Cleanup error' });
    });
  });
});
