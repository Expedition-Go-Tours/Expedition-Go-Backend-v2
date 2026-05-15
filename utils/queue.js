/**
 * Queue Infrastructure — BullMQ + Redis Background Jobs
 *
 * Decouples async work from the request-response cycle:
 *  - Email delivery (retry on failure, back-off)
 *  - WebSocket + DB notifications
 *  - Analytics event batch-processing
 *  - Scheduled aggregation refresh (materialized views, counters)
 *
 * DESIGN:
 *  - Each queue has a dedicated Redis key prefix — no namespace collisions.
 *  - Jobs are idempotent where possible (via job.id or dedup keys).
 *  - Workers start in server.js (not app.js) so the HTTP layer can fail fast
 *    while background processing continues independently.
 *
 * @author Tour Platform Team
 * @version 1.0.0
 */

const { Queue, Worker, QueueScheduler } = require('bullmq');
const IORedis = require('ioredis');

// ---------------------------------------------------------------------------
// Redis connection (reuse same config as utils/redisClient.js)
// ---------------------------------------------------------------------------
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let connection;
function getConnection() {
  if (!connection) {
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,   // BullMQ manages its own retries
      enableReadyCheck: false,      // Faster startup
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect: true,
    });
  }
  return connection;
}

// ---------------------------------------------------------------------------
// Named queues — add new ones here as the platform grows
// ---------------------------------------------------------------------------
const QUEUE_NAMES = {
  EVENTS:     '{analytics}:events',
  EMAILS:     '{communications}:emails',
  NOTIFICATIONS: '{communications}:notifications',
  AGGREGATIONS: '{analytics}:aggregations',
  CLEANUP:    '{system}:cleanup',
};

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,                      // Retry up to 3 times
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 100 },  // Keep for 1 day
  removeOnFail: { age: 7 * 24 * 3600 },               // Keep failures for 7 days
};

// ---------------------------------------------------------------------------
// Queue factory — create or retrieve a queue instance
// ---------------------------------------------------------------------------
const queueInstances = new Map();

