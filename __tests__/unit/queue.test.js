jest.mock('bullmq', () => ({
  Queue: jest.fn(),
  Worker: jest.fn(),
}));

const mockIoRedisInstance = {
  connect: jest.fn().mockResolvedValue(),
  ping: jest.fn().mockResolvedValue('PONG'),
  quit: jest.fn().mockResolvedValue(),
  on: jest.fn(),
};

jest.mock('ioredis', () => jest.fn(() => mockIoRedisInstance));

jest.mock('../../utils/prismaClient', () => ({
  booking: { findUnique: jest.fn() },
  cartItem: { findMany: jest.fn(), deleteMany: jest.fn() },
  event: { deleteMany: jest.fn() },
}));

jest.mock('../../utils/emailService', () => ({
  sendBookingConfirmationEmail: jest.fn(),
  sendBookingCancellationEmail: jest.fn(),
  sendSupplierBookingNotification: jest.fn(),
  sendSupplierStatusEmail: jest.fn(),
  sendEmail: jest.fn(),
}));

jest.mock('../../utils/notificationService', () => ({
  sendNotification: jest.fn(),
  cleanupOldNotifications: jest.fn(),
}));

jest.mock('../../utils/auditLogger', () => ({
  cleanupOldLogs: jest.fn(),
}));

jest.mock('../../utils/cacheHelper', () => ({
  invalidateKeys: jest.fn(),
  TOUR_POPULAR_KEY: 'tour:popular',
}));

jest.mock('../../utils/eventEmitter', () => ({
  emit: jest.fn(),
}));

process.env.REDIS_URL = 'redis://localhost:6379';

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const prisma = require('../../utils/prismaClient');
const emailService = require('../../utils/emailService');
const notificationService = require('../../utils/notificationService');
const auditLogger = require('../../utils/auditLogger');
const cacheHelper = require('../../utils/cacheHelper');
const eventEmitter = require('../../utils/eventEmitter');
const queue = require('../../utils/queue');

