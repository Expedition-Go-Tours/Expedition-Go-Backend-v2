/**
 * External Review Controller
 *
 * API endpoints for managing external reviews (crawled from review platforms).
 *
 * @module controllers/externalReviewController
 */

const prisma = require('../utils/prismaClient');
const cache = require('../utils/cacheHelper');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { syncTourReviews, runWeeklyReviewSync, SYNC_CACHE_TTL } = require('../utils/externalReviewCrawler');

// ─── Sync Reviews for a Tour ────────────────────────────────────────

/**
 * POST /tours/:id/external-reviews/sync
 *
 * Triggers a crawl for all external review URLs on the tour.
 * Only imports reviews with 4+ star ratings.
 */
exports.syncReviews = catchAsync(async (req, res) => {
  const { id } = req.params;

  // Verify tour belongs to the authenticated supplier
  const tour = await prisma.tour.findFirst({
    where: {
      id,
      supplierId: req.user.id,
    },
    select: { id: true, externalReviewUrls: true },
  });

  if (!tour) {
    throw new AppError('Tour not found or you do not have permission', 404);
  }

  if (!tour.externalReviewUrls || !Array.isArray(tour.externalReviewUrls) || tour.externalReviewUrls.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: { imported: 0, skipped: 0, errors: ['No external review URLs configured'], total: 0 },
    });
  }

  const result = await syncTourReviews(tour.id);

  // Invalidate review caches
  try {
    cache.invalidateReviewCaches(tour.id);
  } catch (_) { /* ignore */ }

  res.status(200).json({
    status: 'success',
    data: result,
  });
});

// ─── List External Reviews ──────────────────────────────────────────

/**
 * GET /tours/:id/external-reviews
 *
 * Returns all displayed external reviews for a tour (supplier endpoint).
 */
exports.listReviews = catchAsync(async (req, res) => {
  const { id } = req.params;

  // Verify tour belongs to the authenticated supplier
  const tour = await prisma.tour.findFirst({
    where: {
      id,
      supplierId: req.user.id,
    },
    select: { id: true },
  });

  if (!tour) {
    throw new AppError('Tour not found or you do not have permission', 404);
  }

  const cacheKey = `reviews:external:${id}`;
  const result = await cache.getOrSet(cacheKey, async () => {
    const reviews = await prisma.externalReview.findMany({
      where: {
        tourId: id,
        displayed: true,
      },
      orderBy: { reviewDate: 'desc' },
    });

    return {
      status: 'success',
      data: reviews,
    };
  }, SYNC_CACHE_TTL);

  res.status(200).json(result);
});

// ─── Delete External Review ─────────────────────────────────────────

/**
 * DELETE /tours/:id/external-reviews/:reviewId
 *
 * Soft-deletes an external review by setting displayed=false.
 */
exports.deleteReview = catchAsync(async (req, res) => {
  const { id, reviewId } = req.params;

  // Verify tour belongs to the authenticated supplier
  const tour = await prisma.tour.findFirst({
    where: {
      id,
      supplierId: req.user.id,
    },
    select: { id: true },
  });

  if (!tour) {
    throw new AppError('Tour not found or you do not have permission', 404);
  }

  // Verify review belongs to this tour
  const review = await prisma.externalReview.findFirst({
    where: {
      id: reviewId,
      tourId: id,
    },
  });

  if (!review) {
    throw new AppError('Review not found', 404);
  }

  // Soft delete (set displayed=false)
  await prisma.externalReview.update({
    where: { id: reviewId },
    data: { displayed: false },
  });

  // Invalidate caches
  try {
    cache.invalidateReviewCaches(id);
  } catch (_) { /* ignore */ }

  res.status(200).json({
    status: 'success',
    message: 'Review removed',
  });
});

// ─── Public Endpoint (Storefront) ───────────────────────────────────

/**
 * GET /tours/:id/external-reviews/public
 *
 * Returns displayed external reviews with 4+ ratings for the storefront.
 * No authentication required.
 */
exports.getExternalReviews = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { page = 1, limit = 50 } = req.query;
  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 100);

  const cacheKey = `reviews:external:public:${id}:${page}:${limit}`;
  const result = await cache.getOrSet(cacheKey, async () => {
    const [reviews, totalCount] = await Promise.all([
      prisma.externalReview.findMany({
        where: {
          tourId: id,
          displayed: true,
          rating: { gte: 4 },
        },
        orderBy: { reviewDate: 'desc' },
        skip,
        take: Math.min(parseInt(limit), 100),
      }),
      prisma.externalReview.count({
        where: {
          tourId: id,
          displayed: true,
          rating: { gte: 4 },
        },
      }),
    ]);

    // Calculate rating distribution for external reviews
    const ratingDistribution = await prisma.externalReview.groupBy({
      by: ['rating'],
      where: {
        tourId: id,
        displayed: true,
        rating: { gte: 4 },
      },
      _count: true,
      orderBy: { rating: 'desc' },
    });

    return {
      status: 'success',
      data: {
        reviews,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / Math.min(parseInt(limit), 100)),
          totalCount,
          limit: Math.min(parseInt(limit), 100),
        },
        ratingDistribution,
      },
    };
  }, SYNC_CACHE_TTL);

  res.status(200).json(result);
});

// ─── Admin: Manual Bulk Sync ────────────────────────────────────────

/**
 * POST /external-reviews/sync-all
 *
 * Triggers a full sync for all tours with external review URLs.
 * Admin only.
 */
exports.syncAllReviews = catchAsync(async (req, res) => {
  const result = await runWeeklyReviewSync();

  res.status(200).json({
    status: 'success',
    data: result,
  });
});
