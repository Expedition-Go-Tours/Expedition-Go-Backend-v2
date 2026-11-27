/**
 * Restaurant venue routes.
 *
 * Mounted at `/api/restaurant-venues` (and the canonical `/api/v1` alias via
 * the shared prefix loop). Reads need no auth: browsing restaurants is a
 * public storefront surface. Every write below brings its own `protect` and a
 * per-user limiter mounted after it, so an abused account is bounded without
 * throttling everyone behind the same office IP.
 */

const express = require('express');
const validate = require('../middleware/validate');
const { uploadReviewPhotos, uploadVenuePhotos } = require('../middleware/uploadMiddleware');
const { createUserLimiter } = require('../middleware/dynamicRateLimiter');
const { protect, optionalAuth } = require('../middleware/authMiddleware');
const controller = require('../src/core/domain/restaurantVenueController');
const {
  listQuerySchema,
  suggestQuerySchema,
  venueSchema,
  reviewsQuerySchema,
  reviewFeedQuerySchema,
  homeQuerySchema,
  homeSectionQuerySchema,
  createReviewSchema,
  updateReviewSchema,
  authorReviewQuerySchema,
  deleteReviewSchema,
  submitReportSchema,
  submitClaimSchema,
  myClaimSchema,
  updateOwnVenueSchema,
  dashboardReadSchema,
  dashboardActivitySchema,
  dashboardInsightsSchema,
  ownerReviewsQuerySchema,
  ownerReviewSchema,
  createResponseSchema,
  deleteResponseSchema,
  uploadVenuePhotosSchema,
  updatePhotoSchema,
  deletePhotoSchema,
  reorderPhotosSchema,
  setCoverPhotoSchema,
  saveMenuSchema,
  menuActionSchema,
  teamReadSchema,
  inviteMemberSchema,
  inviteActionSchema,
  acceptInviteSchema,
  updateMemberRoleSchema,
  memberActionSchema,
} = require('../src/core/services/restaurantVenueSchemas');

const router = express.Router();

// One instance shared by both API prefixes. Built once at require time, so
// /api and /api/v1 draw from the same allowance for the same user.
const reviewWriteLimiter = createUserLimiter({
  name: 'restaurant-reviews',
  defaultMax: 30,
  defaultWindowMs: 60 * 60 * 1000,
  message: {
    status: 'fail',
    message: 'Too many reviews submitted, please slow down.',
  },
});

const claimLimiter = createUserLimiter({
  name: 'restaurant-claims',
  defaultMax: 10,
  defaultWindowMs: 60 * 60 * 1000,
  message: {
    status: 'fail',
    message: 'Too many restaurant claims submitted, please slow down.',
  },
});

// Team invitations send mail and are a credential. Cap them per owner.
const teamLimiter = createUserLimiter({
  name: 'restaurant-team-invites',
  defaultMax: 20,
  defaultWindowMs: 60 * 60 * 1000,
  message: {
    status: 'fail',
    message: 'Too many team invitations sent, please slow down.',
  },
});

/**
 * @swagger
 * /restaurant-venues:
 *   get:
 *     summary: List restaurant venues for a brand
 *     tags: [Restaurant Venues]
 *     parameters:
 *       - { name: brand, in: query, schema: { type: string, enum: [ghana, africa, expedition] } }
 *       - { name: q, in: query, schema: { type: string } }
 *       - { name: city, in: query, schema: { type: string } }
 *       - { name: cuisine, in: query, schema: { type: string } }
 *       - { name: dietary, in: query, description: "Comma-separated", schema: { type: string } }
 *       - { name: priceBand, in: query, schema: { type: integer, minimum: 1, maximum: 4 } }
 *       - { name: featured, in: query, schema: { type: boolean } }
 *       - { name: minRating, in: query, schema: { type: number } }
 *       - { name: minReviews, in: query, schema: { type: integer } }
 *       - { name: lat, in: query, schema: { type: number, minimum: -90, maximum: 90 } }
 *       - { name: lng, in: query, schema: { type: number, minimum: -180, maximum: 180 } }
 *       - { name: radiusKm, in: query, schema: { type: number, minimum: 0.1, maximum: 50 } }
 *       - { name: place, in: query, schema: { type: string } }
 *       - { name: highDemand, in: query, schema: { type: boolean } }
 *       - { name: hasOffer, in: query, schema: { type: boolean } }
 *       - { name: sort, in: query, schema: { type: string, enum: [rating, reviews, newest, demand] } }
 *       - { name: limit, in: query, schema: { type: integer, maximum: 50 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: Venues retrieved successfully }
 */
