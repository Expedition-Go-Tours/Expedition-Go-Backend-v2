jest.mock('../../src/core/services/adminNotificationService', () => ({
  getNotifications: jest.fn(),
  acknowledgeNotification: jest.fn(),
  acknowledgeAll: jest.fn(),
  getStats: jest.fn(),
}));

const adminNotifService = require('../../src/core/services/adminNotificationService');
const controller = require('../../src/core/domain/adminNotificationController');

describe('adminNotificationController', () => {
  let req, res, next;

  const mockResult = {
    notifications: [{ id: 'an1', type: 'SUPPLIER_APPLIED', title: 'New Supplier', acknowledged: false, createdAt: new Date() }],
    pagination: { currentPage: 1, totalPages: 1, totalCount: 1, unacknowledgedCount: 1, limit: 20 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    adminNotifService.getNotifications.mockResolvedValue(mockResult);
    adminNotifService.acknowledgeNotification.mockResolvedValue({ success: true });
    adminNotifService.acknowledgeAll.mockResolvedValue({ success: true, count: 2 });
    adminNotifService.getStats.mockResolvedValue({ total: 10, unacknowledged: 5 });
  });

  describe('getNotifications', () => {
    it('returns admin notifications', async () => {
      await controller.getNotifications(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: mockResult }));
    });

    it('passes unacknowledgedOnly filter', async () => {
      req.query = { unacknowledgedOnly: 'true' };
      await controller.getNotifications(req, res, next);
      expect(adminNotifService.getNotifications).toHaveBeenCalledWith(
        expect.objectContaining({ unacknowledgedOnly: true })
      );
    });
  });

  describe('getUnreadCount', () => {
    it('returns unacknowledged count', async () => {
      await controller.getUnreadCount(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: { unacknowledgedCount: 1 } })
      );
    });
  });

  describe('acknowledge', () => {
    it('acknowledges a notification', async () => {
      req.params = { id: 'an1' };
      await controller.acknowledge(req, res, next);
      // The write carries the same permission + brand scope as the read, so a
      // crafted id outside the admin's visibility can never be acknowledged.
      expect(adminNotifService.acknowledgeNotification).toHaveBeenCalledWith('an1', 'admin-1', expect.objectContaining({ AND: expect.any(Array) }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 404 on failure', async () => {
      req.params = { id: 'an1' };
      adminNotifService.acknowledgeNotification.mockResolvedValue({ success: false });
      await controller.acknowledge(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('acknowledgeAll', () => {
    it('acknowledges all notifications within the admin\'s permission scope', async () => {
      await controller.acknowledgeAll(req, res, next);
      expect(adminNotifService.acknowledgeAll).toHaveBeenCalledWith('admin-1', expect.any(Object));
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: '2 notifications acknowledged' }));
    });
  });

  describe('getStats', () => {
    it('returns notification stats', async () => {
      await controller.getStats(req, res, next);
      expect(adminNotifService.getStats).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { total: 10, unacknowledged: 5 } }));
    });
  });

  describe('visibility composition', () => {
    const whereFor = async () => {
      await controller.getNotifications(req, res, next);
      return adminNotifService.getNotifications.mock.calls[0][0].where;
    };

    it('applies permission and brand scopes independently under $and', async () => {
      req.user = { id: 'admin-1', permissionKeys: ['bookings.view'] };
      req.brandKey = 'ghana';
      const where = await whereFor();

      expect(where.AND).toHaveLength(2);
      // Permission scope: restricted to the types this role may see.
      expect(where.AND[0]).toEqual({ OR: expect.any(Array) });
      expect(where.AND[0].OR.some((c) => c.type && c.type.in)).toBe(true);
      // Brand scope survives the merge instead of overwriting the permission OR.
      expect(where.AND[1]).toEqual({ storefront: 'ghana' });
    });

    it('keeps the permission filter on a non-Ghana brand', async () => {
      req.user = { id: 'admin-1', permissionKeys: ['bookings.view'] };
      req.brandKey = 'africa';
      const where = await whereFor();

      // Regression: spread-merging used to let the brand OR replace the
      // permission OR, silently exposing every notification type.
      expect(where.AND[0]).toEqual({ OR: expect.any(Array) });
      expect(where.AND[1]).toEqual({
        OR: [{ storefront: null }, { storefront: { not: 'ghana' } }],
      });
    });

    it('honours an explicit brand on the request over the user role', async () => {
      req.user = { id: 'admin-1', roles: ['ghana'] };
      req.brandKey = 'ghana';
      const where = await whereFor();
      expect(where.AND[1]).toEqual({ storefront: 'ghana' });
    });

    it('restricts a permission-less role to types that need no permission', async () => {
      req.user = { id: 'admin-1', permissionKeys: [] };
      req.brandKey = 'ghana';
      const where = await whereFor();

      const typeIn = where.AND[0].OR.find((c) => c.type && c.type.in).type.in;
      // SYSTEM_ALERT declares an empty permission list → always visible.
      expect(typeIn).toContain('SYSTEM_ALERT');
      // Gated types stay hidden even with an empty permission set.
      expect(typeIn).not.toContain('NEW_SUPPLIER_APPLICATION');
      expect(typeIn).not.toContain('PAYOUT_NEEDS_APPROVAL');
    });
  });

  describe('types filter', () => {
    const whereFor = async () => {
      await controller.getNotifications(req, res, next);
      return adminNotifService.getNotifications.mock.calls[0][0].where;
    };
    const lastPart = (where) => where.AND[where.AND.length - 1];

    it('adds a type filter without touching the visibility scopes', async () => {
      req.brandKey = 'ghana';
      req.query = { types: 'BOOKING_CREATED,BOOKING_CONFIRMED' };
      const where = await whereFor();

      expect(where.AND).toHaveLength(3);
      expect(lastPart(where)).toEqual({ type: { in: ['BOOKING_CREATED', 'BOOKING_CONFIRMED'] } });
      expect(where.AND[1]).toEqual({ storefront: 'ghana' });
    });

    it('ignores unknown type values', async () => {
      req.query = { types: 'BOOKING_CREATED,NOT_A_REAL_TYPE' };
      const where = await whereFor();
      expect(lastPart(where)).toEqual({ type: { in: ['BOOKING_CREATED'] } });
    });

    it('matches nothing when every requested type is invalid', async () => {
      req.query = { types: 'DROP TABLE,__;bogus' };
      const where = await whereFor();
      // Never falls back to an unfiltered feed.
      expect(lastPart(where)).toEqual({ type: { in: [] } });
    });

    it('omits the filter entirely when the parameter is absent', async () => {
      req.query = {};
      const where = await whereFor();
      expect(where.AND).toHaveLength(2);
    });

    it('omits the filter when the parameter is empty', async () => {
      req.query = { types: '' };
      const where = await whereFor();
      expect(where.AND).toHaveLength(2);
    });

    it('tolerates whitespace and duplicates in the list', async () => {
      req.query = { types: ' SYSTEM_ALERT , SYSTEM_ALERT ,' };
      const where = await whereFor();
      expect(lastPart(where)).toEqual({ type: { in: ['SYSTEM_ALERT'] } });
    });
  });

  describe('search filter', () => {
    const whereFor = async () => {
      await controller.getNotifications(req, res, next);
      return adminNotifService.getNotifications.mock.calls[0][0].where;
    };
    const lastPart = (where) => where.AND[where.AND.length - 1];

    it('searches title and message case-insensitively', async () => {
      req.query = { search: 'payout' };
      const where = await whereFor();
      expect(lastPart(where)).toEqual({
        OR: [
          { title: { contains: 'payout', mode: 'insensitive' } },
          { message: { contains: 'payout', mode: 'insensitive' } },
        ],
      });
    });

    it('combines search with a type filter', async () => {
      req.query = { search: 'payout', types: 'PAYOUT_NEEDS_APPROVAL' };
      const where = await whereFor();
      expect(where.AND).toHaveLength(3);
      // Both request filters land in the same extra clause, alongside — not on
      // top of — the permission and brand scopes.
      expect(where.AND[2].type).toEqual({ in: ['PAYOUT_NEEDS_APPROVAL'] });
      expect(where.AND[2].OR).toHaveLength(2);
    });

    it('ignores a blank search term', async () => {
      req.query = { search: '   ' };
      const where = await whereFor();
      expect(where.AND).toHaveLength(2);
    });

    it('caps an oversized search term', async () => {
      req.query = { search: 'x'.repeat(500) };
      const where = await whereFor();
      expect(lastPart(where).OR[0].title.contains).toHaveLength(200);
    });
  });

  describe('getStats read-state', () => {
    it('scopes stats to unread when asked', async () => {
      req.query = { unacknowledgedOnly: 'true' };
      await controller.getStats(req, res, next);
      const where = adminNotifService.getStats.mock.calls[0][0];
      expect(where.AND).toEqual(expect.arrayContaining([
        expect.objectContaining({ acknowledged: false }),
      ]));
    });

    it('leaves stats unfiltered by default', async () => {
      req.query = {};
      await controller.getStats(req, res, next);
      const where = adminNotifService.getStats.mock.calls[0][0];
      expect(where.AND).toHaveLength(2);
    });
  });
});
