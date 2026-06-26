jest.mock('../../utils/prismaClient', () => ({
  systemConfig: { findUnique: jest.fn() },
}));

const prisma = require('../../utils/prismaClient');
const getConfig = require('../../utils/getConfig');

describe('getConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getConfig.clearCache();
  });

  it('returns value from database', async () => {
    prisma.systemConfig.findUnique.mockResolvedValue({ key: 'my.key', value: '42' });
    const result = await getConfig('my.key');
    expect(result).toBe('42');
  });

  it('returns default when key not found', async () => {
    prisma.systemConfig.findUnique.mockResolvedValue(null);
    const result = await getConfig('missing.key', 'fallback');
    expect(result).toBe('fallback');
  });

  it('returns null when no default and key missing', async () => {
    prisma.systemConfig.findUnique.mockResolvedValue(null);
    const result = await getConfig('missing.key');
    expect(result).toBeNull();
  });

  it('caches result for subsequent calls', async () => {
    prisma.systemConfig.findUnique.mockResolvedValue({ key: 'cached', value: 'yes' });
    await getConfig('cached');
    await getConfig('cached');
    expect(prisma.systemConfig.findUnique).toHaveBeenCalledTimes(1);
  });

  it('returns cached value within TTL', async () => {
    prisma.systemConfig.findUnique.mockResolvedValue({ key: 'ttl', value: 'v1' });
    const first = await getConfig('ttl');
    const second = await getConfig('ttl');
    expect(first).toBe('v1');
    expect(second).toBe('v1');
    expect(prisma.systemConfig.findUnique).toHaveBeenCalledTimes(1);
  });

  it('returns default on database error', async () => {
    prisma.systemConfig.findUnique.mockRejectedValue(new Error('DB down'));
    const result = await getConfig('error.key', 'safe-default');
    expect(result).toBe('safe-default');
  });

  it('clearCache removes all cached entries', async () => {
    prisma.systemConfig.findUnique.mockResolvedValue({ key: 'x', value: '1' });
    await getConfig('x');
    getConfig.clearCache();
    await getConfig('x');
    expect(prisma.systemConfig.findUnique).toHaveBeenCalledTimes(2);
  });
});
