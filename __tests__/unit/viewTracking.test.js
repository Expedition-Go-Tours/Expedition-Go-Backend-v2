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
  ...overrides,
});

const buildRes = () => ({ cookie: jest.fn() });

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

  it('counts an anonymous first-time visitor and grants an anon cookie', async () => {
    const req = buildReq();
    const res = buildRes();

    const counted = await shouldCountTourView({ req, res, ...BASE });

    expect(counted).toBe(true);
    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, value, opts] = res.cookie.mock.calls[0];
    expect(name).toBe('tv_anon');
    expect(value).toMatch(/^[0-9a-f]{32}$/);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.maxAge).toBe(30 * 24 * 60 * 60 * 1000);

    const keys = redis.setnx.mock.calls.map(([key]) => key);
    expect(keys[0]).toMatch(/^view:tour-1:ip:/);
    expect(keys[1]).toBe(`view:tour-1:anon:${value}`);
  });

  it('dedups per tour: two tours of the same supplier both count', async () => {
    const req = buildReq();
    const res = buildRes();

    await shouldCountTourView({ req, res, tourSupplierId: 'sup-1', tourId: 'tour-A' });
    await shouldCountTourView({ req, res, tourSupplierId: 'sup-1', tourId: 'tour-B' });

    const keyStarts = redis.setnx.mock.calls.map(([key]) => key.split(':').slice(0, 3).join(':'));
    expect(keyStarts).toEqual(expect.arrayContaining(['view:tour-A:ip', 'view:tour-B:ip']));
  });

  it('blocks a repeat view within the 30-minute cooldown', async () => {
    const countedFirst = await shouldCountTourView({
      req: buildReq(), res: buildRes(), ...BASE,
    });
    const countedSecond = await shouldCountTourView({
      req: buildReq(), res: buildRes(), ...BASE,
    });

    expect(countedFirst).toBe(true);
    expect(countedSecond).toBe(false);
    expect(redis.setnx.mock.calls.map(([key]) => key)[0]).toMatch(/^view:tour-1:ip:/);
  });

  it('uses the tv_anon cookie identity when the client already carries one', async () => {
    const req = buildReq({ cookies: { tv_anon: 'abc123' } });
    const res = buildRes();

    const counted = await shouldCountTourView({ req, res, ...BASE });

    expect(counted).toBe(true);
    expect(redis.setnx).toHaveBeenCalledWith('view:tour-1:anon:abc123', 1800);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('never counts the tour owner viewing their own listing', async () => {
    const req = buildReq({ user: { id: 'sup-1', roles: ['supplier'] } });

    const counted = await shouldCountTourView({ req, res: buildRes(), ...BASE });

    expect(counted).toBe(false);
    expect(redis.setnx).not.toHaveBeenCalled();
  });

  it('never counts admins or expedition staff', async () => {
    for (const roles of [['admin'], ['expedition']]) {
      const req = buildReq({ user: { id: 'staff-9', roles } });
      const counted = await shouldCountTourView({ req, res: buildRes(), ...BASE });
      expect(counted).toBe(false);
    }
    expect(redis.setnx).not.toHaveBeenCalled();
  });

  it('never counts suppliers with an ACTIVE profile but counts SUSPENDED ones', async () => {
    prisma.supplierProfile.findFirst.mockResolvedValueOnce({ status: 'ACTIVE' });
    const activeReq = buildReq({ user: { id: 'user-2', roles: ['supplier'] } });
    expect(await shouldCountTourView({ req: activeReq, res: buildRes(), ...BASE })).toBe(false);

    prisma.supplierProfile.findFirst.mockResolvedValueOnce({ status: 'SUSPENDED' });
    const suspendedReq = buildReq({ user: { id: 'user-3', roles: ['supplier'] } });
    expect(await shouldCountTourView({ req: suspendedReq, res: buildRes(), ...BASE })).toBe(true);
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
      const counted = await shouldCountTourView({ req, res: buildRes(), ...BASE });
      expect(counted).toBe(false);
    }
    expect(redis.setnx).not.toHaveBeenCalled();
  });

  it('falls back to in-memory dedup when Redis is unavailable', async () => {
    redis.setnx.mockResolvedValue(null);

    const req = buildReq();
    const countedFirst = await shouldCountTourView({ req, res: buildRes(), ...BASE });
    const countedSecond = await shouldCountTourView({ req, res: buildRes(), ...BASE });

    expect(countedFirst).toBe(true);
    expect(countedSecond).toBe(false);
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