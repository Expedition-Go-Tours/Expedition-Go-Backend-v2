let mockRedis;

function createMockRedis() {
  const handlers = {};
  mockRedis = {
    connect: jest.fn().mockResolvedValue(),
    quit: jest.fn().mockResolvedValue(),
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    scanStream: jest.fn(),
    pipeline: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    status: 'wait',
    disconnect: jest.fn(),
    on: jest.fn((evt, cb) => { handlers[evt] = cb; }),
    _handlers: handlers,
  };
}

createMockRedis();

jest.mock('ioredis', () => jest.fn(() => mockRedis));

describe('redisClient', () => {
  let redis;

  function loadRedis() {
    jest.resetModules();
    createMockRedis();
    return require('../../utils/redisClient');
  }

  afterAll(async () => {
    const r = require('../../utils/redisClient');
    await r.quit().catch(() => {});
  });

  describe('connect', () => {
    it('creates client and connects', async () => {
      const OLD_REDIS_URL = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://localhost:6379';
      redis = loadRedis();
      const client = await redis.connect();
      expect(client).toBeDefined();
      expect(mockRedis.connect).toHaveBeenCalled();
      process.env.REDIS_URL = OLD_REDIS_URL;
    });

    it('returns existing client on repeated calls', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      redis = loadRedis();
      const first = await redis.connect();
      const second = await redis.connect();
      expect(first).toBe(second);
    });

    it('returns null when REDIS_URL not set', async () => {
      delete process.env.REDIS_URL;
      redis = loadRedis();
      const client = await redis.connect();
      expect(client).toBeNull();
    });
  });

  describe('isReady', () => {
    it('returns false initially', () => {
      redis = loadRedis();
      expect(redis.isReady()).toBe(false);
    });
  });

  describe('getClient', () => {
    it('returns null initially', () => {
      redis = loadRedis();
      expect(redis.getClient()).toBeNull();
    });
  });

  describe('get', () => {
    it('returns null when not ready', async () => {
      redis = loadRedis();
      const val = await redis.get('key');
      expect(val).toBeNull();
    });
  });

  describe('set', () => {
    it('does nothing when not ready', async () => {
      redis = loadRedis();
      await redis.set('key', { data: 'val' });
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe('del', () => {
    it('does nothing when not ready', async () => {
      redis = loadRedis();
      await redis.del('key');
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });

  describe('delPattern', () => {
    it('does nothing when not ready', async () => {
      redis = loadRedis();
      await redis.delPattern('pattern:*');
      expect(mockRedis.scanStream).not.toHaveBeenCalled();
    });
  });

  describe('quit', () => {
    it('returns undefined when not connected', async () => {
      redis = loadRedis();
      const result = await redis.quit();
      expect(result).toBeUndefined();
    });
  });

  describe('degraded mode (Upstash quota)', () => {
    it('marks degraded on limit error and isReady returns false', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      redis = loadRedis();
      await redis.connect();
      expect(redis.isReady()).toBe(true);

      mockRedis._handlers.error(new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500006'));
      expect(redis.isReady()).toBe(false);
    });

    it('isRedisAvailable returns false when degraded without pinging', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      redis = loadRedis();
      await redis.connect();
      mockRedis._handlers.error(new Error('ERR max requests limit exceeded'));

      const ok = await redis.isRedisAvailable();
      expect(ok).toBe(false);
      expect(mockRedis.ping).not.toHaveBeenCalled();
    });

    it('probe recovers after a real command succeeds', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      redis = loadRedis();
      await redis.connect();
      mockRedis._handlers.error(new Error('ERR max requests limit exceeded'));
      expect(redis.isReady()).toBe(false);

      mockRedis.get.mockResolvedValue(null);
      const ok = await redis.probe();
      expect(ok).toBe(true);
      expect(redis.isReady()).toBe(true);
    });

    it('probe stays degraded when the limit is still enforced', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      redis = loadRedis();
      await redis.connect();
      mockRedis._handlers.error(new Error('ERR max requests limit exceeded'));

      mockRedis.get.mockRejectedValue(new Error('ERR max requests limit exceeded'));
      const ok = await redis.probe();
      expect(ok).toBe(false);
      expect(redis.isReady()).toBe(false);
    });
  });
});
