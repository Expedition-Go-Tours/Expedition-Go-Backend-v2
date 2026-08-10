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
const { getConnection, isRedisAvailable, isReady, isLimitError, markUnavailable, probe } = require('./redisClient');


const QUEUE_NAMES = {
  EVENTS:     'analytics-events',
  NOTIFICATIONS: 'communications-notifications',
  EMAILS:     'communications-emails',
  AGGREGATIONS: 'analytics-aggregations',
  CLEANUP:    'system-cleanup',
  STRIPE:         'platform-stripe',
  WEBHOOK_RETRY:  'webhook-retry',
  CONTENT_SYNC:   'content-sync',
};

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,                      
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 100 },  // Keep for 1 day
  removeOnFail: { age: 7 * 24 * 3600 },              
};


const queueInstances = new Map();
const workers = [];
const pausedWorkers = new Set();
let resumeMonitor = null;
let lastWorkerErrorLog = 0;
let closed = false;

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
const notificationQueue = () => getQueue(QUEUE_NAMES.NOTIFICATIONS);
const emailQueue       = () => getQueue(QUEUE_NAMES.EMAILS);
const aggregationQueue = () => getQueue(QUEUE_NAMES.AGGREGATIONS);
const cleanupQueue     = () => getQueue(QUEUE_NAMES.CLEANUP);
const stripeQueue      = () => getQueue(QUEUE_NAMES.STRIPE);
const webhookRetryQueue = () => getQueue(QUEUE_NAMES.WEBHOOK_RETRY);
const contentSyncQueue  = () => getQueue(QUEUE_NAMES.CONTENT_SYNC);

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
    await emailQueue().add('email', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  } catch {
    // Redis unavailable — send directly as fallback
    processEmailJob(job).catch((err) => {
      console.error('[Queue] Direct email fallback failed:', err.message);
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

/**
 * Enqueue a Stripe customer creation job.
 * Runs in the background so the signup response isn't blocked by Stripe's latency.
 * Retries 3 times with exponential backoff if Stripe is temporarily unavailable.
 */
async function enqueueCreateStripeCustomer(data) {
  try {
    await stripeQueue().add('create-customer', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  } catch {
    // Redis unavailable — create the customer inline so signups never silently
    // lose their Stripe customer (same pattern as enqueueEmail).
    const { createStripeCustomer } = require('./stripeHelpers');
    createStripeCustomer(data).catch((err) => {
      console.error('[Queue] Inline Stripe customer creation failed:', err.message);
    });
  }
}

/**
 * Enqueue a webhook event for retry.
 * Used when processStripeWebhook fails — the event is re-processed
 * with exponential backoff instead of being silently dropped.
 */
async function enqueueWebhookRetry(event) {
  try {
    await webhookRetryQueue().add('process-webhook', event, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 60000 }, // 1min → 2min → 4min → 8min → 16min
      removeOnComplete: { age: 24 * 3600, count: 50 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  } catch (err) {
    console.error('[Queue] Failed to enqueue webhook retry:', err.message);
  }
}

/**
 * Enqueue a content sync job (blog article published/unpublished).
 * Used by the Sanity webhook handler to invalidate caches asynchronously.
 */
async function enqueueContentSync(job) {
  try {
    return await contentSyncQueue().add('sync', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      jobId: `content-sync:${job.action}:${job.slug || Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    });
  } catch { /* Redis unavailable — skip content sync */ }
}

// ---------------------------------------------------------------------------
// Worker registration — called once at startup from server.js
// ---------------------------------------------------------------------------

/**
 * Register all queue processors.
 * @param {import('express').Application} app — Express app (for accessing io instance, etc.)
 */
function registerWorkers() {
  closed = false;
  const conn = getConnection();

  function createWorker(queueName, processor, concurrency = 1) {
    const worker = new Worker(queueName, processor, { connection: conn, concurrency });
    worker.on('error', (err) => {
      if (isLimitError(err) || !isReady()) {
        // Degraded (e.g. Upstash quota exhausted): stop the hot retry loop and
        // throttle logging to once per minute instead of ~50x/second.
        markUnavailable(err);
        if (!lastWorkerErrorLog || Date.now() - lastWorkerErrorLog > 60000) {
          console.warn(`[Queue] Worker error (${queueName}): Redis unavailable — pausing worker, using inline fallbacks (${err?.message || 'degraded'})`);
          lastWorkerErrorLog = Date.now();
        }
        if (!pausedWorkers.has(worker)) {
          pausedWorkers.add(worker);
          if (typeof worker.pause === 'function') worker.pause().catch(() => {});
        }
      } else {
        console.warn(`[Queue] Worker error (${queueName}):`, err?.message);
      }
    });
    workers.push(worker);
    return worker;
  }

  /* ------------------------------------------------------------------
   * NOTIFICATION WORKER (concurrency 5)
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.NOTIFICATIONS, async (job) => {
    const { sendNotification } = require('./notificationService');
    await sendNotification(job.data);
  }, 5);

  /* ------------------------------------------------------------------
   * EMAIL WORKER (concurrency 5)
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.EMAILS, async (job) => {
    await processEmailJob(job.data);
  }, 5);

  /* ------------------------------------------------------------------
   * STRIPE WORKER (concurrency 5)
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.STRIPE, async (job) => {
    // Lazily required to avoid a circular dependency (stripeHelpers requires ./queue).
    const { createStripeCustomer } = require('./stripeHelpers');

    const { userId, email, name } = job.data;
    await createStripeCustomer({ userId, email, name });
  }, 5);

  /* ------------------------------------------------------------------
   * WEBHOOK RETRY WORKER (concurrency 2)
   * Re-processes a Stripe webhook event that failed on first attempt.
   * Since processStripeWebhook now wraps everything in a single
   * $transaction, a retry is safe — the event either has
   * processed=false (rolled back) or doesn't exist yet.
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.WEBHOOK_RETRY, async (job) => {
    const { processStripeWebhook } = require('./stripeHelpers');
    await processStripeWebhook(job.data);
  }, 2);

  /* ------------------------------------------------------------------
   * CONTENT SYNC WORKER (concurrency 2)
   * Handles blog content cache invalidation on Sanity webhook.
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.CONTENT_SYNC, async (job) => {
    const cache = require('./cacheHelper');
    const CACHE_PREFIX = 'blog:';
    switch (job.data.action) {
      case 'article-published':
      case 'article-unpublished':
        await cache.invalidateKeys([
          `${CACHE_PREFIX}articles:list:*`,
          `${CACHE_PREFIX}article:${job.data.slug}`,
          `${CACHE_PREFIX}sitemap`,
        ]);
        break;
      case 'sitemap-regenerate':
        await cache.invalidateKeys([`${CACHE_PREFIX}sitemap`]);
        break;
      default:
        await cache.invalidateKeys([`${CACHE_PREFIX}*`]);
    }
  }, 2);

  /* ------------------------------------------------------------------
   * ANALYTICS EVENTS WORKER (concurrency 5)
   * Persists queued analytics events to the Event table.
   * NOTE: request-derived events (tour.viewed, expedition.tour_viewed, ...)
   * are emitted via eventEmitter.emit() directly — an Express req object is
   * not JSON-serializable and cannot travel through BullMQ. This worker
   * persists any event that reaches the queue with serializable data only.
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.EVENTS, async (job) => {
    const { emit } = require('./eventEmitter');
    const { name, userId, sessionId, resource, resourceId, properties, source } = job.data || {};
    if (!name) return;
    await emit({ name, userId, sessionId, resource, resourceId, properties, source });
  }, 5);

  /* ------------------------------------------------------------------
   * AGGREGATION WORKER
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.AGGREGATIONS, async (job) => {
    switch (job.name) {
      case 'refresh-popularity':
        const cache = require('./cacheHelper');
        await cache.invalidateKeys([cache.TOUR_POPULAR_KEY]);
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
      case 'cleanup-stale-bookings': {
        const { cancelStalePendingBookings } = require('./bookingCleanup');
        await cancelStalePendingBookings();
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
// Recovery monitor
// ---------------------------------------------------------------------------

/**
 * Every 60s, if we are in a degraded/recovered state, check Redis with the
 * real-command probe and (re)start workers. Runs no Redis calls while healthy
 * with running workers.
 */
function startResumeMonitor() {
  if (resumeMonitor) return;
  resumeMonitor = setInterval(async () => {
    try {
      if (closed) return;
      if (pausedWorkers.size > 0 || workers.length === 0) {
        if (await isRedisAvailable()) {
          const toResume = [...pausedWorkers];
          pausedWorkers.clear();
          for (const w of toResume) {
            if (typeof w.resume === 'function') await w.resume().catch(() => {});
          }
          if (workers.length === 0) {
            registerWorkers();
            console.log('[Queue] Redis available — workers registered');
          } else if (toResume.length > 0) {
            console.log('[Queue] Redis recovered — workers resumed');
          }
        }
      }
    } catch { /* keep the monitor alive */ }
  }, 60 * 1000);
  if (resumeMonitor.unref) resumeMonitor.unref();
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function closeAll() {
  closed = true;
  if (resumeMonitor) {
    clearInterval(resumeMonitor);
    resumeMonitor = null;
  }
  pausedWorkers.clear();
  const closePromises = [];
  for (const [, queue] of queueInstances) {
    closePromises.push(queue.close());
  }
  for (const worker of workers) {
    if (worker && typeof worker.close === 'function') {
      closePromises.push(worker.close());
    }
  }
  await Promise.allSettled(closePromises);
  queueInstances.clear();
  workers.length = 0;
}

module.exports = {
  QUEUE_NAMES,
  enqueueEmail,
  enqueueNotification,
  enqueueEvent,
  enqueueAggregation,
  enqueueCleanup,
  enqueueCreateStripeCustomer,
  enqueueWebhookRetry,
  enqueueContentSync,
  processEmailJob,
  registerWorkers,
  startResumeMonitor,
  closeAll,
  getConnection,
  isRedisAvailable,
  probe,
};
