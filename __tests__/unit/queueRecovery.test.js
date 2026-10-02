/**
 * Worker recovery — the path that failed silently in production.
 *
 * On 2026-10-02 unattended-upgrades restarted Redis (openssl bump). The
 * system-cleanup Worker paused on ECONNREFUSED and never resumed: 12 scheduled
 * jobs went 55 minutes without running while /health still showed schedules
 * registered. Recovery never logged a single attempt, because the monitor's
 * failure paths were `catch {}` / `.catch(() => {})`.
 *
 * These tests pin the behaviour that must not regress:
 *   - registration is idempotent (a duplicate consumer double-processes jobs)
 *   - a Worker that is neither running nor paused is detectable as broken
 *   - a broken Worker can be rebuilt from the spec recorded at registration
 *   - the monitor records a tick, so "monitor is alive" is observable
 *   - /health carries worker + monitor state, not just schedule registration
 */

jest.mock('bullmq', () => {
  // Shared, mutable scheduler list the tests control — lets a test put
  // /health into a real "healthy" baseline before breaking something.
  let mockSchedulers = [];
  const Queue = jest.fn(function Queue(name) {
    this.name = name;
    this.upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
    this.getJobSchedulers = jest.fn(() => Promise.resolve(mockSchedulers.map((k) => ({ key: k }))));
    this.close = jest.fn().mockResolvedValue(undefined);
  });
  // jest.fn wrapping a `function` so tests can both `new Worker(...)` and read
  // Worker.mock.calls to count registrations.
  const Worker = jest.fn(function Worker(name) {
    this.name = name;
    this.close = jest.fn().mockResolvedValue(undefined);
    this.on = jest.fn();
    this.pause = jest.fn().mockResolvedValue(undefined);
    this.resume = jest.fn().mockResolvedValue(undefined);
  });
  return { Queue, Worker, __setMockSchedulers: (list) => { mockSchedulers = list; } };
});

jest.mock('../../src/core/services/redisClient', () => ({
  getConnection: jest.fn(() => ({ status: 'ready' })),
  isRedisAvailable: jest.fn().mockResolvedValue(true),
  isReady: jest.fn(() => true),
  isLimitError: jest.fn(() => false),
  markUnavailable: jest.fn(),
  probe: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findUnique: jest.fn() },
  cartItem: { findMany: jest.fn(), deleteMany: jest.fn() },
  event: { deleteMany: jest.fn() },
  specialOffer: { findMany: jest.fn(), updateMany: jest.fn() },
  stripeEvent: { deleteMany: jest.fn() },
}));
jest.mock('../../src/core/services/emailService', () => ({
  sendBookingConfirmationEmail: jest.fn(),
  sendBookingCancellationEmail: jest.fn(),
  sendSupplierBookingNotification: jest.fn(),
  sendSupplierStatusEmail: jest.fn(),
  sendEmail: jest.fn(),
}));
jest.mock('../../src/core/services/notificationService', () => ({
  sendNotification: jest.fn(),
  cleanupOldNotifications: jest.fn(),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ cleanupOldLogs: jest.fn() }));
jest.mock('../../src/core/services/tourPurge', () => ({
  purgeArchivedTours: jest.fn(() => Promise.resolve({ scanned: 0, purged: 0, skipped: 0, failed: 0 })),
}));
jest.mock('../../src/core/services/cacheHelper', () => ({
  invalidateKeys: jest.fn(),
  TOUR_POPULAR_KEY: 'tour:popular',
}));
jest.mock('../../src/core/services/eventEmitter', () => ({ emit: jest.fn() }));

process.env.REDIS_URL = 'redis://localhost:6379';

const { Worker, __setMockSchedulers } = require('bullmq');
const queue = require('../../src/core/services/queue');

const CLEANUP = 'system-cleanup';

function makeWorker({ running = true, paused = false, withStateApi = true } = {}) {
  const w = { close: jest.fn().mockResolvedValue(), pause: jest.fn(), resume: jest.fn() };
  if (withStateApi) {
    w.isRunning = jest.fn(() => running);
    w.isPaused = jest.fn(() => paused);
  }
  return w;
}

