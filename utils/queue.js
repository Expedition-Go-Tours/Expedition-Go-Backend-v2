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
  HOMEPAGE_PRECOMPUTE: 'homepage-precompute',
  AI_SCORING: 'ai-scoring',
  GHANA_PUBLISH: 'ghana-publish',
  TRAVIO_AFRICA_PUBLISH: 'travioafrica-publish',
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
const homepagePrecomputeQueue = () => getQueue(QUEUE_NAMES.HOMEPAGE_PRECOMPUTE);
const aiScoringQueue = () => getQueue(QUEUE_NAMES.AI_SCORING);
const ghanaPublishQueue = () => getQueue(QUEUE_NAMES.GHANA_PUBLISH);
const travioAfricaPublishQueue = () => getQueue(QUEUE_NAMES.TRAVIO_AFRICA_PUBLISH);

// ---------------------------------------------------------------------------
// Job Schedulers (single scheduling authority — BullMQ repeatable jobs)
// ---------------------------------------------------------------------------
// Cadences mirror the pre-BullMQ in-process timers exactly. Every entry is
// scheduled via queue.upsertJobScheduler with a STABLE id (sched:<jobName>), so
// re-registration on any worker/boot is idempotent — never a duplicate.
// Jobs are delivered at-least-once; business correctness lives in the
// idempotent handlers (DB status transitions + Stripe PaymentIntent semantics).
const SCHEDULES = [
  // CLEANUP — low-risk maintenance
  { jobName: 'cleanup-expired-cart',       queue: 'cleanup',      everyMs: 5 * 60 * 1000 },
  { jobName: 'cleanup-notifications',      queue: 'cleanup',      everyMs: 24 * 3600 * 1000 },
  { jobName: 'cleanup-audit-logs',         queue: 'cleanup',      everyMs: 24 * 3600 * 1000 },
  { jobName: 'purge-archived-tours',       queue: 'cleanup',      everyMs: 24 * 3600 * 1000 },
  { jobName: 'expire-special-offers',      queue: 'cleanup',      everyMs: 24 * 3600 * 1000 },
  { jobName: 'expire-supplier-documents',  queue: 'cleanup',      everyMs: 24 * 3600 * 1000 },
  { jobName: 'plan-doc-expiry-reminders',  queue: 'cleanup',      everyMs: 24 * 3600 * 1000 },
  // CLEANUP — lifecycle / money / reminders
  { jobName: 'auto-complete-bookings',      queue: 'cleanup',      everyMs: 15 * 60 * 1000 },
  { jobName: 'cancel-stale-pending-bookings', queue: 'cleanup',    everyMs: 15 * 60 * 1000 },
  { jobName: 'cleanup-stale-bookings',      queue: 'cleanup',      everyMs: 5 * 60 * 1000 },
  { jobName: 'expire-checkout-holds',       queue: 'cleanup',      everyMs: 5 * 60 * 1000 },
  { jobName: 'charge-pay-later-bookings',   queue: 'cleanup',      everyMs: 30 * 60 * 1000 },
  { jobName: 'earnings-eligibility-sweep',  queue: 'cleanup',      everyMs: 30 * 60 * 1000 },
  { jobName: 'plan-booking-reminders',      queue: 'cleanup',      everyMs: 3600 * 1000 },
  { jobName: 'dispatch-booking-reminders',  queue: 'cleanup',      everyMs: 15 * 60 * 1000 },
  // CLEANUP — reconciles
  { jobName: 'reconcile-ghana',             queue: 'cleanup',      everyMs: 30 * 60 * 1000 },
  { jobName: 'reconcile-travioafrica',      queue: 'cleanup',      everyMs: 30 * 60 * 1000 },
  // AGGREGATIONS
  { jobName: 'refresh-popularity',          queue: 'aggregation', everyMs: 3600 * 1000 },
  { jobName: 'cleanup-events',              queue: 'aggregation', everyMs: 24 * 3600 * 1000 },
  { jobName: 'aggregate-daily-views',       queue: 'aggregation', everyMs: 24 * 3600 * 1000 },
];

