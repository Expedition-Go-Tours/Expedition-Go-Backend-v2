/**
 * Admin AI Controller — Visibility into MiMo AI processing.
 *
 * GET /admin/ai/status    — overall processing stats
 * GET /admin/ai/failed    — list of failed tours with error details
 * POST /admin/ai/retry    — manually retry specific failed tours
 */

const catchAsync = require('../utils/catchAsync');
const prisma = require('../utils/prismaClient');
const { getAiCronStatus } = require('../utils/aiCronFallback');

/**
 * GET /admin/ai/status
 * Returns a snapshot of AI processing health.
 */
exports.getAiStatus = catchAsync(async (_req, res) => {
  // Tour processing distribution
  const statusCounts = await prisma.$queryRaw`
    SELECT "aiProcessingStatus", COUNT(*)::int AS count
    FROM "Tour"
    WHERE status = 'ACTIVE'
    GROUP BY "aiProcessingStatus"
  `;

  const tourStats = {
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };
  for (const row of statusCounts) {
    tourStats.total += row.count;
    const key = row.aiProcessingStatus.toLowerCase();
    if (key in tourStats) tourStats[key] = row.count;
  }

  // Image analysis stats
  const imageStats = await prisma.tourImageAnalysis.groupBy({
    by: ['aiStatus'],
    _count: { id: true },
  });

  const imageAnalysis = {
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };
  for (const row of imageStats) {
    imageAnalysis.total += row._count.id;
    const key = row.aiStatus.toLowerCase();
    if (key in imageAnalysis) imageAnalysis[key] = row._count.id;
  }

  // Attraction entity stats
  const attractionStats = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "heroImage" IS NOT NULL)::int AS with_hero_image,
      COUNT(*) FILTER (WHERE "heroImageSource" = 'ai_selected')::int AS ai_selected,
      COUNT(*) FILTER (WHERE "heroImageSource" = 'fallback')::int AS fallback_image,
      COUNT(*) FILTER (WHERE "manualOverride" = true)::int AS manual_override
    FROM "Attraction"
  `;

  // Cron fallback status
  const cronStatus = getAiCronStatus();

  // Last processing time
  const lastProcessed = await prisma.tour.findFirst({
    where: { aiProcessingStatus: 'COMPLETED' },
    orderBy: { aiScoredAt: 'desc' },
    select: { aiScoredAt: true, title: true },
  });

  res.json({
    status: 'success',
    data: {
      tours: tourStats,
      imageAnalysis,
      attractions: attractionStats[0] || {},
      cron: cronStatus,
      lastProcessed: lastProcessed
        ? { title: lastProcessed.title, at: lastProcessed.aiScoredAt }
        : null,
    },
  });
});

/**
 * GET /admin/ai/failed
 * List tours with FAILED aiProcessingStatus.
 */
exports.getFailedTours = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const tours = await prisma.tour.findMany({
    where: {
      aiProcessingStatus: 'FAILED',
      status: 'ACTIVE',
    },
    select: {
      id: true,
      title: true,
      category: true,
      city: true,
      createdAt: true,
      aiScoredAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // Also get image analysis failures
  const failedImages = await prisma.tourImageAnalysis.findMany({
    where: { aiStatus: 'FAILED' },
    select: {
      id: true,
      tourId: true,
      imageUrl: true,
      aiRetryCount: true,
      aiDescription: true,
    },
    orderBy: { aiRetryCount: 'desc' },
    take: 50,
  });

  res.json({
    status: 'success',
    data: {
      tours,
      failedImages,
      tourCount: tours.length,
      imageCount: failedImages.length,
    },
  });
});

/**
 * POST /admin/ai/retry
 * Manually retry AI processing for specific tours or all failed tours.
 * Body: { tourIds?: string[] } — if empty, retries all FAILED tours
 */
exports.retryFailed = catchAsync(async (req, res) => {
  const { enqueueAiScoring } = require('../utils/queue');
  const { tourIds } = req.body || {};

  let tours;
  if (tourIds && tourIds.length > 0) {
    // Retry specific tours
    tours = await prisma.tour.findMany({
      where: {
        id: { in: tourIds },
        aiProcessingStatus: { in: ['FAILED', 'PENDING'] },
      },
      select: { id: true, title: true },
    });
  } else {
    // Retry all failed tours
    tours = await prisma.tour.findMany({
      where: {
        aiProcessingStatus: 'FAILED',
        status: 'ACTIVE',
      },
      select: { id: true, title: true },
      take: 50, // safety cap
    });
  }

  if (tours.length === 0) {
    return res.json({
      status: 'success',
      data: { message: 'No failed tours to retry', enqueued: 0 },
    });
  }

  let enqueued = 0;
  for (const tour of tours) {
    try {
      // Reset status so cron/worker picks it up
      await prisma.tour.update({
        where: { id: tour.id },
        data: { aiProcessingStatus: 'PENDING' },
      });
      await enqueueAiScoring(tour.id);
      enqueued++;
    } catch {
      // If enqueue fails (Redis down), cron will pick it up
      enqueued++; // still counts as "queued" (via cron)
    }
  }

  res.json({
    status: 'success',
    data: {
      message: `Retrying ${enqueued} tour(s)`,
      enqueued,
      tours: tours.map((t) => ({ id: t.id, title: t.title })),
    },
  });
});
