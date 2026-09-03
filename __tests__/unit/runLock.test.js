const { acquireRunLock, releaseRunLock } = require('../../utils/runLock');

// redisClient is consumed by runLock; control its state + connection here.
jest.mock('../../utils/redisClient', () => ({
  getClient: jest.fn(),
  isReady: jest.fn(),
}));

const redisClient = require('../../utils/redisClient');

function fakeConnection(over = {}) {
  return {
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('acquireRunLock', () => {
  it('returns a token when the atomic SET NX PX succeeds', async () => {
    const conn = fakeConnection({ set: jest.fn().mockResolvedValue('OK') });
    redisClient.isReady.mockReturnValue(true);
    redisClient.getClient.mockReturnValue(conn);

    const token = await acquireRunLock('sweep:test', 60_000);

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);
    expect(conn.set).toHaveBeenCalledWith(
      expect.stringContaining('sweep:test'),
      expect.any(String), // random token value
      'PX', 60_000, 'NX'
    );
  });

  it('returns false when another owner holds the lock', async () => {
    const conn = fakeConnection({ set: jest.fn().mockResolvedValue(null) });
    redisClient.isReady.mockReturnValue(true);
    redisClient.getClient.mockReturnValue(conn);

    expect(await acquireRunLock('sweep:test', 60_000)).toBe(false);
  });

  it('returns null when Redis is not ready (leader-fallback signal)', async () => {
    redisClient.isReady.mockReturnValue(false);
    expect(await acquireRunLock('sweep:test', 60_000)).toBeNull();
  });

  it('returns null when there is no connection object', async () => {
    redisClient.isReady.mockReturnValue(true);
    redisClient.getClient.mockReturnValue(null);
    expect(await acquireRunLock('sweep:test', 60_000)).toBeNull();
  });

  it('returns null when the set command throws (transient Redis error)', async () => {
    const conn = fakeConnection({ set: jest.fn().mockRejectedValue(new Error('boom')) });
    redisClient.isReady.mockReturnValue(true);
    redisClient.getClient.mockReturnValue(conn);
    expect(await acquireRunLock('sweep:test', 60_000)).toBeNull();
  });
});

describe('releaseRunLock', () => {
  it('releases the lock when the stored token matches (Lua compare-and-delete)', async () => {
    const conn = fakeConnection();
    redisClient.isReady.mockReturnValue(true);
    redisClient.getClient.mockReturnValue(conn);

    await releaseRunLock('sweep:test', 'token-abc');

    expect(conn.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('del', KEYS[1])"),
      1,
      'sweep:test',
      'token-abc'
    );
  });

  it('does nothing when no token is provided', async () => {
    const conn = fakeConnection();
    redisClient.getClient.mockReturnValue(conn);
    await releaseRunLock('sweep:test', null);
    expect(conn.eval).not.toHaveBeenCalled();
  });

  it('does nothing when there is no connection', async () => {
    redisClient.getClient.mockReturnValue(null);
    await expect(releaseRunLock('sweep:test', 'token')).resolves.toBeUndefined();
  });

  it('swallows eval errors (TTL will expire the lock on its own)', async () => {
    const conn = fakeConnection({ eval: jest.fn().mockRejectedValue(new Error('conn lost')) });
    redisClient.getClient.mockReturnValue(conn);
    await expect(releaseRunLock('sweep:test', 'token')).resolves.toBeUndefined();
  });
});
