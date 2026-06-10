jest.mock('../../utils/adminNotificationService', () => ({
  getNotifications: jest.fn(),
  acknowledgeNotification: jest.fn(),
  acknowledgeAll: jest.fn(),
  getStats: jest.fn(),
}));

const adminNotifService = require('../../utils/adminNotificationService');
const controller = require('../../controllers/adminNotificationController');

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
      expect(adminNotifService.acknowledgeNotification).toHaveBeenCalledWith('an1', 'admin-1');
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
    it('acknowledges all notifications', async () => {
      await controller.acknowledgeAll(req, res, next);
      expect(adminNotifService.acknowledgeAll).toHaveBeenCalledWith('admin-1');
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
});