// Per-schedule execution health, tracked in-process as jobs complete/fail.
// { jobName: { lastRunAt, lastDurationMs, lastFailureAt, consecutiveFailures } }
const schedulerExecution = new Map();

const QUEUE_BY_LABEL = { cleanup: QUEUE_NAMES.CLEANUP, aggregation: QUEUE_NAMES.AGGREGATIONS };

function schedulerId(jobName) { return `sched:${jobName}`; }

function recordSweepStart(jobName) {
  const prev = schedulerExecution.get(jobName) || {};
  schedulerExecution.set(jobName, { ...prev, startedAt: Date.now() });
  console.log(`[Sweep] ${jobName} started`);
}

function recordSweepSuccess(jobName) {
  const prev = schedulerExecution.get(jobName) || {};
  const startedAt = prev.startedAt || Date.now();
  const durationMs = Date.now() - startedAt;
  schedulerExecution.set(jobName, {
    lastRunAt: Date.now(),
    lastDurationMs: durationMs,
    lastFailureAt: prev.lastFailureAt || null,
    consecutiveFailures: 0,
  });
  console.log(`[Sweep] ${jobName} done in ${durationMs}ms`);
}

function recordSweepFailure(jobName) {
  const prev = schedulerExecution.get(jobName) || {};
  schedulerExecution.set(jobName, {
    lastRunAt: prev.lastRunAt || null,
    lastDurationMs: prev.lastDurationMs || null,
    lastFailureAt: Date.now(),
    consecutiveFailures: (prev.consecutiveFailures || 0) + 1,
  });
}

/**
 * Register every schedule in Redis via idempotent upsertJobScheduler.
 * Returns per-job results (ok:/fail:) so the caller can verify.
 */
async function registerSchedules() {
  const results = [];
  for (const s of SCHEDULES) {
    const q = getQueue(QUEUE_BY_LABEL[s.queue]);
    try {
      await q.upsertJobScheduler(schedulerId(s.jobName), { every: s.everyMs }, {
        name: s.jobName,
        data: {},
        opts: {},
      });
      results.push(`ok:${s.jobName}`);
    } catch (e) {
      results.push(`fail:${s.jobName}:${e?.message || e}`);
    }
  }
  return results;
}

/**
 * Verify every expected scheduler exists in Redis.
 * @returns {{ registered: number, expected: number, missing: string[] }}
 */
async function verifySchedules() {
  const expected = new Set(SCHEDULES.map((s) => schedulerId(s.jobName)));
  const present = new Set();
  for (const label of Object.keys(QUEUE_BY_LABEL)) {
    const q = getQueue(QUEUE_BY_LABEL[label]);
    let schedulers = [];
    try {
      schedulers = await q.getJobSchedulers();
    } catch { /* Redis down — treat as missing */ }
    for (const j of schedulers) if (j && j.key) present.add(j.key);
  }
  const missing = [...expected].filter((k) => !present.has(k));
  return { registered: present.size, expected: expected.size, missing };
}

/**
 * Health used by /health + ops digest. Combines registration health with
 * EXECUTION health (a registered scheduler that silently stopped is the real
 * risk). Schedules whose last run is older than 2x cadence are flagged stale.
 */
async function getSchedulerHealth() {
  const out = { status: 'unknown', expected: SCHEDULES.length, registered: 0, missing: [], stale: [], lastVerifiedAt: null };
  try {
    const v = await verifySchedules();
    out.registered = v.registered;
    out.missing = v.missing;
    out.lastVerifiedAt = new Date().toISOString();
    out.status = v.missing.length === 0 ? 'healthy' : 'unhealthy';
    const now = Date.now();
    for (const s of SCHEDULES) {
      const ex = schedulerExecution.get(s.jobName);
      const lastRunAt = ex?.lastRunAt;
      if (!lastRunAt) continue; // never ran since process start — not yet stale
      const ageMs = now - lastRunAt;
      if (ageMs > s.everyMs * 2) {
        out.stale.push({
          jobName: s.jobName,
          cadence: s.everyMs,
          lastRunAt: new Date(lastRunAt).toISOString(),
          lastFailureAt: ex?.lastFailureAt ? new Date(ex.lastFailureAt).toISOString() : null,
          consecutiveFailures: ex?.consecutiveFailures || 0,
        });
      }
    }
    if (out.status === 'healthy' && out.stale.length > 0) out.status = 'degraded';
    return out;
  } catch {
    return out; // Redis unavailable → unknown
  }
}

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
 * Booking include used by every booking-scoped email job so workers never
 * re-fetch the same relations per send.
 */
