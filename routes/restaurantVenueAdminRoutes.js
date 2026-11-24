/**
 * Admin surface for restaurant reviews.
 *
 * Mounted at `/admin/restaurant-venues` ahead of the general admin router in
 * `apps/platform-api/app.js`. The generic router applies a global `protect`,
 * so mounting this later would put two auth stacks on the same requests and
 * hide these paths behind a catch-all.
 *
 * Permissions are borrowed from the tour review surface: an admin who can
 * moderate a tour review can moderate a restaurant review. Adding a separate
 * permission key would leave existing admin roles unable to clear the queue.
 */

const express = require('express');
const validate = require('../middleware/validate');
const { createUserLimiter } = require('../middleware/dynamicRateLimiter');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const controller = require('../src/core/domain/restaurantVenueController');
const {
  moderateReviewSchema,
  pendingReviewsQuerySchema,
  resolveReportSchema,
  createInviteSchema,
  pendingClaimsQuerySchema,
  resolveClaimSchema,
} = require('../src/core/services/restaurantVenueSchemas');

const router = express.Router();

// Invites are credentials. Cap how many one admin can mint in an hour even
// though they are only issued to admins.
const inviteLimiter = createUserLimiter({
  name: 'restaurant-review-invites',
  defaultMax: 50,
  defaultWindowMs: 60 * 60 * 1000,
  message: {
    status: 'fail',
    message: 'Too many review invites issued, please slow down.',
  },
});

router.use(protect, restrictTo('admin'));

router.get(
  '/reviews/pending',
  requirePermission('reviews.view'),
  validate(pendingReviewsQuerySchema),
  controller.listPendingReviews,
);

router.patch(
  '/reviews/:reviewId/moderate',
  requirePermission('reviews.moderate'),
  validate(moderateReviewSchema),
  controller.moderateReview,
);

router.patch(
  '/reports/:reportId',
  requirePermission('reviews.moderate'),
  validate(resolveReportSchema),
  controller.resolveReport,
);

router.post(
  '/:slugOrId/review-invites',
  inviteLimiter,
  requirePermission('reviews.moderate'),
  validate(createInviteSchema),
  controller.createInvite,
);

router.get(
  '/claims/pending',
  requirePermission('reviews.view'),
  validate(pendingClaimsQuerySchema),
  controller.listPendingClaims,
);

router.patch(
  '/claims/:claimId',
  requirePermission('reviews.moderate'),
  validate(resolveClaimSchema),
  controller.resolveClaim,
);

module.exports = router;
