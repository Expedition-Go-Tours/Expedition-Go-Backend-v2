jest.mock('../../utils/prismaClient', () => ({
  auditLog: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), deleteMany: jest.fn() },
}));

const prisma = require('../../utils/prismaClient');
const logger = require('../../utils/auditLogger');

describe('auditLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.auditLog.create.mockResolvedValue({ id: 'log-1' });
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    prisma.auditLog.groupBy.mockResolvedValue([]);
    prisma.auditLog.deleteMany.mockResolvedValue({ count: 10 });
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

    it('filters by userId, action, resource, date range', async () => {
      const filters = {
        userId: 'u-1',
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
            resource: 'User',
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

  describe('cleanupOldLogs', () => {
    it('deletes logs older than specified days', async () => {
      const result = await logger.cleanupOldLogs(90);
      expect(prisma.auditLog.deleteMany).toHaveBeenCalled();
      expect(result).toEqual({ success: true, deletedCount: 10 });
    });

    it('handles errors without throwing', async () => {
      prisma.auditLog.deleteMany.mockRejectedValue(new Error('Cleanup error'));
      const result = await logger.cleanupOldLogs(90);
      expect(result).toEqual({ success: false, error: 'Cleanup error' });
    });
  });
});
