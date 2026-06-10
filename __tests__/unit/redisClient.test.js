let mockRedis;

function createMockRedis() {
  mockRedis = {
    connect: jest.fn().mockResolvedValue(),
    quit: jest.fn().mockResolvedValue(),
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    scanStream: jest.fn(),
    pipeline: jest.fn(),
    on: jest.fn(),
  };
}

createMockRedis();

jest.mock('ioredis', () => jest.fn(() => mockRedis));

const Redis = require('ioredis');

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
});