const EMAIL_BOOKING_INCLUDE = {
  customer: { select: { id: true, name: true, email: true, phone: true } },
  tour: {
    select: {
      id: true,
      title: true,
      description: true,
      photos: true,
      productContent: true,
      bookingAndTickets: true,
      categorization: true,
      durationMinutes: true,
      supplier: { select: { id: true, name: true, email: true, phone: true } },
    },
  },
};

/**
 * Map a typed email job to its send function + the payload shape it accepts.
 * Each entry is [fnName, needsBooking] — jobs pass bookingId, the worker
 * fetches the booking (with relations) and forwards job.data as extras.
 */
const EMAIL_JOB_DISPATCH = {
  // customer
  'booking-confirmed': ['sendBookingConfirmedEmail', true],
  'reserve-later-confirmed': ['sendReserveLaterConfirmedEmail', true],
  'payment-reminder': ['sendPaymentReminderEmail', true],
  'payment-successful': ['sendPaymentSuccessfulEmail', true],
  'pay-later-charged': ['sendPayLaterChargedEmail', true],
  'awaiting-confirmation': ['sendAwaitingConfirmationEmail', true],
  'payment-unsuccessful': ['sendPaymentUnsuccessfulEmail', true],
  'customer-booking-changed': ['sendCustomerBookingChangedEmail', true],
  'pickup-details-updated': ['sendPickupDetailsUpdatedEmail', true],
  'pickup-location-required': ['sendPickupLocationRequiredEmail', true],
  'booking-reminder': ['sendBookingReminderEmail', true],
  'customer-cancelled-full-refund': ['sendCustomerCancelledFullRefundEmail', true],
  'customer-cancelled-no-refund': ['sendCustomerCancelledNoRefundEmail', true],
  'refund-processing': ['sendRefundProcessingEmail', true],
  'refund-completed': ['sendRefundCompletedEmail', true],
  'supplier-changed-booking': ['sendSupplierChangedBookingEmail', true],
  'supplier-cancelled-booking': ['sendSupplierCancelledBookingEmail', true],
  'review-request': ['sendReviewRequestEmail', true],
  // supplier
  'supplier-new-booking': ['sendSupplierNewBookingEmail', true],
  'supplier-pay-later-charged': ['sendSupplierPayLaterChargedEmail', true],
  'supplier-booking-changed': ['sendSupplierBookingChangedEmail', true],
  'supplier-customer-contact-updated': ['sendSupplierContactUpdatedEmail', true],
  'supplier-pickup-updated': ['sendSupplierPickupUpdatedEmail', true],
  'supplier-pickup-required': ['sendSupplierPickupRequiredEmail', true],
  'supplier-booking-reminder': ['sendSupplierBookingReminderEmail', true],
  'supplier-customer-cancelled-free': ['sendSupplierCustomerCancelledFreeEmail', true],
  'supplier-customer-cancelled-late': ['sendSupplierCustomerCancelledLateEmail', true],
  'supplier-platform-cancelled': ['sendSupplierPlatformCancelledEmail', true],
  'supplier-cancellation-recorded': ['sendSupplierCancellationRecordedEmail', true],
};

/**
 * Process an email job directly (used by both the worker and the fallback
 * when Redis/BullMQ is unavailable).  This mirrors the logic in the EMAIL
 * WORKER section below so there is a single source of truth.
 */