describe('queue', () => {
  let mockQueueInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    await queue.closeAll().catch(() => {});
    IORedis.mockClear();

    mockQueueInstance = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      close: jest.fn().mockResolvedValue(),
    };
    Queue.mockImplementation(() => mockQueueInstance);

    Worker.mockImplementation(() => ({
      on: jest.fn(),
    }));
  });

  describe('getConnection', () => {
    it('creates IORedis connection with lazyConnect', () => {
      const conn = queue.getConnection();
      expect(IORedis).toHaveBeenCalledWith(expect.stringMatching(/rediss?:\/\//), expect.objectContaining({ lazyConnect: true }));
      expect(conn).toBeDefined();
    });

    it('returns cached connection on subsequent calls', () => {
      const conn1 = queue.getConnection();
      const conn2 = queue.getConnection();
      expect(conn1).toBe(conn2);
    });
  });

  describe('isRedisAvailable', () => {
    it('returns true when ping succeeds', async () => {
      const result = await queue.isRedisAvailable();
      expect(result).toBe(true);
    });

    it('returns false when ping fails', async () => {
      mockIoRedisInstance.ping.mockRejectedValue(new Error('Connection refused'));
      const result = await queue.isRedisAvailable();
      expect(result).toBe(false);
    });

    it('returns false when rate limited', async () => {
      mockIoRedisInstance.ping.mockRejectedValue(new Error('max requests limit exceeded'));
      const result = await queue.isRedisAvailable();
      expect(result).toBe(false);
    });
  });

  describe('enqueueEmail', () => {
    it('adds email job to the queue', async () => {
      const job = { type: 'supplier-status-email', email: 's@t.com', status: 'APPROVED', data: {} };

      await queue.enqueueEmail(job);

      expect(mockQueueInstance.add).toHaveBeenCalledWith('email', job, expect.objectContaining({ attempts: 3 }));
    });

    it('falls back to direct processing when Redis unavailable', async () => {
      mockQueueInstance.add.mockRejectedValue(new Error('Redis down'));
      emailService.sendSupplierStatusEmail.mockResolvedValue();
      const job = { type: 'supplier-status-email', email: 's@t.com', status: 'APPROVED', data: {} };

      await queue.enqueueEmail(job);

      expect(emailService.sendSupplierStatusEmail).toHaveBeenCalledWith('s@t.com', 'APPROVED', {});
    });
  });

  describe('processEmailJob', () => {
    it('handles booking-confirmation type', async () => {
      const mockBooking = { id: 'b-1', customer: {}, tour: {} };
      prisma.booking.findUnique.mockResolvedValue(mockBooking);
      emailService.sendBookingConfirmationEmail.mockResolvedValue();

      await queue.processEmailJob({ type: 'booking-confirmation', bookingId: 'b-1' });

      expect(prisma.booking.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'b-1' } }));
      expect(emailService.sendBookingConfirmationEmail).toHaveBeenCalledWith(mockBooking);
    });

    it('throws when booking not found for booking-confirmation', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);
      await expect(queue.processEmailJob({ type: 'booking-confirmation', bookingId: 'nonexistent' })).rejects.toThrow('nonexistent');
    });

    it('handles booking-cancellation type', async () => {
      prisma.booking.findUnique.mockResolvedValue({ id: 'b-1', customer: {}, tour: {} });
      emailService.sendBookingCancellationEmail.mockResolvedValue();

      await queue.processEmailJob({ type: 'booking-cancellation', bookingId: 'b-1', refundAmount: 100 });

      expect(emailService.sendBookingCancellationEmail).toHaveBeenCalledWith(expect.any(Object), 100);
    });

    it('handles supplier-booking-notification type', async () => {
      prisma.booking.findUnique.mockResolvedValue({ id: 'b-1', customer: {}, tour: {} });
      emailService.sendSupplierBookingNotification.mockResolvedValue();

      await queue.processEmailJob({ type: 'supplier-booking-notification', bookingId: 'b-1' });

      expect(emailService.sendSupplierBookingNotification).toHaveBeenCalled();
    });

    it('handles supplier-status-email type', async () => {
      emailService.sendSupplierStatusEmail.mockResolvedValue();

      await queue.processEmailJob({ type: 'supplier-status-email', email: 's@t.com', status: 'APPROVED' });

      expect(emailService.sendSupplierStatusEmail).toHaveBeenCalledWith('s@t.com', 'APPROVED', {});
    });

    it('handles default (raw email) type', async () => {
      emailService.sendEmail.mockResolvedValue();

      await queue.processEmailJob({ to: 'u@t.com', subject: 'Hello', template: 'generic', data: {} });

      expect(emailService.sendEmail).toHaveBeenCalledWith({ to: 'u@t.com', subject: 'Hello', template: 'generic', data: {}, attachments: undefined });
    });
  });

  describe('enqueueNotification', () => {
    it('adds job to notification queue when Redis available', async () => {
      const result = await queue.enqueueNotification({ userId: 'u-1', type: 'TEST', title: 'Test', message: 'Hi' });

      expect(mockQueueInstance.add).toHaveBeenCalledWith('notify', { userId: 'u-1', type: 'TEST', title: 'Test', message: 'Hi' });
      expect(result).toEqual({ id: 'job-1' });
    });

    it('falls back to sendNotification when Redis unavailable', async () => {
      mockQueueInstance.add.mockRejectedValue(new Error('Redis down'));
      notificationService.sendNotification.mockResolvedValue();

      const result = await queue.enqueueNotification({ userId: 'u-1', type: 'TEST', title: 'Test', message: 'Hi' });

      expect(notificationService.sendNotification).toHaveBeenCalledWith({ userId: 'u-1', type: 'TEST', title: 'Test', message: 'Hi' });
      expect(result).toBeUndefined();
    });
  });

  describe('enqueueEvent', () => {
    it('adds event job with unique jobId', async () => {
      await queue.enqueueEvent({ name: 'page_view', url: '/' });
      expect(mockQueueInstance.add).toHaveBeenCalledWith('event', { name: 'page_view', url: '/' }, expect.objectContaining({ jobId: expect.stringContaining('evt:page_view:') }));
    });

    it('handles Redis failure gracefully', async () => {
      mockQueueInstance.add.mockRejectedValue(new Error('Redis down'));
      await expect(queue.enqueueEvent({ name: 'test' })).resolves.not.toThrow();
    });
  });

  describe('enqueueAggregation', () => {
    it('adds aggregation job with dedup key', async () => {
      await queue.enqueueAggregation('refresh-popularity');
      expect(mockQueueInstance.add).toHaveBeenCalledWith('refresh-popularity', {}, expect.objectContaining({ jobId: expect.stringContaining('refresh-popularity:') }));
    });
  });

  describe('enqueueCleanup', () => {
    it('adds cleanup job with dedup key', async () => {
      await queue.enqueueCleanup('cleanup-audit-logs', { days: 365 });
      expect(mockQueueInstance.add).toHaveBeenCalledWith('cleanup-audit-logs', { days: 365 }, expect.objectContaining({ jobId: expect.stringContaining('cleanup-audit-logs:') }));
    });
  });

  describe('registerWorkers', () => {
    it('creates workers for all queue names', () => {
      queue.registerWorkers();

      const calls = Worker.mock.calls;
      const queueNames = calls.map(c => c[0]);
      expect(queueNames).toContain('communications-notifications');
      expect(queueNames).toContain('analytics-aggregations');
      expect(queueNames).toContain('system-cleanup');
    });

    it('notification worker calls sendNotification', async () => {
      queue.registerWorkers();
      const workerCallback = Worker.mock.calls.find(c => c[0] === 'communications-notifications')[1];
      notificationService.sendNotification.mockResolvedValue();

      await workerCallback({ data: { userId: 'u-1', type: 'TEST' } });

      expect(notificationService.sendNotification).toHaveBeenCalledWith({ userId: 'u-1', type: 'TEST' });
    });

    it('aggregation worker handles refresh-popularity', async () => {
      queue.registerWorkers();
      const workerCallback = Worker.mock.calls.find(c => c[0] === 'analytics-aggregations')[1];

      await workerCallback({ name: 'refresh-popularity' });

      expect(cacheHelper.invalidateKeys).toHaveBeenCalledWith(['tour:popular']);
    });

    it('aggregation worker handles cleanup-events', async () => {
      queue.registerWorkers();
      const workerCallback = Worker.mock.calls.find(c => c[0] === 'analytics-aggregations')[1];

      await workerCallback({ name: 'cleanup-events' });

      expect(prisma.event.deleteMany).toHaveBeenCalled();
    });

    it('cleanup worker handles cleanup-audit-logs', async () => {
      queue.registerWorkers();
      const workerCallback = Worker.mock.calls.find(c => c[0] === 'system-cleanup')[1];

      await workerCallback({ name: 'cleanup-audit-logs' });

      expect(auditLogger.cleanupOldLogs).toHaveBeenCalledWith(365);
    });

    it('cleanup worker handles cleanup-notifications', async () => {
      queue.registerWorkers();
      const workerCallback = Worker.mock.calls.find(c => c[0] === 'system-cleanup')[1];

      await workerCallback({ name: 'cleanup-notifications' });

      expect(notificationService.cleanupOldNotifications).toHaveBeenCalledWith(90);
    });

    it('cleanup worker handles cleanup-expired-cart', async () => {
      queue.registerWorkers();
      const workerCallback = Worker.mock.calls.find(c => c[0] === 'system-cleanup')[1];
      prisma.cartItem.findMany.mockResolvedValue([{ id: 'ci-1', customerId: 'u-1', tourId: 't-1', total: 100, currency: 'USD', expiresAt: new Date(), tour: { title: 'Tour', supplierId: 's-1' } }]);
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });

      await workerCallback({ name: 'cleanup-expired-cart' });

      expect(prisma.cartItem.deleteMany).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'cart.abandoned' }));
    });
  });

  describe('closeAll', () => {
    it('closes all queues', async () => {
      await queue.enqueueNotification({ userId: 'u-1', type: 'TEST' });

      const result = await queue.closeAll();
      expect(mockQueueInstance.close).toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });
});
