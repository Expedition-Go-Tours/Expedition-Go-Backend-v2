// Unit tests for the BullMQ job-scheduler layer: registration, verification
// and health. The underlying queues/workers are mocked so no Redis is touched.
jest.mock('bullmq', () => {
  // Shared, mutable scheduler list the tests control. Every mocked Queue's
  // getJobSchedulers reads from it, so the test can set it regardless of when
  // queue instances are lazily constructed.
  let mockSchedulers = [];
  const Queue = jest.fn(function Queue(name) {
    this.name = name;
    this.upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
    this.getJobSchedulers = jest.fn(() => Promise.resolve(mockSchedulers.map((k) => ({ key: k }))));
    this.close = jest.fn().mockResolvedValue(undefined);
  });
  class Worker {
    constructor() {
      this.close = jest.fn().mockResolvedValue(undefined);
      this.on = jest.fn();
      this.pause = jest.fn().mockResolvedValue(undefined);
      this.resume = jest.fn().mockResolvedValue(undefined);
    }
  }
  return { Queue, Worker, __setMockSchedulers: (list) => { mockSchedulers = list; } };
});

jest.mock('../../utils/redisClient', () => ({
  getConnection: jest.fn(() => ({ status: 'ready' })),
  isRedisAvailable: jest.fn().mockResolvedValue(true),
  isReady: jest.fn(() => true),
  isLimitError: jest.fn(() => false),
  markUnavailable: jest.fn(),
}));

const bullmq = require('bullmq');
const { __setMockSchedulers } = bullmq;
const queue = require('../../utils/queue');

beforeEach(() => {
  jest.clearAllMocks();
  __setMockSchedulers([]);
});

function setAllQueues(schedulerKeys) {
  __setMockSchedulers(schedulerKeys);
}
function queueInstances() {
  return bullmq.Queue.mock.instances || [];
}

describe('SCHEDULES', () => {
  it('covers the full expected sweep set with unique stable ids', () => {
    const names = queue.SCHEDULES.map((s) => s.jobName);
    const ids = names.map((n) => `sched:${n}`);
    expect(queue.SCHEDULES.length).toBeGreaterThanOrEqual(19);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of ['auto-complete-bookings', 'charge-pay-later-bookings', 'cleanup-stale-bookings', 'reconcile-ghana', 'reconcile-travioafrica', 'aggregate-daily-views']) {
      expect(names).toContain(n);
    }
  });
});

describe('registerSchedules', () => {
  it('upserts every schedule with a stable id + cadence and reports all ok', async () => {
    const results = await queue.registerSchedules();
    const calls = queueInstances().flatMap((q) => q.upsertJobScheduler.mock.calls);
    expect(results.length).toBe(queue.SCHEDULES.length);
    expect(results.every((r) => r.startsWith('ok:'))).toBe(true);
    expect(calls.length).toBe(queue.SCHEDULES.length);
    // Each call: (id, { every }, { name })
    for (const call of calls) {
      expect(call[0]).toMatch(/^sched:/);
      expect(typeof call[1].every).toBe('number');
      expect(typeof call[2].name).toBe('string');
    }
  });
});

describe('verifySchedules', () => {
  it('reports missing schedulers when Redis returns fewer than expected', async () => {
    const present = queue.SCHEDULES.slice(0, 3).map((s) => `sched:${s.jobName}`);
    setAllQueues(present);
    const v = await queue.verifySchedules();
    expect(v.expected).toBe(queue.SCHEDULES.length);
    expect(v.missing.length).toBeGreaterThan(0);
  });

  it('reports clean when every scheduler exists', async () => {
    const all = queue.SCHEDULES.map((s) => `sched:${s.jobName}`);
    setAllQueues(all);
    const v = await queue.verifySchedules();
    expect(v.missing).toEqual([]);
    expect(v.registered).toBe(v.expected);
  });
});

describe('getSchedulerHealth', () => {
  it('reports healthy when Redis has all schedulers and none are stale', async () => {
    const all = queue.SCHEDULES.map((s) => `sched:${s.jobName}`);
    setAllQueues(all);
    const h = await queue.getSchedulerHealth();
    expect(h.status).toBe('healthy');
    expect(h.expected).toBe(queue.SCHEDULES.length);
    expect(h.registered).toBe(h.expected);
    expect(h.missing).toEqual([]);
  });
});
