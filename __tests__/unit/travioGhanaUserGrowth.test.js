/**
 * User Growth analytics — Ghana brand-scoped handler tests.
 *
 * getUserGrowth: customers + suppliers scope, granularity per period,
 * previous-window comparison payload, clean bucket labels, v2 cache key.
 * getRecentSignups: role-scoped drill-down (plain `has` — no brand role
 * required), monthly bucket scoping, booking-derived phone + hasBookings.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findMany: jest.fn() },
  $queryRaw: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
  invalidateTourCaches: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));

const ghanaAdmin = require('../../src/brands/ghana/adminController');
const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');

function run(handler, query = {}) {
  const req = { query };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return handler(req, res, next).then(() => ({ res, next }));
}

/** Render a tagged-template arg: inline Prisma.Raw literals, param the rest. */
function renderValue(v) {
  if (v && typeof v === 'object' && Array.isArray(v.strings) && v.strings.length) {
    let out = v.strings[0];
    for (let i = 1; i < v.strings.length; i += 1) out += String(v.values?.[i - 1]) + v.strings[i];
    return out;
  }
  return '?';
}

/** Rebuild the SQL sent to $queryRaw (raw literals inlined, params as ?). */
function sqlOf(callIndex = 0) {
  const [strings, ...values] = prisma.$queryRaw.mock.calls[callIndex];
  return strings.reduce((acc, s, i) => acc + s + (values[i] !== undefined ? renderValue(values[i]) : ''), '');
}

/** Bound (non-raw) params of a $queryRaw call, in interpolation order. */
function boundParams(callIndex = 0) {
  const [, ...values] = prisma.$queryRaw.mock.calls[callIndex];
  return values.filter((v) => !(v && typeof v === 'object' && Array.isArray(v.strings)));
}

describe('getUserGrowth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('scopes to brand-role suppliers OR customers (not suppliers only)', async () => {
    await run(ghanaAdmin.getUserGrowth, { period: '1y' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const text = sqlOf(0);
    expect(text).toContain("= ANY(\"roles\"::text[]) OR 'customer' = ANY(\"roles\"::text[])");
  });

  it('uses daily buckets + day labels for 30d', async () => {
    await run(ghanaAdmin.getUserGrowth, { period: '30d' });
    const text = sqlOf(0);
    expect(text).toContain("DATE_TRUNC('day', \"createdAt\")");
    expect(text).toContain("to_char(DATE_TRUNC('day', \"createdAt\"), 'YYYY-MM-DD')");
  });

  it('uses weekly buckets for 90d and monthly for 1y', async () => {
    await run(ghanaAdmin.getUserGrowth, { period: '90d' });
    expect(sqlOf(0)).toContain("DATE_TRUNC('week', \"createdAt\")");
    await run(ghanaAdmin.getUserGrowth, { period: '1y' });
    expect(sqlOf(2)).toContain("DATE_TRUNC('month', \"createdAt\")");
    expect(sqlOf(2)).toContain("to_char(DATE_TRUNC('month', \"createdAt\"), 'YYYY-MM')");
  });

  it('defaults to 24 months of monthly buckets when period is missing', async () => {
    await run(ghanaAdmin.getUserGrowth, {});
    expect(sqlOf(0)).toContain("DATE_TRUNC('month', \"createdAt\")");
  });

  it('shifts the previous window by the same length (two queries)', async () => {
    await run(ghanaAdmin.getUserGrowth, { period: '30d' });
    const [role, fromA, toA] = boundParams(0);
    const [, fromB, toB] = boundParams(1);
    expect(role).toBe('ghana');
    // The previous window ends exactly where the current window begins,
    // and is the same length (30 days for 30d).
    expect(toB.getTime()).toBe(fromA.getTime());
    expect(fromA.getTime() - fromB.getTime()).toBe(30 * 86400000);
    expect(toA.getTime() - toB.getTime()).toBe(30 * 86400000);
  });

  it('returns growth + previous + granularity + period and drops the tinted v2 cache key', async () => {
    const rows = [{ month: '2026-09', total: 5, customers: 4, suppliers: 1 }];
    prisma.$queryRaw
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ month: '2026-08', total: 2, customers: 1, suppliers: 1 }]);
    const { res } = await run(ghanaAdmin.getUserGrowth, { period: '1y' });

    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      data: {
        growth: rows,
        previous: [{ month: '2026-08', total: 2, customers: 1, suppliers: 1 }],
        granularity: 'month',
        period: '1y',
      },
    });
    const key = cache.getOrSet.mock.calls[0][0];
    expect(key).toContain('admin:userGrowth:v2:');
    expect(key).toMatch(/:1y$/);
  });
});

