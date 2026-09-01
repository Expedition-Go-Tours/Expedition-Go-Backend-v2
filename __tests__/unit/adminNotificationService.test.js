jest.mock('../../utils/prismaClient', () => ({
  adminNotification: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn() },
}));

jest.mock('../../app', () => ({ get: jest.fn() }));

jest.mock('../../utils/discordNotifier', () => ({
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));

const prisma = require('../../utils/prismaClient');
const app = require('../../app');
const { notifyDiscord } = require('../../utils/discordNotifier');
const service = require('../../utils/adminNotificationService');

describe('adminNotificationService', () => {
  let mockIo;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIo = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
    app.get.mockReturnValue(mockIo);

    prisma.adminNotification.create.mockResolvedValue({ id: 'an-1', createdAt: new Date() });
    prisma.adminNotification.findMany.mockResolvedValue([]);
    prisma.adminNotification.count.mockResolvedValue(0);
    prisma.adminNotification.updateMany.mockResolvedValue({ count: 1 });
    prisma.adminNotification.groupBy.mockResolvedValue([]);
  });

  describe('notifyAdmin', () => {
    it('creates admin notification and emits socket event', async () => {
      const result = await service.notifyAdmin({ type: 'TEST', title: 'Test', message: 'Hello', data: { key: 'val' } });

      expect(prisma.adminNotification.create).toHaveBeenCalledWith({
        data: { type: 'TEST', title: 'Test', message: 'Hello', data: { key: 'val' } },
      });
      expect(mockIo.to).toHaveBeenCalledWith('admin-room');
      expect(mockIo.emit).toHaveBeenCalledWith('admin-notification', expect.objectContaining({ type: 'TEST', title: 'Test' }));
      expect(result).toEqual({ success: true, id: 'an-1' });
    });

    it('returns success with id even when io is not available', async () => {
      app.get.mockReturnValue(null);
      const result = await service.notifyAdmin({ type: 'TEST', title: 'Test', message: 'No socket' });
      expect(result).toEqual({ success: true, id: 'an-1' });
    });

    it('handles database errors gracefully', async () => {
      prisma.adminNotification.create.mockRejectedValue(new Error('DB error'));
      const result = await service.notifyAdmin({ type: 'TEST', title: 'Test', message: 'Error' });
      expect(result).toEqual({ success: false, error: 'DB error' });
    });

    it('mirrors PAYMENT_COLLECTED to Discord incidents channel (green)', async () => {
      await service.notifyAdmin({
        type: 'PAYMENT_COLLECTED',
        title: 'Payment collected',
        message: 'Charge succeeded',
        data: { bookingId: 'b1' },
      });
      expect(notifyDiscord).toHaveBeenCalledWith(
        'incidents',
        'Charge succeeded',
        expect.objectContaining({ title: 'Payment collected', color: 0x00c853 })
      );
    });

    it('mirrors PAYMENT_COLLECTION_FAILED to Discord incidents channel (red)', async () => {
      await service.notifyAdmin({
        type: 'PAYMENT_COLLECTION_FAILED',
        title: 'Charge failed',
        message: 'Card declined',
        data: { bookingId: 'b1' },
      });
      expect(notifyDiscord).toHaveBeenCalledWith(
        'incidents',
        'Card declined',
        expect.objectContaining({ title: 'Charge failed', color: 0xff4444 })
      );
    });

    it('mirrors DOCUMENT_EXPIRING to Discord verification channel (yellow)', async () => {
      await service.notifyAdmin({
        type: 'DOCUMENT_EXPIRING',
        title: 'Doc expiring',
        message: 'Expiring in 7 days',
        data: { supplierId: 's1' },
      });
      expect(notifyDiscord).toHaveBeenCalledWith(
        'verification',
        'Expiring in 7 days',
        expect.objectContaining({ title: 'Doc expiring', color: 0xffaa00 })
      );
    });

    it('mirrors SYSTEM_ALERT to Discord incidents channel (red)', async () => {
      await service.notifyAdmin({
        type: 'SYSTEM_ALERT',
        title: 'System alert',
        message: 'Disk full',
        data: { disk: '98%' },
      });
      expect(notifyDiscord).toHaveBeenCalledWith(
        'incidents',
        'Disk full',
        expect.objectContaining({ title: 'System alert', color: 0xff4444 })
      );
    });

    it('does NOT mirror unmapped types to Discord', async () => {
      await service.notifyAdmin({ type: 'TEST_UNKNOWN', title: 'X', message: 'Y' });
      expect(notifyDiscord).not.toHaveBeenCalled();
    });

    it('does NOT mirror types already handled by explicit embeds (PAYOUT_NEEDS_APPROVAL)', async () => {
      await service.notifyAdmin({ type: 'PAYOUT_NEEDS_APPROVAL', title: 'Payout', message: 'Needs approval' });
      expect(notifyDiscord).not.toHaveBeenCalled();
    });

    it('does NOT mirror NEW_SUPPLIER_APPLICATION (handled explicitly)', async () => {
      await service.notifyAdmin({ type: 'NEW_SUPPLIER_APPLICATION', title: 'New supplier', message: 'Applied' });
      expect(notifyDiscord).not.toHaveBeenCalled();
    });

    it('handles mirror errors gracefully (does not throw)', async () => {
      notifyDiscord.mockRejectedValueOnce(new Error('Discord down'));
      await expect(
        service.notifyAdmin({ type: 'PAYMENT_COLLECTED', title: 'Test', message: 'Test' })
      ).resolves.toMatchObject({ success: true });
    });
  });

  describe('getNotifications', () => {
    it('returns paginated notifications', async () => {
      prisma.adminNotification.findMany.mockResolvedValue([{ id: 'an-1' }]);
      prisma.adminNotification.count.mockResolvedValueOnce(10);
      prisma.adminNotification.count.mockResolvedValueOnce(3);

      const result = await service.getNotifications({ page: 1, limit: 5 });

      expect(result.notifications).toHaveLength(1);
      expect(result.pagination.totalCount).toBe(10);
      expect(result.pagination.unacknowledgedCount).toBe(3);
      expect(result.pagination.totalPages).toBe(2);
    });

    it('filters by unacknowledgedOnly when set', async () => {
      await service.getNotifications({ unacknowledgedOnly: true });
      expect(prisma.adminNotification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { acknowledged: false } })
      );
    });

    it('handles default pagination', async () => {
      await service.getNotifications({});
      expect(prisma.adminNotification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 })
      );
    });
  });

  describe('acknowledgeNotification', () => {
    it('updates notification as acknowledged', async () => {
      const result = await service.acknowledgeNotification('an-1', 'admin-1');
      expect(prisma.adminNotification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'an-1', acknowledged: false } })
      );
      expect(result).toEqual({ success: true });
    });

    it('returns success false when no matching notification', async () => {
      prisma.adminNotification.updateMany.mockResolvedValue({ count: 0 });
      const result = await service.acknowledgeNotification('nonexistent', 'admin-1');
      expect(result).toEqual({ success: false });
    });

    it('handles errors gracefully', async () => {
      prisma.adminNotification.updateMany.mockRejectedValue(new Error('Update error'));
      const result = await service.acknowledgeNotification('an-1', 'admin-1');
      expect(result).toEqual({ success: false, error: 'Update error' });
    });
  });

  describe('acknowledgeAll', () => {
    it('acknowledges all unacknowledged notifications', async () => {
      prisma.adminNotification.updateMany.mockResolvedValue({ count: 5 });
      const result = await service.acknowledgeAll('admin-1');
      expect(result).toEqual({ success: true, count: 5 });
    });

    it('handles errors gracefully', async () => {
      prisma.adminNotification.updateMany.mockRejectedValue(new Error('Error'));
      const result = await service.acknowledgeAll('admin-1');
      expect(result).toEqual({ success: false, error: 'Error' });
    });
  });

  describe('getStats', () => {
    it('returns stats from all queries', async () => {
      prisma.adminNotification.count.mockResolvedValueOnce(100);
      prisma.adminNotification.count.mockResolvedValueOnce(10);
      prisma.adminNotification.groupBy.mockResolvedValue([{ type: 'PAYOUT', _count: 50 }]);
      prisma.adminNotification.findMany.mockResolvedValue([{ id: 'an-1' }]);

      const result = await service.getStats();

      expect(result.total).toBe(100);
      expect(result.unacknowledged).toBe(10);
      expect(result.byType).toEqual([{ type: 'PAYOUT', _count: 50 }]);
      expect(result.recent).toHaveLength(1);
    });
  });
});
