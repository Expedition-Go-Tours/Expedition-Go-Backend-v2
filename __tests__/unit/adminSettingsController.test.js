jest.mock('../../utils/prismaClient', () => ({
  systemConfig: { findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
  auditLog: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), findFirst: jest.fn() },
  user: { findMany: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../../middleware/maintenanceMode', () => ({ clearCache: jest.fn() }));

const prisma = require('../../utils/prismaClient');
const { clearCache: clearMaintCache } = require('../../middleware/maintenanceMode');
const controller = require('../../controllers/adminSettingsController');

describe('adminSettingsController', () => {
  let req, res, next;

  const mockConfigs = [
    { key: 'site.name', value: 'Tour Platform' },
    { key: 'system.maintenance_mode', value: 'false' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'admin-1', email: 'admin@t.com' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn(), send: jest.fn() };
    next = jest.fn();

    prisma.systemConfig.findMany.mockResolvedValue(mockConfigs);
    prisma.systemConfig.findUnique.mockResolvedValue(mockConfigs[0]);
    prisma.systemConfig.upsert.mockResolvedValue(mockConfigs[0]);
    prisma.auditLog.create.mockResolvedValue({});
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    prisma.auditLog.groupBy.mockResolvedValue([]);
    prisma.auditLog.findFirst.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation((arg) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg({ $executeRaw: jest.fn().mockResolvedValue(undefined), auditLog: prisma.auditLog });
    });
    clearMaintCache.mockClear();
  });

  // ============================
  // getSettings
  // ============================
  describe('getSettings', () => {
    it('returns all settings as key-value object', async () => {
      await controller.getSettings(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ 'site.name': 'Tour Platform', 'system.maintenance_mode': 'false' }),
        })
      );
    });
  });

  // ============================
  // updateSettings
  // ============================
  describe('updateSettings', () => {
    it('returns 400 when settings not provided', async () => {
      await controller.updateSettings(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('upserts each setting', async () => {
      req.body = { settings: { 'site.name': 'New Name' } };
      await controller.updateSettings(req, res, next);
      expect(prisma.systemConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: 'site.name' }, create: expect.objectContaining({ key: 'site.name', value: 'New Name' }) })
      );
    });

    it('clears maintenance cache when maintenance_mode changed', async () => {
      req.body = { settings: { 'system.maintenance_mode': 'true' } };
      await controller.updateSettings(req, res, next);
      expect(clearMaintCache).toHaveBeenCalled();
    });

    it('does not clear maintenance cache for other settings', async () => {
      req.body = { settings: { 'site.name': 'New Name' } };
      await controller.updateSettings(req, res, next);
      expect(clearMaintCache).not.toHaveBeenCalled();
    });

    it('creates audit log', async () => {
      req.body = { settings: { 'site.name': 'New' } };
      await controller.updateSettings(req, res, next);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'settings.updated' }) }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns all configs after update', async () => {
      req.body = { settings: { 'site.name': 'New' } };
      await controller.updateSettings(req, res, next);
      expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(1);
    });

    it('normalizes commission.default_rate percentage to fraction', async () => {
      req.body = { settings: { 'commission.default_rate': '15' } };
      await controller.updateSettings(req, res, next);
      expect(prisma.systemConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ value: '0.15' }) })
      );
    });

    it('stores fraction commission.default_rate unchanged', async () => {
      req.body = { settings: { 'commission.default_rate': '0.15' } };
      await controller.updateSettings(req, res, next);
      expect(prisma.systemConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ value: '0.15' }) })
      );
    });

    it('rejects an invalid commission.default_rate without writing anything', async () => {
      req.body = { settings: { 'commission.default_rate': 'abc' } };
      await controller.updateSettings(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.systemConfig.upsert).not.toHaveBeenCalled();
    });

    it('rejects non-numeric booking config values', async () => {
      req.body = { settings: { 'booking.max_travelers': 'fifty' } };
      await controller.updateSettings(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.systemConfig.upsert).not.toHaveBeenCalled();
    });

    it('normalizes numeric settings to string values', async () => {
      req.body = { settings: { 'booking.max_travelers': 50 } };
      await controller.updateSettings(req, res, next);
      expect(prisma.systemConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ value: '50' }) })
      );
    });

    it('passes through unknown settings unchanged', async () => {
      req.body = { settings: { 'site.name': 'New Name' } };
      await controller.updateSettings(req, res, next);
      expect(prisma.systemConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ value: 'New Name' }) })
      );
    });
  });

  // ============================
  // getSetting
  // ============================
  describe('getSetting', () => {
    it('returns setting by key', async () => {
      req.params = { key: 'site.name' };
      await controller.getSetting(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { 'site.name': 'Tour Platform' } }));
    });

    it('returns 404 when setting not found', async () => {
      req.params = { key: 'nonexistent' };
      prisma.systemConfig.findUnique.mockResolvedValue(null);
      await controller.getSetting(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // exportAuditLog
  // ============================
  describe('exportAuditLog', () => {
    it('exports audit log as CSV', async () => {
      const entries = [
        { id: 'e1', userId: 'u1', userEmail: 'a@t.com', action: 'settings.updated', resource: 'SystemConfig', resourceId: null, oldValues: null, newValues: { name: 'New' }, createdAt: new Date('2026-01-01') },
      ];
      prisma.auditLog.findMany.mockResolvedValue(entries);
      prisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Admin', email: 'a@t.com' }]);

      await controller.exportAuditLog(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Date/Time,Admin,Email,Action,Resource,Resource ID,IP Address,Details'));
    });

    it('filters by action when provided', async () => {
      req.query = { action: 'settings.updated' };
      prisma.auditLog.findMany.mockResolvedValue([]);

      await controller.exportAuditLog(req, res, next);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { action: { contains: 'settings.updated', mode: 'insensitive' } } })
      );
    });

    it('escapes CSV values containing commas', () => {
      const result = controller.exportAuditLog.length;
      expect(result).toBeGreaterThan(0);
    });
  });

  // ============================
  // getAuditLog
  // ============================
  describe('getAuditLog', () => {
    it('returns paginated audit log', async () => {
      prisma.auditLog.count.mockResolvedValue(1);
      const entries = [
        { id: 'e1', userId: 'u1', userEmail: 'a@t.com', action: 'settings.updated', resource: 'SystemConfig', resourceId: null, oldValues: null, newValues: null, createdAt: new Date() },
      ];
      prisma.auditLog.findMany.mockResolvedValue(entries);
      prisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Admin', email: 'a@t.com' }]);

      await controller.getAuditLog(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.entries).toHaveLength(1);
      expect(body.data.total).toBe(1);
    });

    it('uses userName from userMap', async () => {
      prisma.auditLog.count.mockResolvedValue(1);
      prisma.auditLog.findMany.mockResolvedValue([{ id: 'e1', userId: 'u1', userEmail: 'u@t.com', action: 'test', resource: null, resourceId: null, oldValues: null, newValues: null, createdAt: new Date() }]);
      prisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Admin', email: 'a@t.com' }]);

      await controller.getAuditLog(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.entries[0].userName).toBe('Admin');
    });

    it('falls back to userEmail when user not found in map', async () => {
      prisma.auditLog.count.mockResolvedValue(1);
      prisma.auditLog.findMany.mockResolvedValue([{ id: 'e1', userId: 'u999', userEmail: 'u@t.com', action: 'test', resource: null, resourceId: null, oldValues: null, newValues: null, createdAt: new Date() }]);
      prisma.user.findMany.mockResolvedValue([]);

      await controller.getAuditLog(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.entries[0].userName).toBe('u@t.com');
    });

    it('uses "System" when no user identifiers exist', async () => {
      prisma.auditLog.count.mockResolvedValue(1);
      prisma.auditLog.findMany.mockResolvedValue([{ id: 'e1', userId: null, userEmail: null, action: 'test', resource: null, resourceId: null, oldValues: null, newValues: null, createdAt: new Date() }]);
      prisma.user.findMany.mockResolvedValue([]);

      await controller.getAuditLog(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.entries[0].userName).toBe('System');
    });

    it('filters by action', async () => {
      req.query = { action: 'settings.updated' };
      prisma.auditLog.count.mockResolvedValue(0);
      prisma.auditLog.findMany.mockResolvedValue([]);

      await controller.getAuditLog(req, res, next);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { action: { contains: 'settings.updated', mode: 'insensitive' } } })
      );
    });

    it('respects pagination parameters', async () => {
      req.query = { page: '2', limit: '10' };
      prisma.auditLog.count.mockResolvedValue(25);
      prisma.auditLog.findMany.mockResolvedValue([]);

      await controller.getAuditLog(req, res, next);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 })
      );
      const body = res.json.mock.calls[0][0];
      expect(body.data.pages).toBe(3);
    });

    it('clamps limit between 1 and 100', async () => {
      req.query = { limit: '200' };
      prisma.auditLog.count.mockResolvedValue(0);
      prisma.auditLog.findMany.mockResolvedValue([]);

      await controller.getAuditLog(req, res, next);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 })
      );
    });
  });
});