function getQueue(queueName) {
  if (!queueInstances.has(queueName)) {
    queueInstances.set(
      queueName,
      new Queue(queueName, {
        connection: getConnection(),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      })
    );
  }
  return queueInstances.get(queueName);
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------
const eventQueue       = () => getQueue(QUEUE_NAMES.EVENTS);
const emailQueue       = () => getQueue(QUEUE_NAMES.EMAILS);
const notificationQueue = () => getQueue(QUEUE_NAMES.NOTIFICATIONS);
const aggregationQueue = () => getQueue(QUEUE_NAMES.AGGREGATIONS);
const cleanupQueue     = () => getQueue(QUEUE_NAMES.CLEANUP);

// ---------------------------------------------------------------------------
// Enqueue helpers (typed so callers don't touch raw queue names)
// ---------------------------------------------------------------------------

/**
 * Enqueue an analytics event for batch processing.
 * The worker flushes buffered events to the Event table on a cadence.
 */
async function enqueueEvent(eventData) {
  return eventQueue().add('event', eventData, {
    jobId: `evt:${eventData.name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  });
}

/**
 * Enqueue a transactional email.
 * Worker handles rendering + SendGrid delivery with retry.
 */
async function enqueueEmail({ to, subject, template, data, attachments }) {
  return emailQueue().add('email', { to, subject, template, data, attachments }, {
    jobId: `email:${to}:${Date.now()}`,
  });
}

/**
 * Enqueue a notification (DB + WebSocket).
 */
async function enqueueNotification({ userId, type, title, message, data }) {
  return notificationQueue().add('notify', { userId, type, title, message, data });
}

/**
 * Enqueue an aggregation refresh (materialized view, counter recalculation, etc.).
 * Use jobId with a static name to deduplicate (e.g. hourly refresh only keeps one pending).
 */
async function enqueueAggregation(jobName, payload = {}) {
  return aggregationQueue().add(jobName, payload, {
    jobId: `${jobName}:${Math.floor(Date.now() / 60000)}`, // Dedup per minute
  });
}

// ---------------------------------------------------------------------------
// Worker registration — called once at startup from server.js
// ---------------------------------------------------------------------------

/**
 * Register all queue processors.
 * @param {import('express').Application} app — Express app (for accessing io instance, etc.)
 */
function registerWorkers(app) {
  const conn = getConnection();

  /* ------------------------------------------------------------------
   * EMAIL WORKER
   * Handles SendGrid delivery with retry + back-off.
   * ------------------------------------------------------------------ */
  new Worker(
    QUEUE_NAMES.EMAILS,
    async (job) => {
      const { to, subject, template, data, attachments } = job.data;
      const { sendEmail } = require('./emailService');
      await sendEmail({ to, subject, template, data, attachments });
    },
    { connection: conn }
  );

  /* ------------------------------------------------------------------
   * NOTIFICATION WORKER
   * Creates DB notification + pushes real-time via Socket.IO.
   * ------------------------------------------------------------------ */
  new Worker(
    QUEUE_NAMES.NOTIFICATIONS,
    async (job) => {
      const { userId, type, title, message, data } = job.data;
      const { sendNotification } = require('./notificationService');
      await sendNotification({ userId, type, title, message, data });
    },
    { connection: conn }
  );

  /* ------------------------------------------------------------------
   * AGGREGATION WORKER
   * Periodic analytics refreshes (triggered by cron or scheduled jobs).
   * ------------------------------------------------------------------ */
  new Worker(
    QUEUE_NAMES.AGGREGATIONS,
    async (job) => {
      switch (job.name) {
        case 'refresh-popularity':
          // Invalidate popularity cache so next request recomputes
          const cache = require('./cacheHelper');
          await cache.invalidate(cache.TOUR_POPULAR_KEY);
          break;

        case 'cleanup-events':
          // Archive / delete events older than retention period
          const prisma = require('./prismaClient');
          const cutoff = new Date();
          cutoff.setFullYear(cutoff.getFullYear() - 2); // Keep 2 years
          await prisma.event.deleteMany({ where: { createdAt: { lt: cutoff } } });
          break;

        default:
          console.log('[Queue] Unknown aggregation job:', job.name);
      }
    },
    { connection: conn }
  );

  /* ------------------------------------------------------------------
   * CLEANUP WORKER
   * Scheduled maintenance jobs (old audit logs, expired cart items, etc.).
   * ------------------------------------------------------------------ */
  new Worker(
    QUEUE_NAMES.CLEANUP,
    async (job) => {
      switch (job.name) {
        case 'cleanup-audit-logs': {
          const { cleanupOldLogs } = require('./auditLogger');
          await cleanupOldLogs(365);
          break;
        }
        case 'cleanup-notifications': {
          const { cleanupOldNotifications } = require('./notificationService');
          await cleanupOldNotifications(90);
          break;
        }
        case 'cleanup-expired-cart': {
          const prisma = require('./prismaClient');
          const event = require('./eventEmitter');
          // Find expired items before deleting to emit abandonment events
          const expiredItems = await prisma.cartItem.findMany({
            where: { expiresAt: { lt: new Date() } },
            include: { tour: { select: { title: true, supplierId: true } } },
          });
          const result = await prisma.cartItem.deleteMany({
            where: { expiresAt: { lt: new Date() } },
          });
          // Emit abandonment event for each expired item
          for (const item of expiredItems) {
            event.emit({
              name: 'cart.abandoned',
              userId: item.customerId,
              resource: 'Tour',
              resourceId: item.tourId,
              properties: {
                tourTitle: item.tour.title,
                supplierId: item.tour.supplierId,
                total: parseFloat(item.total),
                currency: item.currency,
                expiredAt: item.expiresAt,
              },
              source: 'system',
            });
          }
          if (result.count > 0) {
            console.log(`[Queue] Cleaned ${result.count} expired cart items, emitted ${expiredItems.length} abandonment events`);
          }
          break;
        }
        default:
          console.log('[Queue] Unknown cleanup job:', job.name);
      }
    },
    { connection: conn }
  );

  console.log('[Queue] All workers registered');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function closeAll() {
  const closePromises = [];
  for (const [name, queue] of queueInstances) {
    closePromises.push(queue.close());
  }
  if (connection) {
    closePromises.push(connection.quit());
  }
  await Promise.allSettled(closePromises);
  queueInstances.clear();
}

module.exports = {
  QUEUE_NAMES,
  enqueueEmail,
  enqueueNotification,
  enqueueEvent,
  enqueueAggregation,
  registerWorkers,
  closeAll,
  getConnection,
};
