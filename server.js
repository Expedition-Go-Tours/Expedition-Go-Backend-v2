console.log('[BOOT] server.js started');

const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const prisma = require('./utils/prismaClient');
const { setIO, setupPrismaMiddleware } = require('./utils/dataChangeEmitter');
const { registerWorkers, closeAll, enqueueNotification, enqueueCleanup, enqueueAggregation, enqueueEvent, startResumeMonitor } = require('./utils/queue');
const { startAiCronFallback } = require('./utils/aiCronFallback');
const redisClient = require('./utils/redisClient');
const { acquireRunLock, releaseRunLock } = require('./utils/runLock');
const logger = require('./utils/logger');

// PM2 cluster worker index. Scheduling correctness comes from per-run Redis
// locks (runScheduledJob): when Redis is healthy only ONE worker/machine wins
// each sweep; isPrimaryWorker is used ONLY as the Redis-down fallback so a
// temporary Redis outage keeps today's single-box behaviour (worker 0 runs).
// NOTE: NODE_APP_INSTANCE is a per-machine PM2 identity, NOT distributed
// leader election — worker 0 exists on EVERY machine.
const isPrimaryWorker = Number(process.env.NODE_APP_INSTANCE || 0) === 0;

let io;

// Track active scheduler intervals so graceful shutdown can clear them.
const schedulerIntervals = new Set();
const schedulerTimeouts = new Set();

/**
 * Run a scheduled sweep exactly once across all workers/machines:
 *   - Redis healthy  → acquire a per-job lock; only the winner runs.
 *   - Redis down     → run only on the primary worker (single-box behaviour).
 * Locks are released with a compare-and-delete token so a stale owner can't
 * clear a newer owner's lock. Sweeps must remain idempotent — a lock expiry
 * during a crash can let another worker retry (acceptable by design).
 */
async function runScheduledJob(label, runFn, lockTtlMs) {
  const lock = await acquireRunLock(`sweep:${label}`, lockTtlMs);
  if (lock === false) return; // another owner holds it → skip
  const runLocally = lock === null ? isPrimaryWorker : true;
  if (!runLocally) return;
  try {
    await runFn();
  } finally {
    if (lock) await releaseRunLock(`sweep:${label}`, lock);
  }
}

let shuttingDown = false;

