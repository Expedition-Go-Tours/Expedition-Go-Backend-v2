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
const { createUserLimiter } = require('../middleware/dynamicRateLimiter');
const { protect } = require('../middleware/authMiddleware');
const controller = require('../src/core/domain/restaurantVenueController');
const {
  listQuerySchema,
  venueSchema,
  reviewsQuerySchema,
  createReviewSchema,
  deleteReviewSchema,
  submitReportSchema,
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
 *       - { name: sort, in: query, schema: { type: string, enum: [rating, reviews, newest] } }
 *       - { name: limit, in: query, schema: { type: integer, maximum: 50 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: Venues retrieved successfully }
 */
router.get('/', validate(listQuerySchema), controller.listVenues);

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
router.get('/:slugOrId', validate(venueSchema), controller.getVenue);

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

module.exports = router;
