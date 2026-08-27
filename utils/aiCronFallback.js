/**
 * AI Cron Fallback Scheduler
 *
 * Safety-net scheduler that processes PENDING/FAILED tours directly via
 * processTourAI(), bypassing BullMQ entirely. Runs on a timer regardless
 * of Redis availability.
 *
 * Design:
 *  - Every 5 minutes, picks up to MAX_TOURS_PER_CYCLE PENDING tours
 *  - Rate-limits MiMo calls (DELAY_BETWEEN_MS between each)
 *  - Logs failures for visibility
 *  - Idempotent: already-COMPLETED images are skipped by processTourAI
 */

const logger = require('./logger');
const prisma = require('./prismaClient');

const INTERVAL_MS = 5 * 60 * 1000;       // 5 minutes
const MAX_TOURS_PER_CYCLE = 10;           // prevent MiMo API stampede
const DELAY_BETWEEN_MS = 2000;            // 2s between MiMo calls (≤30 RPM)
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // tours must be ≥2 min old

let cronInterval = null;
let isProcessing = false;

/**
 * Process a single tour with error isolation.
 * Returns { tourId, success, error?, duration? }
 */
async function processOneTour(tourId) {
  const start = Date.now();
  try {
    const { processTourAI } = require('./aiContentAnalyzer');
    await processTourAI(tourId);
    return { tourId, success: true, duration: Date.now() - start };
  } catch (err) {
    logger.error(`[AI Cron] Failed to process tour ${tourId}`, {
      error: err.message,
      duration: Date.now() - start,
    });
    return { tourId, success: false, error: err.message, duration: Date.now() - start };
  }
}

/**
 * Sleep helper for rate limiting.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main cron tick — picks up PENDING/FAILED tours and processes them directly.
 */
async function cronTick() {
  if (isProcessing) {
    logger.warn('[AI Cron] Previous cycle still running, skipping');
    return;
  }

  isProcessing = true;
  const cycleStart = Date.now();

  try {
    // Find tours that need processing
    const pendingTours = await prisma.tour.findMany({
      where: {
        aiProcessingStatus: { in: ['PENDING', 'FAILED'] },
        status: 'ACTIVE',
        createdAt: { lt: new Date(Date.now() - STALE_THRESHOLD_MS) },
      },
      take: MAX_TOURS_PER_CYCLE,
      select: { id: true, title: true },
      orderBy: { createdAt: 'asc' },
    });

    if (pendingTours.length === 0) {
      isProcessing = false;
      return; // nothing to do
    }

    logger.info(`[AI Cron] Processing ${pendingTours.length} tour(s)`);

    const results = [];

    for (const tour of pendingTours) {
      const result = await processOneTour(tour.id);
      results.push({ ...result, title: tour.title });

      // Rate limit: wait between MiMo calls
      if (pendingTours.indexOf(tour) < pendingTours.length - 1) {
        await sleep(DELAY_BETWEEN_MS);
      }
    }

    // Summary log
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const totalDuration = Date.now() - cycleStart;

    if (failed > 0) {
      logger.warn(`[AI Cron] Cycle complete: ${succeeded} ok, ${failed} failed (${totalDuration}ms)`);
      for (const r of results.filter((r) => !r.success)) {
        logger.warn(`[AI Cron]   Failed: ${r.title} (${r.tourId}) — ${r.error}`);
      }
    } else {
      logger.info(`[AI Cron] Cycle complete: ${succeeded} ok (${totalDuration}ms)`);
    }
  } catch (err) {
    logger.error('[AI Cron] Cycle failed', { error: err.message });
  } finally {
    isProcessing = false;
  }
}

/**
 * Start the cron fallback scheduler.
 * Called from server.js during startup — runs independently of Redis.
 */
function startAiCronFallback() {
  if (cronInterval) return; // already running

  // Run first tick after 30 seconds (give server time to fully start)
  setTimeout(() => {
    cronTick().catch(() => {});
  }, 30_000);

  // Then every INTERVAL_MS
  cronInterval = setInterval(() => {
    cronTick().catch(() => {});
  }, INTERVAL_MS);

  // Don't keep process alive just for the cron
  if (cronInterval.unref) cronInterval.unref();

  logger.info('[AI Cron] Fallback scheduler started (every 5 minutes)');
}

/**
 * Stop the cron fallback scheduler.
 */
function stopAiCronFallback() {
  if (cronInterval) {
    clearInterval(cronInterval);
    cronInterval = null;
    logger.info('[AI Cron] Fallback scheduler stopped');
  }
}

/**
 * Get current cron status (for admin endpoint).
 */
function getAiCronStatus() {
  return {
    running: cronInterval !== null,
    processing: isProcessing,
    config: {
      intervalMs: INTERVAL_MS,
      maxToursPerCycle: MAX_TOURS_PER_CYCLE,
      delayBetweenMs: DELAY_BETWEEN_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
    },
  };
}

module.exports = {
  startAiCronFallback,
  stopAiCronFallback,
  getAiCronStatus,
  cronTick, // exported for manual trigger / testing
};