describe('queue worker recovery', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await queue.closeAll().catch(() => {});
    __setMockSchedulers([]);
  });

  // A failure inside a fake-timer block would otherwise leak into every later
  // test in this file and report nonsense.
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('registration is idempotent', () => {
    it('does not create a second consumer for a queue that already has one', () => {
      queue.registerWorkers();
      const first = Worker.mock.calls.filter((c) => c[0] === CLEANUP).length;
      expect(first).toBe(1);

      queue.registerWorkers();
      const second = Worker.mock.calls.filter((c) => c[0] === CLEANUP).length;

      // Two consumers on one queue means duplicate side effects: two emails,
      // two payout runs. The recovery monitor calls registerWorkers() to
      // backfill, so this guard is load-bearing, not cosmetic.
      expect(second).toBe(1);
      expect(second).toBe(first);
    });

    it('still creates workers for every queue on first registration', () => {
      queue.registerWorkers();
      const names = Worker.mock.calls.map((c) => c[0]);
      for (const q of [CLEANUP, 'analytics-aggregations', 'communications-notifications']) {
        expect(names).toContain(q);
      }
    });

    it('records a spec that can rebuild each worker', () => {
      queue.registerWorkers();
      expect(queue._test.workerSpecs.has(CLEANUP)).toBe(true);
      const spec = queue._test.workerSpecs.get(CLEANUP);
      expect(typeof spec.recreate).toBe('function');
      expect(spec.processor).toEqual(expect.any(Function));
    });
  });

  describe('isWorkerBroken', () => {
    const { isWorkerBroken, isWorkerUsable, pausedWorkers } = queue._test;

    it('treats a running worker as healthy', () => {
      expect(isWorkerBroken(makeWorker({ running: true }))).toBe(false);
      expect(isWorkerUsable(makeWorker({ running: true }))).toBe(true);
    });

    it('treats a paused worker as recoverable, not broken', () => {
      const w = makeWorker({ running: false, paused: true });
      expect(isWorkerBroken(w)).toBe(false);
      expect(isWorkerUsable(w)).toBe(true);
    });

    it('flags a worker that is neither running nor paused — the incident state', () => {
      // BullMQ reports this when a connection blip killed the main loop: the
      // object still exists, so the old guard (only workers it had paused
      // itself) never saw it.
      const w = makeWorker({ running: false, paused: false });
      expect(isWorkerBroken(w)).toBe(true);
      expect(isWorkerUsable(w)).toBe(false);
    });

    it('does not guess when the state API is absent (test doubles, older lib)', () => {
      // Assumes healthy rather than tearing down every worker every 60s.
      expect(isWorkerBroken(makeWorker({ withStateApi: false }))).toBe(false);
      expect(isWorkerUsable(makeWorker({ withStateApi: false }))).toBe(true);
    });

    it('never reports a worker we deliberately paused as broken', () => {
      const w = makeWorker({ running: false, paused: false });
      pausedWorkers.add(w);
      expect(isWorkerBroken(w)).toBe(false);
      pausedWorkers.delete(w);
    });

    it('reports false for null rather than throwing', () => {
      expect(isWorkerBroken(null)).toBe(false);
      expect(isWorkerUsable(null)).toBe(false);
    });
  });

  describe('rebuildWorker', () => {
    it('closes the dead worker and registers a fresh one for the same queue', async () => {
      queue.registerWorkers();
      const workers = queue._test.getWorkers();
      const target = workers.find((w) => w.__queueName === CLEANUP);
      expect(target).toBeDefined();

      const callsBefore = Worker.mock.calls.filter((c) => c[0] === CLEANUP).length;
      const ok = await queue._test.rebuildWorker(target);

      expect(ok).toBe(true);
      expect(Worker.mock.calls.filter((c) => c[0] === CLEANUP).length).toBe(callsBefore + 1);
      // The dead one must leave the pool or two consumers share one queue.
      expect(queue._test.getWorkers().some((w) => w === target)).toBe(false);
      expect(queue._test.getWorkers().some((w) => w.__queueName === CLEANUP)).toBe(true);
    });

    it('refuses to rebuild an unknown queue instead of guessing', async () => {
      const orphan = makeWorker();
      orphan.__queueName = 'not-a-real-queue';
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      expect(await queue._test.rebuildWorker(orphan)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no spec recorded'));
      warn.mockRestore();
    });

    it('refuses a null worker', async () => {
      expect(await queue._test.rebuildWorker(null)).toBe(false);
    });

    it('applies a rebuild cooldown so a persistently stale queue cannot storm', async () => {
      queue.registerWorkers();
      const target = queue._test.getWorkers().find((w) => w.__queueName === CLEANUP);

      await queue._test.rebuildWorker(target);
      expect(queue._test.inRebuildCooldown(CLEANUP)).toBe(true);

      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + 6 * 60 * 1000);
      expect(queue._test.inRebuildCooldown(CLEANUP)).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('monitor observability', () => {
    afterEach(() => {
      jest.useRealTimers();
      if (console.warn.mockRestore) console.warn.mockRestore();
    });

    it('records a tick so a dead monitor is distinguishable from an idle one', async () => {
      jest.useFakeTimers();
      queue.registerWorkers();
      queue.startResumeMonitor();

      expect(queue._test.getMonitorState().lastTickAt).toBeNull();

      await jest.advanceTimersByTimeAsync(61 * 1000);

      expect(queue._test.getMonitorState().lastTickAt).not.toBeNull();
      expect(queue._test.getMonitorState().startedAt).not.toBeNull();
      jest.useRealTimers();
    });

    it('emits lastTickAt as ISO, matching every other timestamp in /health', async () => {
      jest.useFakeTimers();
      queue.registerWorkers();
      queue.startResumeMonitor();
      await jest.advanceTimersByTimeAsync(61 * 1000);
      jest.useRealTimers();

      const { lastTickAt, startedAt } = (await queue.getSchedulerHealth()).monitor;

      expect(lastTickAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(Number.isNaN(Date.parse(lastTickAt))).toBe(false);
      expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('is not marked stale immediately after it starts ticking', async () => {
      jest.useFakeTimers();
      queue.registerWorkers();
      queue.startResumeMonitor();
      await jest.advanceTimersByTimeAsync(61 * 1000);

      const health = await queue.getSchedulerHealth();
      expect(health.monitor).toBeDefined();
      expect(health.monitor.monitorStale).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('health reports worker and monitor state', () => {
    /** Put schedules into the state they are in on a healthy box. */
    const registerAllSchedules = () =>
      __setMockSchedulers(queue.SCHEDULES.map((s) => `sched:${s.jobName}`));

    it('is healthy with every schedule present and every worker alive', async () => {
      registerAllSchedules();
      queue.registerWorkers();
      const health = await queue.getSchedulerHealth();

      expect(health.status).toBe('healthy');
      expect(health.monitor).toBeDefined();
      expect(health.monitor.workers.registered).toBeGreaterThan(0);
      expect(health.monitor.workers.expected).toBeGreaterThan(0);
      expect(health.monitor.workers.broken).toBe(0);
      expect(health.monitor.monitorStale).toBe(false);
      // Every registered queue has a spec — otherwise rebuild is impossible.
      expect(health.monitor.workers.expected).toBeGreaterThanOrEqual(
        health.monitor.workers.registered,
      );
    });

    it('degrades when a worker is broken even though schedules are registered', async () => {
      registerAllSchedules();
      queue.registerWorkers();
      // Precondition: this is the incident's starting state, schedules fine.
      expect((await queue.getSchedulerHealth()).status).toBe('healthy');

      const cleanupWorker = queue._test.getWorkers().find((w) => w.__queueName === CLEANUP);
      cleanupWorker.isRunning = () => false;
      cleanupWorker.isPaused = () => false;

      const health = await queue.getSchedulerHealth();

      // The incident signature: registered schedules, dead consumer. It must
      // surface immediately rather than waiting 2x cadence to go stale.
      expect(health.monitor.workers.broken).toBeGreaterThan(0);
      expect(health.status).toBe('degraded');
    });
  });

  describe('a schedule that stops running is repaired (the incident path)', () => {
    it('rebuilds the consumer for the queue owning the stale job', async () => {
      queue.registerWorkers();
      const before = Worker.mock.calls.filter((c) => c[0] === CLEANUP).length;

      // cleanup-expired-cart runs every 5 min, so it is stale past 10. On
      // 2026-10-02 a Redis restart paused this consumer and nothing brought it
      // back: 12 jobs went 55 minutes without running while /health still
      // showed every schedule registered.
      queue._test.seedLastRun('cleanup-expired-cart', Date.now() - 11 * 60 * 1000);

      const stale = await queue._test.getStaleJobs();
      const entry = stale.find((s) => s.jobName === 'cleanup-expired-cart');
      expect(entry).toBeDefined();
      expect(entry.queueLabel).toBe('cleanup');

      jest.useFakeTimers();
      queue.startResumeMonitor();
      await jest.advanceTimersByTimeAsync(61 * 1000);
      jest.useRealTimers();

      const after = Worker.mock.calls.filter((c) => c[0] === CLEANUP).length;
      // Repair means a fresh consumer exists, not just a log line.
      expect(after).toBeGreaterThan(before);
      expect(queue._test.inRebuildCooldown(CLEANUP)).toBe(true);
    });

    it('leaves a queue alone while its schedules are fresh', async () => {
      queue.registerWorkers();
      const before = Worker.mock.calls.filter((c) => c[0] === CLEANUP).length;

      jest.useFakeTimers();
      queue.startResumeMonitor();
      await jest.advanceTimersByTimeAsync(61 * 1000);
      jest.useRealTimers();

      // Rebuilding a healthy worker would drop any in-flight job.
      expect(Worker.mock.calls.filter((c) => c[0] === CLEANUP).length).toBe(before);
    });

    it('does not rebuild the same queue on every tick while it stays stale', async () => {
      queue.registerWorkers();
      queue._test.seedLastRun('cleanup-expired-cart', Date.now() - 11 * 60 * 1000);

      jest.useFakeTimers();
      queue.startResumeMonitor();
      await jest.advanceTimersByTimeAsync(61 * 1000);
      const afterFirst = Worker.mock.calls.filter((c) => c[0] === CLEANUP).length;

      // Four more ticks, well past the first rebuild.
      await jest.advanceTimersByTimeAsync(4 * 61 * 1000);
      jest.useRealTimers();

      // Cooldown bounds the damage of a job that never recovers.
      expect(Worker.mock.calls.filter((c) => c[0] === CLEANUP).length).toBe(afterFirst);
    });
  });
});