router.get('/', validate(listQuerySchema), controller.listVenues);

/**
 * @swagger
 * /restaurant-venues/suggest:
 *   get:
 *     summary: Restaurant and place typeahead
 *     tags: [Restaurant Venues]
 *     parameters:
 *       - { name: brand, in: query, schema: { type: string, enum: [ghana, africa, expedition] } }
 *       - { name: q, in: query, required: true, schema: { type: string } }
 *       - { name: limit, in: query, schema: { type: integer, maximum: 8 } }
 *     responses:
 *       200: { description: Suggestions retrieved successfully }
 */
router.get('/suggest', validate(suggestQuerySchema), controller.suggestVenues);

/**
 * @swagger
 * /restaurant-venues/reviews:
 *   get:
 *     summary: Approved reviews across all active venues for a brand
 *     tags: [Restaurant Venues]
 *     parameters:
 *       - { name: brand, in: query, schema: { type: string, enum: [ghana, africa, expedition] } }
 *       - { name: limit, in: query, schema: { type: integer, maximum: 50 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: Review feed retrieved successfully }
 */
// Literal path before `/:slugOrId`: otherwise "reviews" is read as a slug and
// the feed 404s. This route also sits ahead of `/:slugOrId/reviews`, which only
// matches a two-segment path and so never competes with it.
router.get('/reviews', validate(reviewFeedQuerySchema), controller.listReviewFeed);

/**
 * @swagger
 * /restaurant-venues/homepage/recommended:
 *   get:
 *     summary: Personalised restaurant recommendations (public, anonymous by default)
 *     tags: [Restaurant Venues]
 *     parameters:
 *       - { name: brand, in: query, schema: { type: string, enum: [ghana, africa, expedition] } }
 *       - { name: city, in: query, schema: { type: string } }
 *       - { name: lat, in: query, schema: { type: number } }
 *       - { name: lng, in: query, schema: { type: number } }
 *       - { name: limit, in: query, schema: { type: integer, maximum: 20 } }
 *     responses:
 *       200: { description: Venues retrieved successfully }
 */
// Literal homepage paths must sit above `/:slugOrId`, otherwise the rails are
// read as a venue slug. optionalAuth attaches a user only when a valid token
// is present; these reads stay public.
router.get('/homepage/recommended', optionalAuth, validate(homeQuerySchema), controller.getRecommended);

router.get('/homepage/likely-to-book-out', optionalAuth, validate(homeQuerySchema), controller.getLikelyToBookOut);

router.get('/homepage/offers', optionalAuth, validate(homeQuerySchema), controller.getSpecialOffers);

router.get(
  '/homepage/section-venue-ids',
  optionalAuth,
  validate(homeSectionQuerySchema),
  controller.getSectionVenueIds,
);

/* ── owner dashboard ────────────────────────────────────────────────────── */

/**
 * Everything below resolves the venue from the signed-in user's active
 * membership. A slug is a lookup key, never a grant: a manager of venue A gets
 * a 403 on venue B's dashboard even with a valid token.
 *
 * These paths are two or more segments, so they sit safely above the single
 * `/:slugOrId` read without shadowing it.
 */

router.post(
  '/team/invites/accept',
  protect,
  validate(acceptInviteSchema),
  controller.acceptTeamInvite,
);

router.get(
  '/:slugOrId/dashboard',
  protect,
  validate(dashboardReadSchema),
  controller.getDashboard,
);

router.get(
  '/:slugOrId/dashboard/session',
  protect,
  validate(dashboardReadSchema),
  controller.getDashboardSession,
);

router.get(
  '/:slugOrId/dashboard/activity',
  protect,
  validate(dashboardActivitySchema),
  controller.getDashboardActivity,
);

