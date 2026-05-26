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

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');


const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let connection;
let connectionFailed = false;

async function isRedisAvailable() {
  try {
    const conn = getConnection();
    await conn.connect();
    await conn.ping();
    // Also check if we're being rate-limited
    if (connectionFailed) return false;
    connectionFailed = false;
    return true;
  } catch (err) {
    connectionFailed = true;
    if (err.message && err.message.includes('max requests limit')) {
      console.warn('[Queue] Upstash Redis rate limit exceeded — using inline fallbacks');
    }
    return false;
  }
}

function getConnection() {
  if (!connection) {
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,   
      enableReadyCheck: false,      // Faster startup
      retryStrategy: (times) => {
        if (connectionFailed) return null; // Stop retrying if rate limited
        return Math.min(times * 100, 3000);
      },
      lazyConnect: true,
    });
    connection.on('error', () => {}); // Suppressed — handled by isRedisAvailable
  }
  return connection;
}


const QUEUE_NAMES = {
  EVENTS:     'analytics-events',
  EMAILS:     'communications-emails',
  NOTIFICATIONS: 'communications-notifications',
  AGGREGATIONS: 'analytics-aggregations',
  CLEANUP:    'system-cleanup',
};

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,                      
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 100 },  // Keep for 1 day
  removeOnFail: { age: 7 * 24 * 3600 },              
};


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
  try {
    return await eventQueue().add('event', eventData, {
      jobId: `evt:${eventData.name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    });
  } catch { /* Redis unavailable — skip event */ }
}

/**
 * Process an email job directly (used by both the worker and the fallback
 * when Redis/BullMQ is unavailable).  This mirrors the logic in the EMAIL
 * WORKER section below so there is a single source of truth.
 */
async function processEmailJob(job) {
  const prisma = require('./prismaClient');

  switch (job.type) {
    case 'booking-confirmation': {
      const { sendBookingConfirmationEmail } = require('./emailService');
      const booking = await prisma.booking.findUnique({
        where: { id: job.bookingId },
        include: {
          customer: { select: { id: true, name: true, email: true } },
          tour: {
            select: {
              id: true, title: true, description: true, photos: true,
              productContent: true, bookingAndTickets: true,
              supplier: { select: { name: true, email: true, phone: true } },
            },
          },
        },
      });
      if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
      await sendBookingConfirmationEmail(booking);
      break;
    }

    case 'booking-cancellation': {
      const { sendBookingCancellationEmail } = require('./emailService');
      const booking = await prisma.booking.findUnique({
        where: { id: job.bookingId },
        include: {
          customer: { select: { id: true, name: true, email: true } },
          tour: { select: { id: true, title: true } },
        },
      });
      if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
      await sendBookingCancellationEmail(booking, job.refundAmount);
      break;
    }

    case 'supplier-booking-notification': {
      const { sendSupplierBookingNotification } = require('./emailService');
      const booking = await prisma.booking.findUnique({
        where: { id: job.bookingId },
        include: {
          customer: { select: { id: true, name: true, email: true, phone: true } },
          tour: {
            select: {
              id: true, title: true,
              supplier: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });
      if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
      await sendSupplierBookingNotification(booking);
      break;
    }

    case 'supplier-status-email': {
      const { sendSupplierStatusEmail } = require('./emailService');
      await sendSupplierStatusEmail(job.email, job.status, job.data || {});
      break;
    }

    default: {
      const { to, subject, template, data, attachments } = job;
      const { sendEmail } = require('./emailService');
      await sendEmail({ to, subject, template, data, attachments });
    }
  }
}

/**
 * Enqueue a transactional email.
 * Worker handles rendering + SendGrid delivery with retry.
 * Supports typed jobs (worker fetches its own data) and raw emails.
 * Falls back to direct sending when Redis/BullMQ is unavailable.
 */
async function enqueueEmail(job) {
  try {
    if (job.type) {
      return await emailQueue().add(job.type, job, {
        jobId: `email:${job.type}:${job.bookingId || 'x'}:${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    }
    return await emailQueue().add('email', job, {
      jobId: `email:${job.to}:${Date.now()}`,
    });
  } catch {
    processEmailJob(job).catch((err) => {
      console.error('[Queue] Fallback email failed:', err.message);
    });
  }
}

/**
 * Enqueue a cleanup/maintenance job.
 * Use job name for deduplication (only one pending per type).
 */
async function enqueueCleanup(jobName, payload = {}) {
  try {
    return await cleanupQueue().add(jobName, payload, {
      jobId: `${jobName}:${Math.floor(Date.now() / 60000)}`,
    });
  } catch { /* Redis unavailable — skip cleanup */ }
}

/**
 * Enqueue a notification (DB + WebSocket).
 */
async function enqueueNotification({ userId, type, title, message, data }) {
  try {
    return await notificationQueue().add('notify', { userId, type, title, message, data });
  } catch {
    const { sendNotification } = require('./notificationService');
    sendNotification({ userId, type, title, message, data }).catch((err) => {
      console.error('[Queue] Fallback notification failed:', err.message);
    });
  }
}

/**
 * Enqueue an aggregation refresh (materialized view, counter recalculation, etc.).
 * Use jobId with a static name to deduplicate (e.g. hourly refresh only keeps one pending).
 */
async function enqueueAggregation(jobName, payload = {}) {
  try {
    return await aggregationQueue().add(jobName, payload, {
      jobId: `${jobName}:${Math.floor(Date.now() / 60000)}`, // Dedup per minute
    });
  } catch { /* Redis unavailable — skip aggregation */ }
}

// ---------------------------------------------------------------------------
// Worker registration — called once at startup from server.js
// ---------------------------------------------------------------------------

/**
 * Register all queue processors.
 * @param {import('express').Application} app — Express app (for accessing io instance, etc.)
 */
function registerWorkers() {
  const conn = getConnection();

  function createWorker(queueName, processor) {
    const worker = new Worker(queueName, processor, { connection: conn });
    worker.on('error', () => {}); // Suppressed — handled by caller
    return worker;
  }

  /* ------------------------------------------------------------------
   * EMAIL WORKER
   * Handles typed email jobs (worker fetches booking data) and raw
   * pre-rendered emails.  Retries on SendGrid failure with back-off.
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.EMAILS, async (job) => {
    await processEmailJob(job.data);
  });

  /* ------------------------------------------------------------------
   * NOTIFICATION WORKER
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.NOTIFICATIONS, async (job) => {
    const { sendNotification } = require('./notificationService');
    await sendNotification(job.data);
  });

  /* ------------------------------------------------------------------
   * AGGREGATION WORKER
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.AGGREGATIONS, async (job) => {
    switch (job.name) {
      case 'refresh-popularity':
        const cache = require('./cacheHelper');
        await cache.invalidate(cache.TOUR_POPULAR_KEY);
        break;
      case 'cleanup-events':
        const prisma = require('./prismaClient');
        const cutoff = new Date();
        cutoff.setFullYear(cutoff.getFullYear() - 2);
        await prisma.event.deleteMany({ where: { createdAt: { lt: cutoff } } });
        break;
      default:
        console.log('[Queue] Unknown aggregation job:', job.name);
    }
  });

  /* ------------------------------------------------------------------
   * CLEANUP WORKER
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.CLEANUP, async (job) => {
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
        const expiredItems = await prisma.cartItem.findMany({
          where: { expiresAt: { lt: new Date() } },
          include: { tour: { select: { title: true, supplierId: true } } },
        });
        const result = await prisma.cartItem.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
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
  });

  console.log('[Queue] All workers registered');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function closeAll() {
  const closePromises = [];
  for (const [, queue] of queueInstances) {
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
  enqueueCleanup,
  processEmailJob,
  registerWorkers,
  closeAll,
  getConnection,
  isRedisAvailable,
};