describe('getRecentSignups', () => {
  const USER = {
    id: 'u1', name: 'Ama', email: 'ama@example.com', photoURL: null,
    roles: ['customer'], createdAt: new Date('2026-09-05T10:00:00Z'),
    phone: null,
    bookings: [{ leadTravelerPhone: '+233 20 000 1111' }],
    _count: { bookings: 2 },
  };
  const PLAIN_USER = {
    id: 'u2', name: 'Kofi', email: 'kofi@example.com', photoURL: null,
    roles: ['customer'], createdAt: new Date('2026-09-06T10:00:00Z'),
    phone: '+233 24 555 6666',
    bookings: [],
    _count: { bookings: 0 },
  };

  beforeEach(() => jest.clearAllMocks());

  it('looks up brand-role users OR customers (plain `has`, no brand role needed)', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await run(ghanaAdmin.getRecentSignups, { period: '1y' });
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { roles: { has: 'ghana' } },
      { roles: { has: 'customer' } },
    ]);
  });

  it('applies role drills as a plain `has` filter, not a hasEvery brand gate', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await run(ghanaAdmin.getRecentSignups, { period: '1y', role: 'customer' });
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.roles).toEqual({ has: 'customer' });
    expect(where.roles).not.toHaveProperty('hasEvery');
  });

  it('scopes to a single YYYY-MM bucket via the month param', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await run(ghanaAdmin.getRecentSignups, { period: '1y', month: '2026-09' });
    const { createdAt } = prisma.user.findMany.mock.calls[0][0].where;
    expect(createdAt.gte.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(createdAt.lt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('scopes bucket labels by granularity: day = 1 day, week = 7 days', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await run(ghanaAdmin.getRecentSignups, { period: '30d', bucket: '2026-10-05', granularity: 'day' });
    let { createdAt } = prisma.user.findMany.mock.calls[0][0].where;
    expect(createdAt.gte.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(createdAt.lt.toISOString()).toBe('2026-10-06T00:00:00.000Z');

    await run(ghanaAdmin.getRecentSignups, { period: '90d', bucket: '2026-10-05', granularity: 'week' });
    ({ createdAt } = prisma.user.findMany.mock.calls[1][0].where);
    expect(createdAt.gte.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(createdAt.lt.toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });

  it('rejects malformed bucket labels without touching the window', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await run(ghanaAdmin.getRecentSignups, { period: '1y', bucket: 'not-a-bucket' });
    const { createdAt } = prisma.user.findMany.mock.calls[0][0].where;
    expect(createdAt).not.toHaveProperty('lt');
  });

  it('defaults to today (start of day) when no period is sent', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await run(ghanaAdmin.getRecentSignups, {});
    const { createdAt } = prisma.user.findMany.mock.calls[0][0].where;
    const today = new Date();
    expect(createdAt.gte.getFullYear()).toBe(today.getFullYear());
    expect(createdAt.gte.getMonth()).toBe(today.getMonth());
    expect(createdAt.gte.getDate()).toBe(today.getDate());
    expect(createdAt).not.toHaveProperty('lt');
  });

  it('selects phone + latest booking phone fallback and exposes hasBookings', async () => {
    prisma.user.findMany.mockResolvedValue([USER, PLAIN_USER]);
    const { res } = await run(ghanaAdmin.getRecentSignups, { period: '1y', role: 'customer' });

    const select = prisma.user.findMany.mock.calls[0][0].select;
    expect(select.phone).toBe(true);
    expect(select.bookings).toEqual({ select: { leadTravelerPhone: true }, orderBy: { createdAt: 'desc' }, take: 1 });
    expect(select._count).toEqual({ select: { bookings: true } });

    const users = res.json.mock.calls[0][0].data.users;
    expect(users[0]).toMatchObject({
      id: 'u1', name: 'Ama', email: 'ama@example.com',
      phone: '+233 20 000 1111',
      hasBookings: true,
    });
    expect(users[0]).not.toHaveProperty('bookings');
    expect(users[1]).toMatchObject({ phone: '+233 24 555 6666', hasBookings: false });
  });

  it('keeps the account phone when it exists over the booking fallback', async () => {
    const BOTH = { ...USER, phone: '+233 30 111 2222' };
    prisma.user.findMany.mockResolvedValue([BOTH]);
    const { res } = await run(ghanaAdmin.getRecentSignups, { period: '1y' });
    expect(res.json.mock.calls[0][0].data.users[0].phone).toBe('+233 30 111 2222');
  });
});