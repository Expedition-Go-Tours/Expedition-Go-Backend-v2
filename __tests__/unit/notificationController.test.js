jest.mock('../../utils/notificationService', () => ({
  getUserNotifications: jest.fn(),
  markNotificationAsRead: jest.fn(),
  markAllNotificationsAsRead: jest.fn(),
  deleteNotification: jest.fn(),
}));

const notifService = require('../../utils/notificationService');
const controller = require('../../controllers/notificationController');

describe('notificationController', () => {
  let req, res, next;

  const mockResult = {
    notifications: [{ id: 'n1', type: 'BOOKING_CONFIRMED', title: 'Booking Confirmed', message: 'msg', read: false, createdAt: new Date() }],
    pagination: { currentPage: 1, totalPages: 1, totalCount: 1, unreadCount: 1, limit: 20 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'u-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    notifService.getUserNotifications.mockResolvedValue(mockResult);
    notifService.markNotificationAsRead.mockResolvedValue({ success: true });
    notifService.markAllNotificationsAsRead.mockResolvedValue({ success: true, count: 3 });
    notifService.deleteNotification.mockResolvedValue({ success: true });
  });

  // ============================
  // getNotifications
  // ============================
  describe('getNotifications', () => {
    it('returns notifications with pagination', async () => {
      await controller.getNotifications(req, res, next);
      expect(notifService.getUserNotifications).toHaveBeenCalledWith('u-1', { page: 1, limit: 20, unreadOnly: false });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: mockResult }));
    });

    it('passes unreadOnly=true when query param is "true"', async () => {
      req.query = { unreadOnly: 'true' };
      await controller.getNotifications(req, res, next);
      expect(notifService.getUserNotifications).toHaveBeenCalledWith('u-1', expect.objectContaining({ unreadOnly: true }));
    });

    it('passes custom page and limit', async () => {
      req.query = { page: '2', limit: '10' };
      await controller.getNotifications(req, res, next);
      expect(notifService.getUserNotifications).toHaveBeenCalledWith('u-1', expect.objectContaining({ page: 2, limit: 10 }));
    });
  });

  // ============================
  // markAsRead
  // ============================
  describe('markAsRead', () => {
    it('marks notification as read', async () => {
      req.params = { id: 'n1' };
      await controller.markAsRead(req, res, next);
      expect(notifService.markNotificationAsRead).toHaveBeenCalledWith('n1', 'u-1');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 404 when notification not found', async () => {
      req.params = { id: 'n1' };
      notifService.markNotificationAsRead.mockResolvedValue({ success: false, error: 'Not found' });
      await controller.markAsRead(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // markAllAsRead
  // ============================
  describe('markAllAsRead', () => {
    it('marks all notifications as read', async () => {
      await controller.markAllAsRead(req, res, next);
      expect(notifService.markAllNotificationsAsRead).toHaveBeenCalledWith('u-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: '3 notifications marked as read' }));
    });

    it('returns 500 on failure', async () => {
      notifService.markAllNotificationsAsRead.mockResolvedValue({ success: false, error: 'Failed' });
      await controller.markAllAsRead(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
    });
  });

  // ============================
  // deleteNotification
  // ============================
  describe('deleteNotification', () => {
    it('deletes notification and returns 204', async () => {
      req.params = { id: 'n1' };
      await controller.deleteNotification(req, res, next);
      expect(notifService.deleteNotification).toHaveBeenCalledWith('n1', 'u-1');
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('returns 404 when notification not found', async () => {
      req.params = { id: 'n1' };
      notifService.deleteNotification.mockResolvedValue({ success: false, error: 'Not found' });
      await controller.deleteNotification(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });
});
