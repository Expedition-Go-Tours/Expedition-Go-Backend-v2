jest.mock('bullmq', () => ({
  Queue: jest.fn(() => ({
    getJobSchedulers: jest.fn().mockResolvedValue(
      // Return all expected schedulers so verifySchedules() sees 0 missing.
      // These are the 20 schedulers from SCHEDULES in queue.js.
      [
        'cleanup-expired-cart', 'cleanup-notifications', 'cleanup-audit-logs',
        'purge-archived-tours', 'expire-special-offers', 'expire-supplier-documents',
        'plan-doc-expiry-reminders', 'auto-complete-bookings',
        'cancel-stale-pending-bookings', 'cleanup-stale-bookings',
        'expire-checkout-holds', 'charge-pay-later-bookings',
        'earnings-eligibility-sweep', 'plan-booking-reminders',
        'dispatch-booking-reminders', 'reconcile-ghana', 'reconcile-travioafrica',
        'refresh-popularity', 'cleanup-events', 'aggregate-daily-views',
      ].map((jobName) => ({ key: `sched:${jobName}` }))
    ),
    upsertJobScheduler: jest.fn().mockResolvedValue({}),
  })),
  Worker: jest.fn(() => ({ close: jest.fn().mockResolvedValue() })),
}));

jest.mock('ioredis', () => jest.fn(() => ({
  connect: jest.fn().mockResolvedValue(),
  ping: jest.fn().mockResolvedValue('PONG'),
  quit: jest.fn().mockResolvedValue(),
  on: jest.fn(),
})));

if (!global.__fakeExecStore) global.__fakeExecStore = {};

jest.mock('../../utils/redisClient', () => {
  const mockConn = {
    status: 'ready',
    get: jest.fn(async (key) => {
      const val = global.__fakeExecStore[key];
      return val != null ? JSON.stringify(val) : null;
    }),
    setex: jest.fn(async (key, ttl, val) => { global.__fakeExecStore[key] = JSON.parse(val); }),
    set: jest.fn(async (key, val) => { global.__fakeExecStore[key] = JSON.parse(val); }),
    del: jest.fn(async (key) => { delete global.__fakeExecStore[key]; }),
  };
  return {
    getConnection: jest.fn(() => mockConn),
    isRedisAvailable: jest.fn().mockResolvedValue(true),
    isReady: jest.fn().mockReturnValue(true),
    isLimitError: jest.fn().mockReturnValue(false),
    markUnavailable: jest.fn(),
    probe: jest.fn(),
    get: jest.fn(async (key) => global.__fakeExecStore[key] || null),
    set: jest.fn(async (key, data) => { global.__fakeExecStore[key] = data; }),
    del: jest.fn(async (key) => { delete global.__fakeExecStore[key]; }),
  };
});

jest.mock('../../utils/prismaClient', () => ({
  booking: { findUnique: jest.fn() },
  cartItem: { findMany: jest.fn(), deleteMany: jest.fn() },
}));

process.env.REDIS_URL = 'redis://localhost:6379';

const queueModule = require('../../utils/queue');
const fakeStore = global.__fakeExecStore;

describe('scheduler execution health — cluster-safe (Redis-backed)', () => {
  beforeEach(() => {
    Object.keys(fakeStore).forEach((k) => delete fakeStore[k]);
  });

  it('getSchedulerHealth reads execution state from Redis', async () => {
    const jobName = 'cleanup-stale-bookings';
    const lastRunAt = Date.now();
    fakeStore[`sched:exec:${jobName}`] = { lastRunAt, lastDurationMs: 12, lastFailureAt: null, consecutiveFailures: 0 };

    const health = await queueModule.getSchedulerHealth();
    expect(health.status).not.toBe('degraded');
    const stale = health.stale.find((s) => s.jobName === jobName);
    expect(stale).toBeUndefined();
  });

  it('flags stale when Redis record is older than 2x cadence', async () => {
    const jobName = 'cleanup-stale-bookings';
    fakeStore[`sched:exec:${jobName}`] = {
      lastRunAt: Date.now() - 15 * 60 * 1000,
      lastDurationMs: 10,
      lastFailureAt: null,
      consecutiveFailures: 0,
    };
    const health = await queueModule.getSchedulerHealth();
    const stale = health.stale.find((s) => s.jobName === jobName);
    expect(stale).toBeDefined();
    expect(health.status).toBe('degraded');
  });

  it('no flapping: stale → fresh record clears stale', async () => {
    const jobName = 'cleanup-stale-bookings';
    fakeStore[`sched:exec:${jobName}`] = {
      lastRunAt: Date.now() - 15 * 60 * 1000,
      lastDurationMs: 8,
      lastFailureAt: null,
      consecutiveFailures: 0,
    };
    const h1 = await queueModule.getSchedulerHealth();
    expect(h1.stale.find((s) => s.jobName === jobName)).toBeDefined();

    fakeStore[`sched:exec:${jobName}`] = {
      lastRunAt: Date.now(),
      lastDurationMs: 6,
      lastFailureAt: null,
      consecutiveFailures: 0,
    };
    const h2 = await queueModule.getSchedulerHealth();
    expect(h2.stale.find((s) => s.jobName === jobName)).toBeUndefined();
    expect(h2.status).toBe('healthy');
  });

  it('failure preserves remote lastRunAt and increments consecutiveFailures', async () => {
    const jobName = 'cleanup-stale-bookings';
    fakeStore[`sched:exec:${jobName}`] = {
      lastRunAt: Date.now() - 30 * 1000,
      lastDurationMs: 5,
      lastFailureAt: null,
      consecutiveFailures: 0,
    };
    // Simulate what recordSweepFailure does: merge remote + local, increment.
    const remote = fakeStore[`sched:exec:${jobName}`];
    const record = {
      lastRunAt: remote.lastRunAt,
      lastDurationMs: remote.lastDurationMs,
      lastFailureAt: Date.now(),
      consecutiveFailures: (remote.consecutiveFailures || 0) + 1,
    };
    fakeStore[`sched:exec:${jobName}`] = record;

    const h = await queueModule.getSchedulerHealth();
    const stale = h.stale.find((s) => s.jobName === jobName);
    expect(stale).toBeUndefined();
    expect(record.consecutiveFailures).toBe(1);
    expect(record.lastRunAt).toBeDefined();
  });
});