const shutdown = async (reason, err) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason}! Shutting down...`);

  if (err) {
    console.log(err.name, err.message);
    console.error(err.stack);
  }

  // 1) Stop scheduling NEW work (in-process timers) so nothing fires mid-drain.
  for (const t of schedulerIntervals) clearInterval(t);
  schedulerIntervals.clear();
  for (const t of schedulerTimeouts) clearTimeout(t);
  schedulerTimeouts.clear();

  // 2) Stop the AI cron fallback worker.
  try {
    const { stopAiCronFallback } = require('./utils/aiCronFallback');
    stopAiCronFallback();
  } catch (err) {
    logger.warn('[shutdown] stopAiCronFallback failed:', err?.message);
  }

  // 3) Stop accepting NEW connections; drain in-flight requests. pm2 reload
  //    sends SIGINT then waits kill_timeout before SIGKILL, so finish fast.
  const drain = () =>
    new Promise((resolve) => {
      if (!server) return resolve();
      // Stop the listener; keep-alive idle sockets no longer hold the drain open.
      server.close(() => resolve());
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      // Force-resolve after a short grace so a hung request can't block SIGKILL.
      setTimeout(resolve, 5000).unref?.();
    });

  try {
    if (io) {
      io.close(() => {});
    }
  } catch (e) {
    console.error('Error closing Socket.IO:', e?.message || e);
  }

  await drain();

  // 4) Tear down infra (Prisma, queue, Redis) then exit.
  try {
    await prisma.$disconnect();
    console.log('Prisma disconnected');
  } catch (e) {
    console.error('Error disconnecting Prisma:', e?.message || e);
  }

  try {
    await closeAll();
  } catch (e) {
    console.error('Error closing queue:', e?.message || e);
  }

  try {
    await redisClient.quit();
  } catch (e) {
    console.error('Error quitting Redis:', e?.message || e);
  }

  process.exit(err ? 1 : 0);
};

// Known non-fatal error classes that must never take down the process. These
// are infrastructure blips (Upstash throttling, dropped TLS sockets) that the
// app already degrades around; log-and-continue instead of shutting down.
function isNonFatalError(err) {
  if (!err || typeof err.message !== 'string') return false;
  const msg = `${err.message} ${err.stack || ''}`;
  return /Socket closed unexpectedly|Connection is closed|Connection closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|max requests limit|@redis\/client|ioredis|Redis connection/.test(msg);
}

process.on('uncaughtException', (err) => {
  if (isNonFatalError(err)) {
    console.warn('[uncaughtException] Non-fatal error â€” continuing:', err.message);
    return;
  }
  shutdown('UNCAUGHT EXCEPTION', err);
});

dotenv.config({ path: './.env' });

const { validateEnv } = require('./config/validateEnv');
validateEnv();

const app = require('./app');

const port = process.env.PORT || 5000;

process.on('unhandledRejection', (err) => {
  // ioredis rejects in-flight commands with "Connection is closed" when the
  // Upstash TLS socket drops (e.g. request-limit throttling). That's an
  // infrastructure blip, not an app bug â€” log it and keep serving; the
  // degraded-mode fallbacks handle the actual work. Anything else still shuts
  // down so real bugs stay loud.
  if (isNonFatalError(err)) {
    console.warn('[unhandledRejection] Non-fatal error â€” continuing:', err?.message);
    return;
  }
  shutdown('UNHANDLED REJECTION', err);
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM received');
});

process.on('SIGINT', () => {
  shutdown('SIGINT received');
});

const server = http.createServer(app);

// Listen immediately so Render health checks pass while async init completes
server.listen(port, '0.0.0.0', () => {
  console.log(`[Startup] HTTP server listening on ${port}`);
  console.log(`[Startup] Environment: ${process.env.NODE_ENV}`);
});

setupSocketIO();

// Async initialization (Prisma, Redis, queue workers) — non-blocking.
// EVERY worker registers scheduler tickers + BullMQ consumers:
//   - Scheduler ticks arbitrate via per-job Redis locks (runScheduledJob), so
//     only one worker/machine runs each sweep; worker 0 is the Redis-down
//     fallback. Correct across machines.
//   - BullMQ workers are shared through Redis (each job runs once).
// AI cron + the BM25 index build are kept on the primary worker only.
(async () => {
  try {
    await prisma.$connect();
    console.log('[Startup] PostgreSQL connected');
  } catch (err) {
    console.error('[Startup] PostgreSQL connection failed:', err?.message || err);
  }

  setupPrismaMiddleware(prisma);

  // Ensure the Redis client exists & a connect was attempted BEFORE queue/
  // scheduler setup — probe() (used inside setupQueueWorkers) used to run
  // before any connection existed and wrongly reported Redis "unavailable",
  // which skipped registerWorkers() at boot.
  const redisOk = await redisClient.isRedisAvailable();

  // Wire the Socket.IO Redis adapter (rooms/broadcasts across cluster workers).
  // Must run after io exists (setupSocketIO() ran above) and after Redis is
  // known-good so the adapter actually connects.
  setupRedisAdapter();

  await setupQueueWorkers(redisOk);

  if (isPrimaryWorker) {
    // AI cron fallback — processes PENDING/FAILED tours directly.
    startAiCronFallback();

    // Build BM25 search index in background (non-blocking)
    buildBm25Index().catch(err => console.warn('[BM25] Index build failed:', err.message));
  }
})();

async function buildBm25Index() {
  const bm25 = require('./utils/bm25Index');
  const prisma = require('./utils/prismaClient');
  const tours = await prisma.tour.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true, title: true, description: true, tags: true, category: true,
      city: true, country: true, attractions: true, aiMoodTags: true, aiPrimaryCategory: true,
    },
  });
  bm25.buildIndex(tours);
}

function setupRedisAdapter() {
  if (!process.env.REDIS_URL) return;
  (async () => {
    // Gate on the shared degraded-mode state first: if Redis is already
    // quota-limited/unavailable, don't even create the pub/sub clients â€” an
    // orphaned, unguarded client is exactly what used to crash the process.
    if (!(await redisClient.isRedisAvailable())) {
      console.warn('[Socket.IO] Redis unavailable â€” using in-process adapter (single instance fallback)');
      return;
    }
    try {
      const { createAdapter } = require('@socket.io/redis-adapter');
      // Pub/sub clients share the same ioredis connection, degraded-mode state
      // and error handling as the rest of the app (no separate `redis` stack).
      const { pub, sub } = redisClient.getPubSubClients();
      await Promise.all([pub.connect(), sub.connect()]);
      io.adapter(createAdapter(pub, sub));
      console.log('[Socket.IO] Redis adapter connected');
    } catch (err) {
      console.warn('[Socket.IO] Redis adapter unavailable:', err?.message);
    }
  })();
}

/**
 * Booking-lifecycle sweeps run on DIRECT in-app timers, independent of Redis/
 * BullMQ, so they fire even on degraded boots where Redis is down. Every worker
 * keeps a timer, but runScheduledJob arbitrates via a per-job Redis lock — only
 * ONE worker runs each sweep when Redis is healthy; worker 0 runs it when Redis
 * is unreachable. All of these jobs are idempotent DB/Stripe/email sweeps, so a
 * lock-expiry race (crash + retry) is safe. Each runs once shortly after boot
 * to catch up on anything missed while the process was down.
 *
 * lockTtlMs protects the EXECUTION window, not the scheduling interval: keep it
 * comfortably above the sweep's observed runtime (record timings in logs), NOT
 * derived from the cadence. Raise it only if a run approaches the TTL.
 */
function scheduleBookingLifecycle() {
  const jobs = [
    // Auto-complete CONFIRMED bookings once their activity date has passed.
    { label: 'auto-complete-bookings', ms: 15 * 60 * 1000, lockTtlMs: 15 * 60 * 1000, run: () => require('./utils/bookingCleanup').autoCompleteBookings() },
    // Auto-cancel PENDING bookings past their activity date (48h grace).
    { label: 'cancel-stale-pending-bookings', ms: 15 * 60 * 1000, lockTtlMs: 15 * 60 * 1000, run: () => require('./utils/bookingCleanup').cancelStalePendingAfterTravelDate() },
    // Auto-cancel long-stale PENDING bookings.
    { label: 'cleanup-stale-bookings', ms: 5 * 60 * 1000, lockTtlMs: 15 * 60 * 1000, run: () => require('./utils/bookingCleanup').cancelStalePendingBookings() },
    // Release expired pay-now seat holds (CheckoutDraft).
    { label: 'expire-checkout-holds', ms: 5 * 60 * 1000, lockTtlMs: 15 * 60 * 1000, run: () => require('./utils/bookingCleanup').expireCheckoutHolds() },
    // Charge reserve-now-pay-later bookings near the activity date.
    { label: 'charge-pay-later-bookings', ms: 30 * 60 * 1000, lockTtlMs: 30 * 60 * 1000, run: () => require('./utils/payLaterSweep').chargePayLaterBookings() },
    // Finance: flip past PENDING bookings to ELIGIBLE for payout requests.
    { label: 'earnings-eligibility-sweep', ms: 30 * 60 * 1000, lockTtlMs: 30 * 60 * 1000, run: () => require('./utils/payoutCycles').sweepEarningsEligibility() },
    // Plan + dispatch time-based booking reminders (payment due, 24h-before,
    // pickup required, review request).
    { label: 'plan-booking-reminders', ms: 60 * 60 * 1000, lockTtlMs: 60 * 60 * 1000, run: () => require('./utils/bookingReminders').planBookingReminders() },
    { label: 'dispatch-booking-reminders', ms: 15 * 60 * 1000, lockTtlMs: 30 * 60 * 1000, run: () => require('./utils/bookingReminders').dispatchDueReminders() },
  ];

  for (const job of jobs) {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      runScheduledJob(job.label, job.run, job.lockTtlMs)
        .catch((err) => logger.warn(`[scheduler] ${job.label} failed:`, err?.message))
        .finally(() => { running = false; });
    };
    schedulerIntervals.add(setInterval(tick, job.ms));
    // Catch up once shortly after boot (covers a restart that happened after
    // an activity date passed while the process was down).
    schedulerTimeouts.add(setTimeout(tick, 15000));
  }
}

async function setupQueueWorkers(redisOk = true) {
  console.log(`[Startup] worker ${process.env.NODE_APP_INSTANCE || 0} — checking Redis for queue workers...`);
  startResumeMonitor();

  // ── Periodic interval tickers (EVERY worker registers these) ──────────────
  // Each tick goes through runScheduledJob: when Redis is healthy only ONE
  // worker/machine wins the per-job lock; when Redis is unreachable worker 0
  // runs (today's single-box behaviour). All operations are idempotent.
  const { reconcileGhanaPublish } = require('./utils/autoPublishGhana');
  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('reconcile-ghana', reconcileGhanaPublish, 30 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] ghana-publish reconcile failed:', err?.message));
  }, 30 * 60 * 1000));

  const { reconcileTravioAfricaPublish } = require('./utils/autoPublishTravioAfrica');
  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('reconcile-travioafrica', reconcileTravioAfricaPublish, 30 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] travioafrica-publish reconcile failed:', err?.message));
  }, 30 * 60 * 1000));

  // Booking-lifecycle sweeps (see scheduleBookingLifecycle).
  scheduleBookingLifecycle();

  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('cleanup-expired-cart', () => enqueueCleanup('cleanup-expired-cart'), 10 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] cleanup-expired-cart failed:', err?.message));
  }, 5 * 60 * 1000));

  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('refresh-popularity', () => enqueueAggregation('refresh-popularity'), 60 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] refresh-popularity failed:', err?.message));
  }, 60 * 60 * 1000));

  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('cleanup-events', () => enqueueAggregation('cleanup-events'), 24 * 60 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] cleanup-events failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('cleanup-notifications', () => enqueueCleanup('cleanup-notifications'), 24 * 60 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] cleanup-notifications failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('cleanup-audit-logs', () => enqueueCleanup('cleanup-audit-logs'), 24 * 60 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] cleanup-audit-logs failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('purge-archived-tours', () => enqueueCleanup('purge-archived-tours'), 24 * 60 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] purge-archived-tours failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('expire-special-offers', () => enqueueCleanup('expire-special-offers'), 24 * 60 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] expire-special-offers failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  // Document expiration + 60/30/7-day licence/certificate reminders.
  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('expire-supplier-documents', () => enqueueCleanup('expire-supplier-documents'), 24 * 60 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] expire-supplier-documents failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('plan-doc-expiry-reminders', () => enqueueCleanup('plan-doc-expiry-reminders'), 24 * 60 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] plan-doc-expiry-reminders failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  // Aggregate yesterday's tour views into DailyTourStats (runs daily at 00:05 UTC)
  schedulerIntervals.add(setInterval(() => {
    runScheduledJob('aggregate-daily-views', () => enqueueAggregation('aggregate-daily-views'), 24 * 60 * 60 * 1000)
      .catch((err) => logger.warn('[scheduler] aggregate-daily-views failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  // ── Queue consumers (EVERY worker registers BullMQ workers; shared via Redis) ──
  if (!redisOk) {
    console.warn('[Queue] Redis unavailable — using inline fallback (workers will register on recovery)');
    return;
  }
  registerWorkers(app);
  console.log('[Queue] Workers registered');

  // ── One-shot boot work (PRIMARY only — global actions must not duplicate) ──
  if (!isPrimaryWorker) return;

  // Backfill: publish all existing Ghana suppliers' tours on boot
  reconcileGhanaPublish().catch((err) => logger.warn('[scheduler] startup ghana-publish reconcile failed:', err?.message));

  // Backfill: publish all existing non-Ghana African suppliers' tours on boot
  reconcileTravioAfricaPublish().catch((err) => logger.warn('[scheduler] startup travioafrica-publish reconcile failed:', err?.message));

  enqueueCleanup('cleanup-expired-cart').catch((err) => logger.warn('[scheduler] startup cleanup-expired-cart failed:', err?.message));
  enqueueAggregation('refresh-popularity').catch((err) => logger.warn('[scheduler] startup refresh-popularity failed:', err?.message));
  enqueueAggregation('cleanup-events').catch((err) => logger.warn('[scheduler] startup cleanup-events failed:', err?.message));
  enqueueCleanup('cleanup-notifications').catch((err) => logger.warn('[scheduler] startup cleanup-notifications failed:', err?.message));
  enqueueCleanup('cleanup-audit-logs').catch((err) => logger.warn('[scheduler] startup cleanup-audit-logs failed:', err?.message));
  enqueueCleanup('purge-archived-tours').catch((err) => logger.warn('[scheduler] startup purge-archived-tours failed:', err?.message));
  enqueueCleanup('expire-special-offers').catch((err) => logger.warn('[scheduler] startup expire-special-offers failed:', err?.message));
  enqueueCleanup('expire-supplier-documents').catch((err) => logger.warn('[scheduler] startup expire-supplier-documents failed:', err?.message));
  enqueueCleanup('plan-doc-expiry-reminders').catch((err) => logger.warn('[scheduler] startup plan-doc-expiry-reminders failed:', err?.message));

  // Pre-compute homepage sections so the first user request is served instantly
  const { enqueueHomepagePrecompute } = require('./utils/queue');
  enqueueHomepagePrecompute().catch((err) => logger.warn('[scheduler] startup homepage-precompute failed:', err?.message));
}

function setupSocketIO() {
  const allowedOrigins = [
    ...new Set([
      ...(process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
        : []),
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]),
  ];

  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
    },
    transports: ['websocket'],
    allowEIO3: true,
  });

  app.set('io', io);
  setIO(io);

  console.log('[Startup] Socket.IO configured');

  io.engine.on('connection_error', (err) => {
    console.warn('Socket.IO connection error:', err.message);
  });

  const connectionAttempts = new Map();
  const RATE_LIMIT = 10;
  const RATE_WINDOW = 60 * 1000;

  io.use(async (socket, next) => {
    try {
      const ip = socket.handshake.address;
      const now = Date.now();
      const attempts = connectionAttempts.get(ip) || [];
      const recent = attempts.filter(t => now - t < RATE_WINDOW);
      if (recent.length >= RATE_LIMIT) {
        return next(new Error('Too many connection attempts'));
      }
      recent.push(now);
      connectionAttempts.set(ip, recent);

      const parseCookies = (h) => (h || '').split(';').reduce((o, p) => {
        const [k, ...v] = p.trim().split('=');
        if (k) o[k.trim()] = v.join('=');
        return o;
      }, {});
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const token = socket.handshake.auth?.token || cookies.accessToken;

      if (!token) {
        return next(new Error('No token provided'));
      }

      let decoded;
      try {
        const { verifyAccessToken } = require('./config/jwt');
        decoded = verifyAccessToken(token);
      } catch {
        return next(new Error('Invalid token'));
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, roles: true, active: true, name: true },
      });

      if (!user || !user.active) {
        return next(new Error('User not found or inactive'));
      }

      socket.userId = user.id;
      socket.userRoles = user.roles;
      socket.userName = user.name || 'Unknown';

      const ttl = decoded.exp * 1000 - Date.now();
      if (ttl > 0) {
        setTimeout(() => {
          socket.emit('auth:expired', { message: 'Token expired, please reconnect' });
          socket.disconnect(true);
        }, ttl);
      }

      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id, { userId: socket.userId, roles: socket.userRoles });

    if (socket.userRoles.includes('admin')) {
      socket.join('admin-room');
      const chatService = require('./utils/chatService');
      chatService.getSharedAdminId().then(sharedId => {
        if (sharedId) socket.join(`user:${sharedId}`);
      });
    }

    if (socket.userRoles.includes('expedition')) {
      socket.join('expedition-room');
      const chatService = require('./utils/chatService');
      chatService.getSharedExpeditionId().then(sharedId => {
        if (sharedId) socket.join(`user:${sharedId}`);
      });
    }

    socket.join(`user:${socket.userId}`);

    socket.on('review:respond', async (payload, ack) => {
      try {
        const { reviewId, response } = payload || {};
        if (!reviewId || !response || !response.trim()) {
          return ack?.({ status: 'error', message: 'reviewId and response are required' });
        }
        if (!socket.userRoles.includes('supplier')) {
          return ack?.({ status: 'error', message: 'Only suppliers can respond to reviews' });
        }

        const review = await prisma.review.findFirst({
          where: {
            id: reviewId,
            tour: { supplierId: socket.userId },
            status: 'APPROVED'
          },
          include: {
            customer: { select: { id: true, name: true } },
            tour: { select: { id: true, title: true } }
          }
        });

        if (!review) {
          return ack?.({ status: 'error', message: 'Review not found or access denied' });
        }

        if (review.supplierResponse) {
          return ack?.({ status: 'error', message: 'Response already exists for this review' });
        }

        const updated = await prisma.review.update({
          where: { id: reviewId },
          data: {
            supplierResponse: response,
            supplierResponseAt: new Date()
          },
          include: {
            customer: { select: { id: true, name: true, photoURL: true } },
            tour: { select: { id: true, title: true } }
          }
        });

        io.to(`user:${review.customerId}`).emit('review:response', {
          reviewId: updated.id,
          tourId: updated.tourId,
          tourTitle: review.tour.title,
          supplierResponse: updated.supplierResponse,
          supplierResponseAt: updated.supplierResponseAt
        });

        enqueueNotification({
          userId: review.customerId,
          type: 'REVIEW_RECEIVED',
          title: 'Supplier Responded to Your Review',
          message: `The supplier responded to your review for "${review.tour.title}"`,
          data: { reviewId: review.id, tourId: review.tourId }
        }).catch((err) => console.error('[Notification] enqueueNotification failed:', err.message));

        ack?.({ status: 'success', data: { review: updated } });

        enqueueEvent({
          name: 'review.responded',
          userId: socket.userId,
          resource: 'Review',
          resourceId: reviewId,
          properties: { tourId: review.tourId, customerId: review.customerId },
          source: 'web',
        });
      } catch (err) {
        console.error('Socket review:respond error:', err);
        ack?.({ status: 'error', message: 'Internal server error' });
      }
    });

    const chatService = require('./utils/chatService');

    socket.on('chat:join', async (payload, ack) => {
      try {
        const { conversationId } = payload || {};
        if (!conversationId) return ack?.({ status: 'error', message: 'conversationId required' });

        const effectiveUserId = socket.userRoles.includes('admin')
          ? (await chatService.getSharedAdminId()) || socket.userId
          : socket.userId;

        const participant = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
        });

        if (!participant) return ack?.({ status: 'error', message: 'Access denied' });

        socket.join(`conversation:${conversationId}`);
        ack?.({ status: 'success' });
      } catch (err) {
        console.error('Socket chat:join error:', err);
        ack?.({ status: 'error', message: 'Internal server error' });
      }
    });

    socket.on('chat:leave', async (payload, ack) => {
      try {
        const { conversationId } = payload || {};
        if (!conversationId) return ack?.({ status: 'error', message: 'conversationId required' });

        const effectiveUserId = socket.userRoles.includes('admin')
          ? (await chatService.getSharedAdminId()) || socket.userId
          : socket.userId;

        const participant = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
        });

        if (!participant) return ack?.({ status: 'error', message: 'Access denied' });

        socket.leave(`conversation:${conversationId}`);
        ack?.({ status: 'success' });
      } catch (err) {
        console.error('Socket chat:leave error:', err);
        ack?.({ status: 'error', message: 'Internal server error' });
      }
    });

    socket.on('chat:message', async (payload, ack) => {
      try {
        const { conversationId, content, attachmentUrl, attachmentType } = payload || {};

        if (!conversationId) return ack?.({ status: 'error', message: 'conversationId required' });
        if (!content && !attachmentUrl) return ack?.({ status: 'error', message: 'content or attachment required' });
        if (content && content.length > 5000) return ack?.({ status: 'error', message: 'Message too long (max 5000 characters)' });

        const effectiveUserId = socket.userRoles.includes('admin')
          ? (await chatService.getSharedAdminId()) || socket.userId
          : socket.userId;

        const participant = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
        });

        if (!participant) return ack?.({ status: 'error', message: 'Access denied' });

        const message = await chatService.sendMessage(conversationId, effectiveUserId, content || '', {
          url: attachmentUrl,
          type: attachmentType,
        });

        io.to(`conversation:${conversationId}`).emit('chat:message', {
          conversationId,
          message,
        });

        const recipient = await prisma.conversationParticipant.findFirst({
          where: { conversationId, userId: { not: effectiveUserId } },
          select: { userId: true }
        });
        if (recipient) {
          io.to(`user:${recipient.userId}`).emit('chat:message', {
            conversationId,
            message,
          });
        }

        ack?.({ status: 'success', data: { message } });
      } catch (err) {
        console.error('Socket chat:message error:', err);
        ack?.({ status: 'error', message: 'Internal server error' });
      }
    });

    socket.on('chat:typing', async (payload) => {
      try {
        const { conversationId, isTyping } = payload || {};
        if (!conversationId) return;

        const effectiveUserId = socket.userRoles.includes('admin')
          ? (await chatService.getSharedAdminId()) || socket.userId
          : socket.userId;

        const participant = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
        });

        if (!participant) {
          console.warn(`[chat:typing] Participant not found: conv=${conversationId}, userId=${effectiveUserId}, socketUserId=${socket.userId}`);
          return;
        }

        socket.to(`conversation:${conversationId}`).emit('chat:typing', {
          conversationId,
          userId: effectiveUserId,
          isTyping: !!isTyping,
        });

        const recipient = await prisma.conversationParticipant.findFirst({
          where: { conversationId, userId: { not: effectiveUserId } },
          select: { userId: true },
        });
        if (recipient) {
          io.to(`user:${recipient.userId}`).emit('chat:typing', {
            conversationId,
            userId: effectiveUserId,
            isTyping: !!isTyping,
            userName: socket.userName || 'Someone',
          });
        }
      } catch (err) {
        console.error('Socket chat:typing error:', err);
      }
    });

    socket.on('chat:mark-read', async (payload, ack) => {
      try {
        const { conversationId } = payload || {};
        if (!conversationId) return ack?.({ status: 'error', message: 'conversationId required' });

        const effectiveUserId = socket.userRoles.includes('admin')
          ? (await chatService.getSharedAdminId()) || socket.userId
          : socket.userId;

        const participant = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
        });

        if (!participant) return ack?.({ status: 'error', message: 'Access denied' });

        await chatService.markAsRead(conversationId, effectiveUserId);

        socket.to(`conversation:${conversationId}`).emit('chat:mark-read', {
          conversationId,
          readBy: effectiveUserId,
          readAt: new Date().toISOString(),
        });

        ack?.({ status: 'success' });
      } catch (err) {
        console.error('Socket chat:mark-read error:', err);
        ack?.({ status: 'error', message: 'Internal server error' });
      }
    });

    socket.on('chat:delivered', async (payload) => {
      try {
        const { conversationId, messageIds } = payload || {};
        if (!conversationId || !messageIds?.length) return;

        let effectiveUserId = socket.userId;
        if (socket.userRoles.includes('admin')) {
          effectiveUserId = (await chatService.getSharedAdminId()) || socket.userId;
        }

        const participant = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
        });

        if (!participant) return;

        socket.to(`conversation:${conversationId}`).emit('chat:delivered', {
          conversationId,
          messageIds,
          deliveredTo: effectiveUserId,
        });

        const recipient = await prisma.conversationParticipant.findFirst({
          where: { conversationId, userId: { not: effectiveUserId } },
          select: { userId: true }
        });
        if (recipient) {
          io.to(`user:${recipient.userId}`).emit('chat:delivered', {
            conversationId,
            messageIds,
            deliveredTo: effectiveUserId,
          });
        }
      } catch (err) {
        console.error('Socket chat:delivered error:', err);
      }
    });

    socket.on('error', (err) => {
      console.warn('Socket error:', socket.id, err.message);
    });

    socket.on('disconnect', (reason) => {
      console.log('Socket disconnected:', socket.id, reason);
    });
  });

  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
      return;
    }
    console.warn('HTTP client error:', err.message);
    socket.destroy(err);
  });

  // Socket.IO manages its own heartbeat (pingInterval/pingTimeout). A
  // socket-level timeout here would destroy idle long-poll and pooled
  // keep-alive connections with no HTTP response (net::ERR_EMPTY_RESPONSE).
  server.timeout = 0;
}
