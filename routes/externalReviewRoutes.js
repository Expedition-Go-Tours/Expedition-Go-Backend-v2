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