router.get(
  '/:slugOrId/dashboard/insights',
  protect,
  validate(dashboardInsightsSchema),
  controller.getDashboardInsights,
);

/* reviews and replies */

router.get(
  '/:slugOrId/dashboard/reviews',
  protect,
  validate(ownerReviewsQuerySchema),
  controller.listOwnerReviews,
);

router.get(
  '/:slugOrId/dashboard/reviews/:reviewId',
  protect,
  validate(ownerReviewSchema),
  controller.getOwnerReview,
);

router.post(
  '/:slugOrId/dashboard/reviews/:reviewId/responses',
  protect,
  reviewWriteLimiter,
  validate(createResponseSchema),
  controller.createReviewResponse,
);

router.delete(
  '/:slugOrId/dashboard/responses/:responseId',
  protect,
  reviewWriteLimiter,
  validate(deleteResponseSchema),
  controller.deleteReviewResponse,
);

/* photos */

router.get(
  '/:slugOrId/dashboard/photos',
  protect,
  validate(dashboardReadSchema),
  controller.listVenuePhotos,
);

// Multer parses the multipart body, so the uploader runs before `validate`.
router.post(
  '/:slugOrId/dashboard/photos',
  protect,
  reviewWriteLimiter,
  uploadVenuePhotos,
  validate(uploadVenuePhotosSchema),
  controller.uploadVenuePhotos,
);

// Literal order/cover paths before the `:photoId` handlers.
router.put(
  '/:slugOrId/dashboard/photos/order',
  protect,
  validate(reorderPhotosSchema),
  controller.reorderVenuePhotos,
);

router.put(
  '/:slugOrId/dashboard/photos/cover',
  protect,
  validate(setCoverPhotoSchema),
  controller.setVenueCoverPhoto,
);

router.patch(
  '/:slugOrId/dashboard/photos/:photoId',
  protect,
  validate(updatePhotoSchema),
  controller.updateVenuePhoto,
);

router.delete(
  '/:slugOrId/dashboard/photos/:photoId',
  protect,
  validate(deletePhotoSchema),
  controller.deleteVenuePhoto,
);

/* menus */

router.get(
  '/:slugOrId/dashboard/menu',
  protect,
  validate(dashboardReadSchema),
  controller.listVenueMenus,
);

router.put(
  '/:slugOrId/dashboard/menu',
  protect,
  reviewWriteLimiter,
  validate(saveMenuSchema),
  controller.saveVenueMenu,
);

router.post(
  '/:slugOrId/dashboard/menu/:menuId/publish',
  protect,
  validate(menuActionSchema),
  controller.publishVenueMenu,
);

router.post(
  '/:slugOrId/dashboard/menu/:menuId/unpublish',
  protect,
  validate(menuActionSchema),
  controller.unpublishVenueMenu,
);

router.delete(
  '/:slugOrId/dashboard/menu/:menuId',
  protect,
  validate(menuActionSchema),
  controller.deleteVenueMenu,
);

/* team */

router.get(
  '/:slugOrId/dashboard/team',
  protect,
  validate(teamReadSchema),
  controller.getVenueTeam,
);

router.post(
  '/:slugOrId/dashboard/team/invites',
  protect,
  teamLimiter,
  validate(inviteMemberSchema),
  controller.inviteTeamMember,
);

router.delete(
  '/:slugOrId/dashboard/team/invites/:inviteId',
  protect,
  validate(inviteActionSchema),
  controller.revokeTeamInvite,
);

router.patch(
  '/:slugOrId/dashboard/team/members/:memberId',
  protect,
  validate(updateMemberRoleSchema),
  controller.updateTeamMemberRole,
);

router.delete(
  '/:slugOrId/dashboard/team/members/:memberId',
  protect,
  validate(memberActionSchema),
  controller.removeTeamMember,
);

router.post(
  '/:slugOrId/dashboard/team/members/:memberId/transfer',
  protect,
  validate(memberActionSchema),
  controller.transferVenueOwnership,
);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}/reviews:
 *   get:
 *     summary: Approved reviews for a restaurant venue
 *     tags: [Restaurant Venues]
 *     responses:
 *       200: { description: Reviews retrieved successfully }
 */
