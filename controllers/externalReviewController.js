/**
 * External Review Controller
 *
 * API endpoints for managing external reviews (crawled from review platforms).
 *
 * @module controllers/externalReviewController
 */

const crypto = require('crypto');
const prisma = require('../utils/prismaClient');
const cache = require('../utils/cacheHelper');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const logger = require('../utils/logger');
const { syncTourReviews, runWeeklyReviewSync, detectPlatform, SYNC_CACHE_TTL } = require('../utils/externalReviewCrawler');

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

// ─── Scraper Pipeline (GitHub Actions) ──────────────────────────────

/**
 * Normalize a review-platform URL for matching.
 * Drops the query string, trailing slash and fragment so
 * ".../tour-t123/?ranking_uuid=abc" and ".../tour-t123/" match.
 */
function normalizeUrl(u) {
  if (!u) return '';
  try {
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return String(u).split('?')[0].replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * GET /external-reviews/pending-urls
 *
 * Returns every external review URL configured across all tours, with the
 * tour it belongs to. The GitHub Actions scraper (clean IPs) reads this list,
 * scrapes each URL, and posts the results back to /external-reviews/ingest.
 *
 * API-key protected (scraper secret), not user auth.
 */
exports.getPendingUrls = catchAsync(async (req, res) => {
  const tours = await prisma.tour.findMany({
    where: { externalReviewUrls: { not: null } },
    select: { id: true, title: true, externalReviewUrls: true },
  });

  const urls = [];
  for (const tour of tours) {
    if (!Array.isArray(tour.externalReviewUrls)) continue;
    for (const entry of tour.externalReviewUrls) {
      if (entry?.url) {
        urls.push({ tourId: tour.id, tourTitle: tour.title, platform: entry.platform || null, url: entry.url });
      }
    }
  }

  res.status(200).json({ status: 'success', data: { urls, count: urls.length } });
});

/**
 * POST /external-reviews/ingest
 *
 * Accepts scraped reviews from the GitHub Actions scraper and stores them
 * against the tour whose externalReviewUrls contains a matching URL.
 *
 * Body: { reviews: [{ url, source, reviewerName, rating, title, text, date, externalId }] }
 * API-key protected (scraper secret).
 */
exports.ingestReviews = catchAsync(async (req, res) => {
  const incoming = Array.isArray(req.body?.reviews) ? req.body.reviews : [];
  if (incoming.length === 0) {
    return res.status(200).json({ status: 'success', data: { imported: 0, skipped: 0, unmatched: 0 } });
  }

  // Build a URL → tourId map from every tour's configured URLs
  const tours = await prisma.tour.findMany({
    where: { externalReviewUrls: { not: null } },
    select: { id: true, externalReviewUrls: true },
  });

  const urlToTour = new Map();
  for (const tour of tours) {
    if (!Array.isArray(tour.externalReviewUrls)) continue;
    for (const entry of tour.externalReviewUrls) {
      if (entry?.url) urlToTour.set(normalizeUrl(entry.url), tour.id);
    }
  }

  let imported = 0;
  let skipped = 0;
  let unmatched = 0;
  const touchedTours = new Set();

  for (const r of incoming) {
    const tourId = urlToTour.get(normalizeUrl(r.url || r.tourUrl));
    if (!tourId) { unmatched++; continue; }

    const rating = Number(r.rating);
    if (isNaN(rating) || rating < 4) { skipped++; continue; }

    const platform = r.source ? String(r.source).toLowerCase() : detectPlatform(r.url || '');
    const externalId = r.externalId
      || `${platform}-${crypto.createHash('md5').update(`${r.reviewerName || ''}${(r.text || '').slice(0, 100)}`).digest('hex').slice(0, 12)}`;

    const reviewDate = r.date ? new Date(r.date) : null;
    const safeDate = reviewDate && !isNaN(reviewDate.getTime()) && reviewDate <= new Date() ? reviewDate : null;

    try {
      await prisma.externalReview.upsert({
        where: { tourId_platform_externalId: { tourId, platform, externalId } },
        create: {
          tourId,
          platform,
          platformUrl: r.url || r.tourUrl || '',
          externalId,
          authorName: r.reviewerName ? String(r.reviewerName).slice(0, 200) : null,
          authorPhoto: r.reviewerAvatar || null,
          rating: Math.min(5, Math.max(1, rating)),
          title: r.title ? String(r.title).slice(0, 500) : null,
          text: r.text ? String(r.text).slice(0, 5000) : null,
          reviewDate: safeDate,
        },
        update: {
          authorName: r.reviewerName ? String(r.reviewerName).slice(0, 200) : null,
          authorPhoto: r.reviewerAvatar || null,
          rating: Math.min(5, Math.max(1, rating)),
          title: r.title ? String(r.title).slice(0, 500) : null,
          text: r.text ? String(r.text).slice(0, 5000) : null,
          reviewDate: safeDate,
          importedAt: new Date(),
        },
      });
      imported++;
      touchedTours.add(tourId);
    } catch (err) {
      if (err.code === 'P2002') skipped++;
      else { skipped++; logger.error('[ExternalReview] Ingest upsert failed:', err.message); }
    }
  }

  for (const tourId of touchedTours) {
    try { cache.invalidateReviewCaches(tourId); } catch (_) { /* ignore */ }
  }

  res.status(200).json({
    status: 'success',
    data: { imported, skipped, unmatched, toursTouched: touchedTours.size, total: incoming.length },
  });
});
