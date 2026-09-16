/**
 * External Review Routes
 *
 * Supplier endpoints for managing external reviews (crawled from review platforms).
 * Public endpoint for storefront display.
 *
 * @module routes/externalReviewRoutes
 */

const router = require('express').Router();
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const ctrl = require('../controllers/externalReviewController');

// ─── Scraper pipeline (API-key auth) ────────────────────────────────
//
// The GitHub Actions scraper runs from clean IPs (the datacenter IP of this
// server is blocked by TripAdvisor/GetYourGuide). It reads the pending URL
// list here, scrapes, and posts results back. Authenticated with a shared
// secret header instead of a user JWT.

function requireScraperKey(req, res, next) {
  const secret = process.env.REVIEW_SCRAPER_KEY;
  const provided = req.headers['x-scraper-key'];
  if (!secret || !provided || provided !== secret) {
    return res.status(401).json({ status: 'fail', message: 'Invalid scraper key' });
  }
  next();
}

router.get('/external-reviews/pending-urls', requireScraperKey, ctrl.getPendingUrls);
router.post('/external-reviews/ingest', requireScraperKey, ctrl.ingestReviews);

// ─── Public (no auth) ───────────────────────────────────────────────

// Storefront: get external reviews for display (4+ stars only)
router.get('/tours/:id/external-reviews/public', ctrl.getExternalReviews);

// ─── Supplier (authenticated) ───────────────────────────────────────

router.use(protect);

// Trigger sync for a tour's external review URLs
router.post(
  '/tours/:id/external-reviews/sync',
  restrictTo('supplier'),
  resolveSupplier,
  requireTeamPermission('reviews.view'),
  ctrl.syncReviews
);

// List external reviews for a tour (supplier view)
router.get(
  '/tours/:id/external-reviews',
  restrictTo('supplier'),
  resolveSupplier,
  requireTeamPermission('reviews.view'),
  ctrl.listReviews
);

// Soft-delete an external review
router.delete(
  '/tours/:id/external-reviews/:reviewId',
  restrictTo('supplier'),
  resolveSupplier,
  requireTeamPermission('reviews.manage'),
  ctrl.deleteReview
);

// ─── Admin ──────────────────────────────────────────────────────────

// Manual bulk sync (all tours with external review URLs)
router.post(
  '/external-reviews/sync-all',
  restrictTo('admin'),
  ctrl.syncAllReviews
);

module.exports = router;