router.get('/:slugOrId/reviews', validate(reviewsQuerySchema), controller.listReviews);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}:
 *   get:
 *     summary: One restaurant venue by slug or id
 *     tags: [Restaurant Venues]
 *     responses:
 *       200: { description: Venue retrieved successfully }
 *       404: { description: Venue not found }
 */
// Keep literal paths above `/:slugOrId`: otherwise "my-venues" is read as a slug.
router.get('/my-venues', protect, controller.listMyVenues);

router.get('/:slugOrId', validate(venueSchema), controller.getVenue);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}/review-photos:
 *   post:
 *     summary: Upload photos for a restaurant review
 *     tags: [Restaurant Venues]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/:slugOrId/review-photos',
  protect,
  reviewWriteLimiter,
  uploadReviewPhotos,
  validate(venueSchema),
  controller.uploadReviewPhotos,
);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}/reviews:
 *   post:
 *     summary: Submit a restaurant review
 *     tags: [Restaurant Venues]
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       Provenance is decided by the server. Supplying `proofToken` from a
 *       signed invite makes the review verified and immediately visible;
 *       without it the review waits for moderation. Ratings are 1-5 and the
 *       written review must be at least 20 characters.
 */
router.post(
  '/:slugOrId/reviews',
  protect,
  reviewWriteLimiter,
  validate(createReviewSchema),
  controller.createReview,
);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}/reviews/{reviewId}:
 *   get:
 *     summary: Load your own review for correction
 *     tags: [Restaurant Venues]
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/:slugOrId/reviews/:reviewId',
  protect,
  validate(authorReviewQuerySchema),
  controller.getOwnReview,
);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}/reviews/{reviewId}:
 *   patch:
 *     summary: Replace your own review
 *     tags: [Restaurant Venues]
 *     security:
 *       - bearerAuth: []
 *     description: Archives the old review and sends the replacement to moderation.
 */
router.patch(
  '/:slugOrId/reviews/:reviewId',
  protect,
  reviewWriteLimiter,
  validate(updateReviewSchema),
  controller.replaceOwnReview,
);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}/reviews/{reviewId}:
 *   delete:
 *     summary: Archive your own review
 *     tags: [Restaurant Venues]
 *     security:
 *       - bearerAuth: []
 *     description: Delete and resubmit is the only correction path; content is never silently edited.
 */
router.delete(
  '/:slugOrId/reviews/:reviewId',
  protect,
  reviewWriteLimiter,
  validate(deleteReviewSchema),
  controller.deleteReview,
);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}/reviews/{reviewId}/report:
 *   post:
 *     summary: Report a review
 *     tags: [Restaurant Venues]
 *     security:
 *       - bearerAuth: []
 *     description: A report opens an investigation. Only an upheld FAKE classification removes the review.
 */
router.post(
  '/:slugOrId/reviews/:reviewId/report',
  protect,
  reviewWriteLimiter,
  validate(submitReportSchema),
  controller.submitReport,
);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}/claim:
 *   get:
 *     summary: Current user's claim and membership for one venue
 *     tags: [Restaurant Venues]
 *     security:
 *       - bearerAuth: []
 *   post:
 *     summary: Ask to manage a restaurant listing
 *     tags: [Restaurant Venues]
 *     security:
 *       - bearerAuth: []
 *     description: A claim is reviewed by an admin. It never grants access on submit.
 */
router.get(
  '/:slugOrId/claim',
  protect,
  validate(myClaimSchema),
  controller.getMyClaim,
);

router.post(
  '/:slugOrId/claims',
  protect,
  claimLimiter,
  validate(submitClaimSchema),
  controller.submitClaim,
);

/**
 * @swagger
 * /restaurant-venues/{slugOrId}:
 *   patch:
 *     summary: Update presentation details on a venue you manage
 *     tags: [Restaurant Venues]
 *     security:
 *       - bearerAuth: []
 *     description: Owners cannot change ratings, ranking inputs or external stats.
 */
router.patch(
  '/:slugOrId',
  protect,
  reviewWriteLimiter,
  validate(updateOwnVenueSchema),
  controller.updateOwnVenue,
);

module.exports = router;