async function processEmailJob(job) {
  const prisma = require('./prismaClient');
  const emailService = require('./emailService');

  // ── New 28-template dispatch ──────────────────────────────────────────
  const dispatch = EMAIL_JOB_DISPATCH[job.type];
  if (dispatch) {
    const [fnName, needsBooking] = dispatch;
    let booking = null;
    if (needsBooking) {
      booking = await prisma.booking.findUnique({
        where: { id: job.bookingId },
        include: EMAIL_BOOKING_INCLUDE,
      });
      if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
    }
    // Merge brandName from job data so Ghana emails use "Travio Ghana" branding
    const emailData = { ...(job.data || {}) };
    if (job.brandName && !emailData.brandName) {
      emailData.brandName = job.brandName;
    }
    await emailService[fnName](booking, emailData);
    return;
  }

  // ── Payout emails need booking + payout payloads ──────────────────────
  if (job.type === 'supplier-payout-scheduled') {
    const booking = await prisma.booking.findUnique({ where: { id: job.bookingId }, include: EMAIL_BOOKING_INCLUDE });
    if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
    await emailService.sendSupplierPayoutScheduledEmail({ booking, ...(job.data || {}) });
    return;
  }
  if (job.type === 'supplier-payout-completed') {
    const booking = await prisma.booking.findUnique({ where: { id: job.bookingId }, include: EMAIL_BOOKING_INCLUDE });
    if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
    await emailService.sendSupplierPayoutCompletedEmail({ booking, ...(job.data || {}) });
    return;
  }
  if (job.type === 'supplier-payout-failed') {
    const booking = await prisma.booking.findUnique({ where: { id: job.bookingId }, include: EMAIL_BOOKING_INCLUDE });
    if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
    await emailService.sendSupplierPayoutFailedEmail({ booking, ...(job.data || {}) });
    return;
  }

  // ── Finance v2: payout request + dispute emails ───────────────────────
  if (['payout-request-submitted', 'payout-request-approved', 'payout-completed'].includes(job.type)) {
    const request = await prisma.payoutRequest.findUnique({
      where: { id: job.payoutRequestId },
      include: { supplier: { select: { name: true, email: true } } },
    });
    if (!request) throw new Error(`PayoutRequest ${job.payoutRequestId} not found`);
    await emailService.sendFinancePayoutRequestEmail(job.type, request);
    return;
  }
  if (job.type === 'dispute-opened') {
    const dispute = await prisma.dispute.findUnique({
      where: { id: job.disputeId },
      include: {
        supplier: { select: { name: true, email: true } },
        booking: { select: { bookingNumber: true, tour: { select: { title: true } } } },
      },
    });
    if (!dispute) throw new Error(`Dispute ${job.disputeId} not found`);
    await emailService.sendDisputeOpenedEmail(dispute);
    return;
  }

  switch (job.type) {
    case 'booking-confirmation': {
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
      await emailService.sendBookingConfirmationEmail(booking);
      break;
    }

    case 'booking-cancellation': {
      const booking = await prisma.booking.findUnique({
        where: { id: job.bookingId },
        include: EMAIL_BOOKING_INCLUDE,
      });
      if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
      await emailService.sendBookingCancellationEmail(booking, job.refundAmount);
      break;
    }

    case 'booking-auto-cancelled': {
      const booking = await prisma.booking.findUnique({
        where: { id: job.bookingId },
        include: EMAIL_BOOKING_INCLUDE,
      });
      if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
      await emailService.sendBookingCancellationEmail(booking, booking.refundAmount);
      break;
    }

    case 'supplier-booking-notification': {
      const booking = await prisma.booking.findUnique({
        where: { id: job.bookingId },
        include: EMAIL_BOOKING_INCLUDE,
      });
      if (!booking) throw new Error(`Booking ${job.bookingId} not found`);
      await emailService.sendSupplierBookingNotification(booking);
      break;
    }

    case 'supplier-status-email': {
      await emailService.sendSupplierStatusEmail(job.email, job.status, job.data || {});
      break;
    }

    default: {
      const { to, subject, template, data, attachments } = job;
      await emailService.sendEmail({ to, subject, template, data, attachments });
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

/**
 * Enqueue a homepage pre-computation job.
 * Debounced: only one pending job per 10-second window (via jobId).
 * Falls back to inline execution when Redis is unavailable.
 */
async function enqueueHomepagePrecompute() {
  try {
    await homepagePrecomputeQueue().add('precompute', {}, {
      jobId: `hp:precompute:${Math.floor(Date.now() / 10000)}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600, count: 10 },
      removeOnFail: { age: 3600 },
    });
  } catch {
    // Redis unavailable — run inline as fallback
    try {
      const { precomputeHomepageSections } = require('./homepagePrecompute');
      precomputeHomepageSections().catch(() => {});
    } catch { /* noop */ }
  }
}

/**
 * Enqueue an AI scoring job for a tour.
 * If Redis is unavailable, the tour stays PENDING in PostgreSQL.
 * A reconciliation process will re-enqueue when Redis recovers.
 */
async function enqueueAiScoring(tourId) {
  try {
    await aiScoringQueue().add('score-tour', { tourId }, {
      // No custom jobId — BullMQ rejects ':' in custom IDs (the previous
      // ai:score:<id>:<ts> form threw silently and jobs never landed; the
      // processor is idempotent so dedup is unnecessary).
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 24 * 3600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  } catch {
    // Redis unavailable — tour stays PENDING in DB
    // Reconciliation will pick it up when Redis recovers
  }
}

/**
 * Enqueue a TravioGhana auto-publish job for a tour.
 * Fire-and-forget (~1ms Redis add) — never blocks the tour create/update request.
 * No custom jobId (BullMQ forbids ':' in custom IDs); the worker is idempotent
 * (upsert), so duplicates/retries are harmless.
 * If Redis is unavailable, the periodic reconcileGhanaPublish sweep heals it.
 */
async function enqueueGhanaPublish(tourId, actorId) {
  try {
    await ghanaPublishQueue().add('publish-tour', { tourId, actorId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 24 * 3600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  } catch {
    // Redis unavailable — sweep will pick it up when Redis recovers
  }
}

/**
 * Enqueue a TravioAfrica auto-publish job for a tour.
 * Fire-and-forget — never blocks the tour create/update request.
 * The worker is idempotent (upsert), so duplicates/retries are harmless.
 */
async function enqueueTravioAfricaPublish(tourId, actorId) {
  try {
    await travioAfricaPublishQueue().add('publish-tour', { tourId, actorId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 24 * 3600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  } catch {
    // Redis unavailable — sweep will pick it up when Redis recovers
  }
}

/**
 * Enqueue AI scoring for all PENDING/FAILED tours (reconciliation).
 * Called periodically when Redis recovers from an outage.
 */
async function reconcilePendingAiJobs() {
  try {
    const prisma = require('./prismaClient');
    const pendingTours = await prisma.tour.findMany({
      where: {
        aiProcessingStatus: { in: ['PENDING', 'FAILED'] },
        status: 'ACTIVE',
        createdAt: { lt: new Date(Date.now() - 2 * 60 * 1000) }, // At least 2 min old
      },
      take: 50,
      select: { id: true },
    });

    for (const tour of pendingTours) {
      await enqueueAiScoring(tour.id);
    }

    if (pendingTours.length > 0) {
      console.log(`[Queue] Reconciled ${pendingTours.length} pending AI scoring jobs`);
    }
  } catch {
    // DB unavailable — will retry on next monitor cycle
  }
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
    const isScheduled = SCHEDULES.some((s) => s.jobName === job.name);
    if (isScheduled) recordSweepStart(job.name);
    try {
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
      case 'aggregate-daily-views': {
        const prismaAgg = require('./prismaClient');
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);
        const today = new Date(yesterday);
        today.setDate(today.getDate() + 1);

        // Query tour.viewed events from yesterday, grouped by tour
        const events = await prismaAgg.event.findMany({
          where: {
            name: 'tour.viewed',
            createdAt: { gte: yesterday, lt: today },
            resourceId: { not: null },
          },
          select: { resourceId: true, userId: true, properties: true },
        });

        // Group by tour
        const byTour = {};
        for (const ev of events) {
          const tourId = ev.resourceId;
          if (!byTour[tourId]) byTour[tourId] = { views: 0, users: new Set(), countries: {} };
          byTour[tourId].views++;
          if (ev.userId) byTour[tourId].users.add(ev.userId);
          const country = ev.properties?.viewerCountry || ev.properties?.country;
          if (country) byTour[tourId].countries[country] = (byTour[tourId].countries[country] || 0) + 1;
        }

        // Upsert daily stats
        for (const [tourId, data] of Object.entries(byTour)) {
          const topCountry = Object.entries(data.countries).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
          await prismaAgg.dailyTourStats.upsert({
            where: { tourId_date: { tourId, date: yesterday } },
            update: {
              totalViews: data.views,
              uniqueVisitors: data.users.size,
              topCountry,
            },
            create: {
              tourId,
              date: yesterday,
              totalViews: data.views,
              uniqueVisitors: data.users.size,
              topCountry,
            },
          });
        }
        break;
      }
      default:
        console.log('[Queue] Unknown aggregation job:', job.name);
    }
      if (isScheduled) recordSweepSuccess(job.name);
    } catch (err) {
      if (isScheduled) recordSweepFailure(job.name);
      throw err; // let BullMQ retry
    }
  });

  /* ------------------------------------------------------------------
   * CLEANUP WORKER
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.CLEANUP, async (job) => {
    const isScheduled = SCHEDULES.some((s) => s.jobName === job.name);
    if (isScheduled) recordSweepStart(job.name);
    try {
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
        case 'auto-complete-bookings': {
          const { autoCompleteBookings } = require('./bookingCleanup');
          await autoCompleteBookings();
          break;
        }
        case 'cancel-stale-pending-bookings': {
          const { cancelStalePendingAfterTravelDate } = require('./bookingCleanup');
          await cancelStalePendingAfterTravelDate();
          break;
        }
        case 'expire-checkout-holds': {
          const { expireCheckoutHolds } = require('./bookingCleanup');
          await expireCheckoutHolds();
          break;
        }
        case 'earnings-eligibility-sweep': {
          const { sweepEarningsEligibility } = require('./payoutCycles');
          await sweepEarningsEligibility();
          break;
        }
        case 'charge-pay-later-bookings': {
          const { chargePayLaterBookings } = require('./payLaterSweep');
          await chargePayLaterBookings();
          break;
        }
        case 'plan-booking-reminders': {
          const { planBookingReminders } = require('./bookingReminders');
          await planBookingReminders();
          break;
        }
        case 'dispatch-booking-reminders': {
          const { dispatchDueReminders } = require('./bookingReminders');
          await dispatchDueReminders();
          break;
        }
        case 'reconcile-ghana': {
          const { reconcileGhanaPublish } = require('./autoPublishGhana');
          await reconcileGhanaPublish();
          break;
        }
        case 'reconcile-travioafrica': {
          const { reconcileTravioAfricaPublish } = require('./autoPublishTravioAfrica');
          await reconcileTravioAfricaPublish();
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
      case 'purge-archived-tours': {
        const { purgeArchivedTours } = require('./tourPurge');
        await purgeArchivedTours();
        break;
      }
      case 'expire-special-offers': {
        const prisma = require('./prismaClient');
        const expired = await prisma.specialOffer.findMany({
          where: { isActive: true, endDate: { lte: new Date() } },
          select: { id: true, name: true, supplierId: true, endDate: true },
        });
        if (expired.length === 0) break;
        const result = await prisma.specialOffer.updateMany({
          where: { id: { in: expired.map((o) => o.id) } },
          data: { isActive: false },
        });
        const event = require('./eventEmitter');
        for (const offer of expired) {
          event.emit({
            name: 'offer.expired',
            userId: offer.supplierId,
            resource: 'SpecialOffer',
            resourceId: offer.id,
            properties: { offerName: offer.name, endedAt: offer.endDate },
            source: 'system',
          });
        }
        console.log(`[Queue] Expired ${result.count} special offers`);
        break;
      }
      case 'expire-supplier-documents': {
        const { expireExpiredDocuments } = require('./documentExpiry');
        const { expiredDocuments } = await expireExpiredDocuments();
        if (expiredDocuments > 0) console.log(`[Queue] Expired ${expiredDocuments} supplier documents`);
        break;
      }
      case 'plan-doc-expiry-reminders': {
        const { planDocumentExpiryReminders } = require('./documentExpiry');
        await planDocumentExpiryReminders();
        break;
      }
      default:
        console.log('[Queue] Unknown cleanup job:', job.name);
    }
      if (isScheduled) recordSweepSuccess(job.name);
    } catch (err) {
      if (isScheduled) recordSweepFailure(job.name);
      throw err; // let BullMQ retry
    }
  });

  /* ------------------------------------------------------------------
   * HOMEPAGE PRECOMPUTE WORKER (concurrency 1)
   * Pre-computes all 8 homepage ranking sections and stores in Redis.
   * Concurrency=1 prevents redundant parallel precomputation.
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.HOMEPAGE_PRECOMPUTE, async () => {
    const { precomputeHomepageSections } = require('./homepagePrecompute');
    await precomputeHomepageSections();
  }, 1);

  /* ------------------------------------------------------------------
   * AI SCORING WORKER (concurrency 2)
   * Processes MiMo image analysis and tour classification.
   * Concurrency=2 respects MiMo's 100 RPM rate limit.
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.AI_SCORING, async (job) => {
    const { processTourAI } = require('./aiContentAnalyzer');
    const { tourId } = job.data;
    await processTourAI(tourId);
  }, 2);

  /* ------------------------------------------------------------------
   * GHANA PUBLISH WORKER (concurrency 5)
   * Auto-publishes Ghana-based suppliers' tours to the TravioGhana
   * storefront (TravioGhanaTour upsert) and maintains the 'ghana' role.
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.GHANA_PUBLISH, async (job) => {
    const { publishTourToGhana } = require('./autoPublishGhana');
    const { tourId, actorId } = job.data;
    await publishTourToGhana(tourId, actorId);
  }, 5);

  /* ------------------------------------------------------------------
   * TRAVIOAFRICA PUBLISH WORKER (concurrency 5)
   * Auto-publishes non-Ghana African suppliers' tours to TravioAfrica
   * storefront (TravioAfricaTour upsert) and maintains the 'travioafrica' role.
   * ------------------------------------------------------------------ */
  createWorker(QUEUE_NAMES.TRAVIO_AFRICA_PUBLISH, async (job) => {
    const { publishTourToAfrica } = require('./autoPublishTravioAfrica');
    const { tourId, actorId } = job.data;
    await publishTourToAfrica(tourId, actorId);
  }, 5);

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
          // Ensure every expected Job Scheduler exists after recovery (idempotent).
          await registerSchedules();
          const verify = await verifySchedules();
          if (verify.missing.length > 0) {
            console.error(`[SCHEDULER_HEALTH] CRITICAL Missing schedulers after recovery: ${verify.missing.join(', ')}`);
          } else {
            console.log(`[Queue] Schedulers verified (${verify.registered}/${verify.expected})`);
          }
          // Reconcile any AI scoring jobs that were pending during Redis outage
          reconcilePendingAiJobs().catch(() => {});
          // NOTE: Ghana/TravioAfrica publish reconciles are now BullMQ
          // scheduled jobs (reconcile-ghana / reconcile-travioafrica) and are
          // re-registered above — no inline duplicate execution here.
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
  SCHEDULES,
  enqueueEmail,
  enqueueNotification,
  enqueueEvent,
  enqueueAggregation,
  enqueueCleanup,
  enqueueCreateStripeCustomer,
  enqueueWebhookRetry,
  enqueueContentSync,
  enqueueHomepagePrecompute,
  enqueueAiScoring,
  enqueueGhanaPublish,
  enqueueTravioAfricaPublish,
  processEmailJob,
  registerWorkers,
  registerSchedules,
  verifySchedules,
  getSchedulerHealth,
  startResumeMonitor,
  closeAll,
  getConnection,
  isRedisAvailable,
  probe,
};
