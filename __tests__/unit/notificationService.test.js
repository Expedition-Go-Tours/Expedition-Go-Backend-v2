jest.mock('../../utils/prismaClient', () => ({
  notification: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
  user: { findUnique: jest.fn() },
}));

jest.mock('../../utils/emailService', () => ({ sendEmail: jest.fn() }));

let mockIo;
jest.mock('../../app', () => {
  mockIo = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
  return { get: jest.fn(() => mockIo) };
});

const prisma = require('../../utils/prismaClient');
const { sendEmail } = require('../../utils/emailService');
const app = require('../../app');

const {
  sendNotification,
  sendWebSocketNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  sendBulkNotifications,
  cleanupOldNotifications,
  getNotificationStats,
} = require('../../utils/notificationService');

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// sendNotification
// ---------------------------------------------------------------------------
describe('sendNotification', () => {
  const mockNotif = { id: 'n1', type: 'BOOKING_CONFIRMED', title: 'Booking Confirmed', message: 'Your booking is confirmed', data: {}, createdAt: new Date(), read: false };
  const mockUser = { id: 'u-1', name: 'John', email: 'john@test.com', language: 'en' };

  beforeEach(() => {
    prisma.notification.create.mockResolvedValue(mockNotif);
    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.notification.update.mockResolvedValue({ ...mockNotif, emailSent: true, emailSentAt: new Date() });
  });

  it('creates notification and returns success', async () => {
    const result = await sendNotification({ userId: 'u-1', type: 'BOOKING_CONFIRMED', title: 'Booking Confirmed', message: 'msg' });
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'u-1', type: 'BOOKING_CONFIRMED' }) })
    );
    expect(result.success).toBe(true);
    expect(result.notificationId).toBe('n1');
  });

  it('returns error when user not found', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const result = await sendNotification({ userId: 'u-1', type: 'BOOKING_CONFIRMED', title: 'T', message: 'M' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('User not found');
  });

  it('sends WebSocket notification', async () => {
    await sendNotification({ userId: 'u-1', type: 'BOOKING_CONFIRMED', title: 'T', message: 'M' });
    expect(mockIo.to).toHaveBeenCalledWith('user:u-1');
    expect(mockIo.emit).toHaveBeenCalledWith('notification', expect.objectContaining({ type: 'BOOKING_CONFIRMED' }));
  });

  it('sends email notification when shouldSendEmail is true', async () => {
    await sendNotification({ userId: 'u-1', type: 'BOOKING_CONFIRMED', title: 'T', message: 'M', sendEmail: true });
    expect(sendEmail).toHaveBeenCalled();
    expect(prisma.notification.update).toHaveBeenCalled();
  });

  it('skips email when user has no email', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...mockUser, email: null });
    await sendNotification({ userId: 'u-1', type: 'BOOKING_CONFIRMED', title: 'T', message: 'M', sendEmail: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('handles email send failure gracefully', async () => {
    sendEmail.mockRejectedValue(new Error('SMTP error'));
    await sendNotification({ userId: 'u-1', type: 'BOOKING_CONFIRMED', title: 'T', message: 'M', sendEmail: true });
  });

  it('uses custom template when provided', async () => {
    await sendNotification({ userId: 'u-1', type: 'BOOKING_CONFIRMED', title: 'T', message: 'M', sendEmail: true, emailTemplate: 'custom-template' });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ template: 'custom-template' }));
  });

  it('handles prisma error gracefully', async () => {
    prisma.notification.create.mockRejectedValue(new Error('DB error'));
    const result = await sendNotification({ userId: 'u-1', type: 'BOOKING_CONFIRMED', title: 'T', message: 'M' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendWebSocketNotification
// ---------------------------------------------------------------------------
describe('sendWebSocketNotification', () => {
  it('sends notification to user room', async () => {
    await sendWebSocketNotification('u-1', { type: 'TEST', title: 'Test' });
    expect(mockIo.to).toHaveBeenCalledWith('user:u-1');
    expect(mockIo.emit).toHaveBeenCalledWith('notification', { type: 'TEST', title: 'Test' });
  });

  it('does not mirror per-user important types to the admin room', async () => {
    // Admins receive their own durable AdminNotification rows for these events;
    // mirroring the per-user event to admin-room produced invisible socket-only
    // notifications (no row), so the mirror was removed.
    for (const type of ['SUPPLIER_APPROVED', 'BOOKING_CONFIRMED', 'REVIEW_RECEIVED']) {
      jest.clearAllMocks();
      await sendWebSocketNotification('u-1', { type });
      expect(mockIo.to).toHaveBeenCalledWith('user:u-1');
      expect(mockIo.to).not.toHaveBeenCalledWith('admin-room');
      expect(mockIo.emit).not.toHaveBeenCalledWith('admin-notification', expect.objectContaining({ type }));
    }
  });

  it('does not send to admin room for other types', async () => {
    jest.clearAllMocks();
    await sendWebSocketNotification('u-1', { type: 'GENERIC' });
    expect(mockIo.to).not.toHaveBeenCalledWith('admin-room');
  });

  it('handles missing io gracefully', async () => {
    app.get.mockReturnValue(null);
    await sendWebSocketNotification('u-1', { type: 'TEST' });
  });

  it('handles error gracefully', async () => {
    app.get.mockImplementation(() => { throw new Error('App error'); });
    await sendWebSocketNotification('u-1', { type: 'TEST' });
  });
});

// ---------------------------------------------------------------------------
// getUserNotifications
// ---------------------------------------------------------------------------
describe('getUserNotifications', () => {
  it('returns notifications with pagination', async () => {
    const notifs = [{ id: 'n1', type: 'BOOKING_CONFIRMED', read: false, createdAt: new Date() }];
    prisma.notification.findMany.mockResolvedValue(notifs);
    prisma.notification.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);

    const result = await getUserNotifications('u-1', { page: 1, limit: 20 });
    expect(result.notifications).toEqual(notifs);
    expect(result.pagination.unreadCount).toBe(1);
    expect(result.pagination.totalCount).toBe(1);
  });

  it('filters unread only', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await getUserNotifications('u-1', { page: 1, limit: 20, unreadOnly: true });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u-1', read: false } })
    );
  });
});

// ---------------------------------------------------------------------------
// markNotificationAsRead
// ---------------------------------------------------------------------------
describe('markNotificationAsRead', () => {
  it('marks notification as read', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    const result = await markNotificationAsRead('n1', 'u-1');
    expect(result.success).toBe(true);
  });

  it('returns error when notification not found', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    const result = await markNotificationAsRead('n1', 'u-1');
    expect(result.success).toBe(false);
  });

  it('handles prisma error', async () => {
    prisma.notification.updateMany.mockRejectedValue(new Error('DB error'));
    const result = await markNotificationAsRead('n1', 'u-1');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// markAllNotificationsAsRead
// ---------------------------------------------------------------------------
describe('markAllNotificationsAsRead', () => {
  it('marks all notifications as read', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 5 });
    const result = await markAllNotificationsAsRead('u-1');
    expect(result.success).toBe(true);
    expect(result.count).toBe(5);
  });

  it('handles error gracefully', async () => {
    prisma.notification.updateMany.mockRejectedValue(new Error('DB error'));
    const result = await markAllNotificationsAsRead('u-1');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteNotification
// ---------------------------------------------------------------------------
describe('deleteNotification', () => {
  it('deletes notification', async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 1 });
    const result = await deleteNotification('n1', 'u-1');
    expect(result.success).toBe(true);
  });

  it('returns error when not found', async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 0 });
    const result = await deleteNotification('n1', 'u-1');
    expect(result.success).toBe(false);
  });

  it('handles error gracefully', async () => {
    prisma.notification.deleteMany.mockRejectedValue(new Error('DB error'));
    const result = await deleteNotification('n1', 'u-1');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendBulkNotifications
// ---------------------------------------------------------------------------
describe('sendBulkNotifications', () => {
  it('sends multiple notifications', async () => {
    prisma.notification.create.mockResolvedValue({ id: 'n1', type: 'TEST', createdAt: new Date() });
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', name: 'John', email: 'john@test.com', language: 'en' });

    const result = await sendBulkNotifications([
      { userId: 'u-1', type: 'TEST', title: 'T1', message: 'M1' },
      { userId: 'u-1', type: 'TEST', title: 'T2', message: 'M2' },
    ]);
    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
  });

  it('reports failed individual notifications', async () => {
    prisma.notification.create.mockRejectedValue(new Error('DB error'));
    const result = await sendBulkNotifications([{ userId: 'u-1', type: 'TEST', title: 'T', message: 'M' }]);
    expect(result.success).toBe(true);
    expect(result.failed).toBe(1);
    expect(result.successful).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupOldNotifications
// ---------------------------------------------------------------------------
describe('cleanupOldNotifications', () => {
  it('deletes old read notifications', async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 10 });
    const result = await cleanupOldNotifications(90);
    expect(result.success).toBe(true);
    expect(result.deletedCount).toBe(10);
  });

  it('handles error gracefully', async () => {
    prisma.notification.deleteMany.mockRejectedValue(new Error('DB error'));
    const result = await cleanupOldNotifications(90);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getNotificationStats
// ---------------------------------------------------------------------------
describe('getNotificationStats', () => {
  it('returns notification stats', async () => {
    prisma.notification.count.mockResolvedValueOnce(100).mockResolvedValueOnce(20);
    prisma.notification.groupBy.mockResolvedValue([{ type: 'BOOKING_CONFIRMED', _count: 50 }]);
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1', user: { name: 'John', email: 'j@t.com' } }]);

    const result = await getNotificationStats();
    expect(result.totalNotifications).toBe(100);
    expect(result.unreadNotifications).toBe(20);
    expect(result.notificationsByType).toHaveLength(1);
    expect(result.recentActivity).toHaveLength(1);
  });

  it('throws error on failure', async () => {
    prisma.notification.count.mockRejectedValue(new Error('DB error'));
    await expect(getNotificationStats()).rejects.toThrow('DB error');
  });
});
