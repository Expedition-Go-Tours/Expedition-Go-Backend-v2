jest.mock('../../utils/prismaClient', () => ({
  event: { create: jest.fn() },
  $transaction: jest.fn(),
}));

const prisma = require('../../utils/prismaClient');
const emitter = require('../../utils/eventEmitter');

describe('eventEmitter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.event.create.mockResolvedValue({ id: 'evt-1' });
    prisma.$transaction.mockImplementation((queries) => Promise.all(queries));
  });

  describe('deriveSessionId', () => {
    it('returns null when no req', () => {
      expect(emitter.deriveSessionId()).toBeNull();
    });

    it('returns hashed session from ip and user-agent', () => {
      const req = { ip: '1.2.3.4', headers: { 'user-agent': 'Chrome' } };
      const result = emitter.deriveSessionId(req);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('returns null when no ip and no user-agent', () => {
      const req = {};
      expect(emitter.deriveSessionId(req)).toBeNull();
    });
  });

  describe('emit', () => {
    it('creates event and returns id', async () => {
      const id = await emitter.emit({ name: 'booking.created', userId: 'u-1', resource: 'Booking' });
      expect(prisma.event.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ name: 'booking.created', userId: 'u-1', resource: 'Booking' }),
      }));
      expect(id).toBe('evt-1');
    });

    it('resolves source from req when not provided', async () => {
      const req = { ip: '1.2.3.4', headers: {} };
      await emitter.emit({ name: 'test', req });
      expect(prisma.event.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ source: 'web' }),
      }));
    });

    it('defaults source to api when no req', async () => {
      await emitter.emit({ name: 'test' });
      expect(prisma.event.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ source: 'api' }),
      }));
    });

    it('returns null on database error', async () => {
      prisma.event.create.mockRejectedValue(new Error('DB error'));
      const id = await emitter.emit({ name: 'test' });
      expect(id).toBeNull();
    });
  });

  describe('emitBatch', () => {
    it('writes multiple events in transaction', async () => {
      const events = [
        { name: 'booking.created', userId: 'u-1' },
        { name: 'payment.initiated', userId: 'u-1' },
      ];
      const count = await emitter.emitBatch(events);
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'booking.created' }) })
      );
      expect(count).toBe(2);
    });

    it('returns 0 on error', async () => {
      prisma.$transaction.mockRejectedValue(new Error('Transaction failed'));
      const count = await emitter.emitBatch([{ name: 'test' }]);
      expect(count).toBe(0);
    });
  });
});
