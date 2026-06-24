/**
 * Review Routes - Production Ready
 * Handles all review-related endpoints
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const reviewController = require('../controllers/reviewController');
const { uploadReviewPhotos } = require('../middleware/uploadMiddleware');

const router = express.Router();

// ================================
// PUBLIC REVIEW ENDPOINTS
// ================================

/**
 * @swagger
 * /reviews/tours/{tourId}:
 *   get:
 *     summary: Get reviews for a tour
 *     tags: [Reviews]
 *     parameters:
 *       - name: tourId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 10
 *       - name: rating
 *         in: query
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 5
 *       - name: sortBy
 *         in: query
 *         schema:
 *           type: string
 *           enum: [createdAt, rating, helpfulCount]
 *           default: createdAt
 *       - name: sortOrder
 *         in: query
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *     responses:
 *       200:
 *         description: Reviews retrieved successfully
 */
router.get('/tours/:tourId', reviewController.getTourReviews);

// ================================
// AUTHENTICATED REVIEW ENDPOINTS
// ================================

// All routes below require authentication
router.use(protect);

// Literal paths BEFORE parameterized /:id to avoid route collision
router.get('/admin/pending', restrictTo('admin'), requirePermission('reviews.view'), reviewController.getPendingReviews);
router.get('/supplier/reviews', resolveSupplier, requireTeamPermission('reviews.view'), reviewController.getSupplierReviews);

router.post('/', uploadReviewPhotos, reviewController.createReview);

/**
 * @swagger
 * /reviews:
 *   post:
 *     summary: Create review for completed booking
  *     description: |
  *       Submit a review for a completed tour booking. Reviews can only be created for bookings with COMPLETED status and SUCCEEDED payment.
  *       Reviews are automatically approved and include a verified badge since booking ownership is confirmed.
  *       You can include photos with your review (max 5 images).
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - bookingId
 *               - rating
 *             properties:
 *               bookingId:
 *                 type: string
 *                 description: ID of the completed booking
 *                 example: cmp2hql3c0001tzv0460pbckm
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *                 description: Rating from 1 (poor) to 5 (excellent)
 *                 example: 5
 *               title:
 *                 type: string
 *                 minLength: 5
 *                 maxLength: 100
 *                 description: Review title/headline
 *                 example: Amazing experience in Central Park!
 *               comment:
 *                 type: string
 *                 minLength: 20
 *                 maxLength: 2000
 *                 description: Detailed review text
 *                 example: This was an absolutely fantastic tour! Our guide was knowledgeable and friendly. We learned so much about the history of Central Park and saw many hidden gems. Highly recommend!
 *               photos:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Review photos (max 10 images, JPEG/PNG, max 5MB each)
 *     responses:
 *       201:
 *         description: Review created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Review submitted successfully
 *                 data:
 *                   $ref: '#/components/schemas/Review'
 *       400:
 *         description: Validation error or review already exists for this booking
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Booking not found or not eligible for review (must be COMPLETED)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:id', reviewController.getReview);

/**
 * @swagger
 * /reviews/{id}:
 *   patch:
 *     summary: Update customer's own review
 *     description: |
 *       Update your own review. You can modify the rating, title, comment, and add/replace photos.
 *       Only the review author can update their review.
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Review ID
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *                 description: Updated rating from 1 (poor) to 5 (excellent)
 *                 example: 4
 *               title:
 *                 type: string
 *                 minLength: 5
 *                 maxLength: 100
 *                 description: Updated review title
 *                 example: Great tour with minor issues
 *               comment:
 *                 type: string
 *                 minLength: 20
 *                 maxLength: 2000
 *                 description: Updated review text
 *                 example: Overall a great experience, though the meeting point was a bit confusing to find. The tour itself was excellent and our guide was very knowledgeable.
 *               photos:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: New photos to add (max 5 total images, JPEG/PNG, max 5MB each)
 *     responses:
 *       200:
 *         description: Review updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Review updated successfully
 *                 data:
 *                   $ref: '#/components/schemas/Review'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Review not found or access denied (not your review)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/:id', uploadReviewPhotos, reviewController.updateReview);

/**
 * @swagger
 * /reviews/{id}:
 *   delete:
 *     summary: Delete customer's own review
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Review deleted successfully
 *       404:
 *         description: Review not found or access denied
 */
router.delete('/:id', reviewController.deleteReview);

// ================================
// SUPPLIER RESPONSE ENDPOINTS
// ================================

