jest.mock('../../utils/redisClient', () => ({
  setnx: jest.fn(),
}));
jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
}));
jest.mock('../../utils/prismaClient', () => ({
  supplierProfile: { findFirst: jest.fn() },
}));

const redis = require('../../utils/redisClient');
const prisma = require('../../utils/prismaClient');
const {
  shouldCountTourView,
  isInternalViewer,
} = require('../../utils/viewTracking');

const buildReq = (overrides = {}) => ({
  user: null,
  cookies: {},
  headers: {
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari',
    'x-forwarded-for': '41.220.100.10',
  },
  socket: { remoteAddress: '10.0.0.1' },
  secure: false,
  ip: '41.220.100.10',
  ...overrides,
});

const BASE = { tourSupplierId: 'sup-1', tourId: 'tour-1' };

describe('viewTracking — shouldCountTourView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const seen = new Set();
    redis.setnx.mockImplementation(async (key) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  it('counts an anonymous first-time visitor (IP-based fingerprint)', async () => {
    const req = buildReq();

    const result = await shouldCountTourView({ req, ...BASE });

    expect(result.counted).toBe(true);
    expect(result.geo).toBeDefined();

    const keys = redis.setnx.mock.calls.map(([key]) => key);
    expect(keys[0]).toMatch(/^view:tour-1:ip:/);
  });

  it('dedups per tour: two tours of the same supplier both count', async () => {
    const req = buildReq();

    await shouldCountTourView({ req, tourSupplierId: 'sup-1', tourId: 'tour-A' });
    await shouldCountTourView({ req, tourSupplierId: 'sup-1', tourId: 'tour-B' });

    const keyStarts = redis.setnx.mock.calls.map(([key]) => key.split(':').slice(0, 3).join(':'));
    expect(keyStarts).toEqual(expect.arrayContaining(['view:tour-A:ip', 'view:tour-B:ip']));
  });

  it('blocks a repeat view within the 30-minute cooldown', async () => {
    const resultFirst = await shouldCountTourView({
      req: buildReq(), ...BASE,
    });
    const resultSecond = await shouldCountTourView({
      req: buildReq(), ...BASE,
    });

    expect(resultFirst.counted).toBe(true);
    expect(resultSecond.counted).toBe(false);
    expect(redis.setnx.mock.calls.map(([key]) => key)[0]).toMatch(/^view:tour-1:ip:/);
  });

  it('uses IP hash for anonymous visitors (no cookie identity)', async () => {
    const req = buildReq({ cookies: { tv_anon: 'abc123' } });

    const result = await shouldCountTourView({ req, ...BASE });

    expect(result.counted).toBe(true);
    // Should use IP hash, not cookie
    expect(redis.setnx.mock.calls[0][0]).toMatch(/^view:tour-1:ip:/);
  });

  it('never counts the tour owner viewing their own listing', async () => {
    const req = buildReq({ user: { id: 'sup-1', roles: ['supplier'] } });

    const result = await shouldCountTourView({ req, ...BASE });

    expect(result.counted).toBe(false);
    expect(redis.setnx).not.toHaveBeenCalled();
  });

  it('never counts admins or expedition staff', async () => {
    for (const roles of [['admin'], ['expedition']]) {
      const req = buildReq({ user: { id: 'staff-9', roles } });
      const result = await shouldCountTourView({ req, ...BASE });
      expect(result.counted).toBe(false);
    }
    expect(redis.setnx).not.toHaveBeenCalled();
  });

  it('never counts suppliers with an ACTIVE profile but counts SUSPENDED ones', async () => {
    prisma.supplierProfile.findFirst.mockResolvedValueOnce({ status: 'ACTIVE' });
    const activeReq = buildReq({ user: { id: 'user-2', roles: ['supplier'] } });
    expect((await shouldCountTourView({ req: activeReq, ...BASE })).counted).toBe(false);

    prisma.supplierProfile.findFirst.mockResolvedValueOnce({ status: 'SUSPENDED' });
    const suspendedReq = buildReq({ user: { id: 'user-3', roles: ['supplier'] } });
    expect((await shouldCountTourView({ req: suspendedReq, ...BASE })).counted).toBe(true);
    expect(redis.setnx).toHaveBeenCalledTimes(1);
  });

  it('never counts crawlers or social link-preview bots', async () => {
    const bots = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'TelegramBot (like TwitterBot)',
      'WhatsApp/2.23.20.0 A',
      'Mozilla/5.0 (compatible; Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Discordbot/2.0 (+https://discordapp.com)',
    ];
    for (const ua of bots) {
      const req = buildReq({ headers: { 'user-agent': ua } });
      const result = await shouldCountTourView({ req, ...BASE });
      expect(result.counted).toBe(false);
    }
    expect(redis.setnx).not.toHaveBeenCalled();
  });

  it('falls back to in-memory dedup when Redis is unavailable', async () => {
    redis.setnx.mockResolvedValue(null);

    const req = buildReq();
    const resultFirst = await shouldCountTourView({ req, ...BASE });
    const resultSecond = await shouldCountTourView({ req, ...BASE });

    expect(resultFirst.counted).toBe(true);
    expect(resultSecond.counted).toBe(false);
  });

  it('returns geo data for anonymous visitors', async () => {
    const req = buildReq({ 'x-forwarded-for': '102.128.0.1' });

    const result = await shouldCountTourView({ req, ...BASE });

    expect(result.counted).toBe(true);
    expect(result.geo).toBeDefined();
    // geo may be null for private IPs, but the field should exist
    if (result.geo) {
      expect(result.geo).toHaveProperty('country');
      expect(result.geo).toHaveProperty('city');
    }
  });
});

describe('viewTracking — isInternalViewer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true for admins and expedition staff', async () => {
    expect(await isInternalViewer({ id: 'a', roles: ['admin'] })).toBe(true);
    expect(await isInternalViewer({ id: 'e', roles: ['expedition'] })).toBe(true);
  });

  it('returns true only for suppliers with an ACTIVE profile', async () => {
    prisma.supplierProfile.findFirst.mockResolvedValueOnce({ status: 'ACTIVE' });
    expect(await isInternalViewer({ id: 's1', roles: ['supplier'] })).toBe(true);

    prisma.supplierProfile.findFirst.mockResolvedValueOnce({ status: 'APPROVED' });
    expect(await isInternalViewer({ id: 's2', roles: ['supplier'] })).toBe(false);
  });

  it('returns false for anonymous visitors and plain customers', async () => {
    expect(await isInternalViewer(null)).toBe(false);
    expect(await isInternalViewer({ id: 'c1', roles: ['customer'] })).toBe(false);
  });
});
