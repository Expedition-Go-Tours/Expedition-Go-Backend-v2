const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const logger = require('../utils/logger');
const { syncExternalReviewStats } = require('../utils/externalReviewStats');

/**
 * Machine-to-machine endpoint for the daily external-reviews scraper.
 *
 * Accepts the scraper's product list (official TripAdvisor / GetYourGuide
 * totals), matches each product to a tour, stores the aggregate and refreshes
 * the homepage cache. Authenticated by middleware/serviceToken, not by an
 * admin session — the caller is a GitHub Action, not a person.
 */
exports.syncExternalReviews = catchAsync(async (req, res) => {
  const payload = req.body || {};

  if (!Array.isArray(payload.products)) {
    throw new AppError('Request body must include a "products" array', 400);
  }

  const summary = await syncExternalReviewStats(payload);

  logger.info(
    `[ExternalReviews] sync${summary.dryRun ? ' (dry-run)' : ''} ` +
      `matched=${summary.matched} tours=${summary.tours} ` +
      `sources=${(summary.sources || []).join(',') || 'none'} ` +
      `unmatched=${summary.unmatched ? summary.unmatched.length : 0}`
  );

  res.status(200).json({ status: 'success', data: summary });
});