/**
 * @swagger
 * /reviews/{id}/response:
 *   post:
 *     summary: Add supplier response to review
 *     description: |
 *       Respond to a customer review for your tour. Suppliers can only respond to reviews for their own tours.
 *       Only one response per review is allowed.
 *     tags: [Reviews, Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Review ID
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - response
 *             properties:
 *               response:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 1000
 *                 description: Your response to the customer's review
 *                 example: Thank you so much for your wonderful review! We're thrilled you enjoyed the tour and found our guide knowledgeable. We hope to see you again on another adventure!
 *           example:
 *             response: Thank you so much for your wonderful review! We're thrilled you enjoyed the tour and found our guide knowledgeable. We hope to see you again on another adventure!
 *     responses:
 *       200:
 *         description: Supplier response added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Response added successfully
 *                 data:
 *                   $ref: '#/components/schemas/Review'
 *       400:
 *         description: Response already exists or validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Review not found or access denied (not your tour)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/:id/response', resolveSupplier, requireTeamPermission('reviews.respond'), reviewController.addSupplierResponse);

/**
 * @swagger
 * /reviews/{id}/response:
 *   patch:
 *     summary: Update supplier response
 *     description: |
 *       Update your existing response to a customer review.
 *       Only the supplier who created the response can update it.
 *     tags: [Reviews, Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Review ID
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - response
 *             properties:
 *               response:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 1000
 *                 description: Updated response text
 *                 example: Thank you for your feedback! We've taken note of the meeting point confusion and have added clearer signage. We're glad you enjoyed the tour overall and hope to welcome you back soon!
 *           example:
 *             response: Thank you for your feedback! We've taken note of the meeting point confusion and have added clearer signage. We're glad you enjoyed the tour overall and hope to welcome you back soon!
 *     responses:
 *       200:
 *         description: Supplier response updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Response updated successfully
 *                 data:
 *                   $ref: '#/components/schemas/Review'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Review not found or no existing response
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/:id/response', resolveSupplier, requireTeamPermission('reviews.respond'), reviewController.updateSupplierResponse);

/**
 * @swagger
 * /reviews/{id}/response:
 *   delete:
 *     summary: Delete supplier response
 *     tags: [Reviews, Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Supplier response deleted successfully
 *       404:
 *         description: Review not found or no response to delete
 */
router.delete('/:id/response', resolveSupplier, requireTeamPermission('reviews.respond'), reviewController.deleteSupplierResponse);

// ================================
// ADMIN MODERATION ENDPOINTS
// ================================

/**
 * @swagger
 * /reviews/{id}/moderate:
 *   patch:
 *     summary: Moderate review (admin only)
 *     description: |
 *       Admin moderation of customer reviews. Actions available:
 *       - **approve**: Approve a pending review for public display
 *       - **reject**: Reject a review (violates guidelines)
 *       - **flag**: Flag a review for further investigation
 *     tags: [Reviews, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Review ID
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [approve, reject, flag]
 *                 description: Moderation action to take
 *                 example: approve
 *               reason:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 500
 *                 description: Required for reject and flag actions - explain why
 *                 example: Review contains inappropriate language and violates community guidelines
 *           examples:
 *             approve:
 *               summary: Approve review
 *               value:
 *                 action: approve
 *             reject:
 *               summary: Reject review
 *               value:
 *                 action: reject
 *                 reason: Review contains inappropriate language and violates community guidelines
 *             flag:
 *               summary: Flag for investigation
 *               value:
 *                 action: flag
 *                 reason: Suspected fake review - needs further investigation
 *     responses:
 *       200:
 *         description: Review moderated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Review approved successfully
 *                 data:
 *                   $ref: '#/components/schemas/Review'
 *       400:
 *         description: Invalid moderation action or missing required reason
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Review not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Access denied - admin role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/:id/moderate', restrictTo('admin'), requirePermission('reviews.moderate'), reviewController.moderateReview);

// ================================
// ADMIN REVIEW MANAGEMENT
// ================================

/**
 * @swagger
 * /reviews/{id}/admin:
 *   patch:
 *     summary: Admin edit any review content
 *     tags: [Reviews, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *               title:
 *                 type: string
 *               comment:
 *                 type: string
 *               photos:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Review updated
 */
router.patch('/:id/admin', restrictTo('admin'), requirePermission('reviews.moderate'), reviewController.adminUpdateReview);

/**
 * @swagger
 * /reviews/{id}/admin:
 *   delete:
 *     summary: Admin delete any review
 *     tags: [Reviews, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Review deleted
 */
router.delete('/:id/admin', restrictTo('admin'), requirePermission('reviews.moderate'), reviewController.adminDeleteReview);

/**
 * @swagger
 * /reviews/{id}/admin/response:
 *   patch:
 *     summary: Admin edit any supplier response
 *     tags: [Reviews, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - response
 *             properties:
 *               response:
 *                 type: string
 *     responses:
 *       200:
 *         description: Supplier response updated
 */
router.patch('/:id/admin/response', restrictTo('admin'), requirePermission('reviews.moderate'), reviewController.adminUpdateSupplierResponse);

/**
 * @swagger
 * /reviews/{id}/admin/response:
 *   delete:
 *     summary: Admin delete any supplier response
 *     tags: [Reviews, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Supplier response deleted
 */
router.delete('/:id/admin/response', restrictTo('admin'), requirePermission('reviews.moderate'), reviewController.adminDeleteSupplierResponse);

module.exports = router;