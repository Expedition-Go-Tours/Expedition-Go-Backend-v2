/**
 * Notification Routes - Production Ready
 * Handles notification-related endpoints
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const notificationController = require('../controllers/notificationController');

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Get user's notifications
 *     description: |
 *       Retrieve all notifications for the authenticated user with pagination.
 *       Supports filtering to show only unread notifications.
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         description: Page number for pagination
 *         schema:
 *           type: integer
 *           default: 1
 *           example: 1
 *       - name: limit
 *         in: query
 *         description: Number of notifications per page
 *         schema:
 *           type: integer
 *           default: 20
 *           example: 20
 *       - name: unreadOnly
 *         in: query
 *         description: Filter to show only unread notifications
 *         schema:
 *           type: boolean
 *           default: false
 *           example: false
 *     responses:
 *       200:
 *         description: Notifications retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     notifications:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: cmp2hql3c0001tzv0460pbckm
 *                           type:
 *                             type: string
 *                             enum: [BOOKING_CONFIRMED, BOOKING_CANCELLED, REVIEW_RECEIVED, PAYOUT_PROCESSED, TOUR_APPROVED, APPLICATION_REVIEWED]
 *                             example: BOOKING_CONFIRMED
 *                           title:
 *                             type: string
 *                             example: New Booking Confirmed
 *                           message:
 *                             type: string
 *                             example: You have a new booking for "Central Park Walking Tour" on May 20, 2026
 *                           read:
 *                             type: boolean
 *                             example: false
 *                           data:
 *                             type: object
 *                             description: Additional notification data (booking ID, tour ID, etc.)
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *                             example: "2026-05-12T10:30:00.000Z"
 *                     unreadCount:
 *                       type: integer
 *                       description: Total number of unread notifications
 *                       example: 5
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         currentPage:
 *                           type: integer
 *                           example: 1
 *                         totalPages:
 *                           type: integer
 *                           example: 3
 *                         totalCount:
 *                           type: integer
 *                           example: 47
 *                         hasNextPage:
 *                           type: boolean
 *                           example: true
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/', notificationController.getNotifications);

/**
 * @swagger
 * /notifications/{id}/read:
 *   patch:
 *     summary: Mark notification as read
 *     description: Mark a specific notification as read. This updates the notification's read status to true.
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Notification ID
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     responses:
 *       200:
 *         description: Notification marked as read
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
 *                   example: Notification marked as read
 *       404:
 *         description: Notification not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/:id/read', notificationController.markAsRead);

/**
 * @swagger
 * /notifications/mark-all-read:
 *   patch:
 *     summary: Mark all notifications as read
 *     description: |
 *       Mark all of the user's notifications as read in a single operation.
 *       This is useful for clearing the notification badge/counter.
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read
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
 *                   example: All notifications marked as read
 *                 data:
 *                   type: object
 *                   properties:
 *                     updatedCount:
 *                       type: integer
 *                       description: Number of notifications that were marked as read
 *                       example: 12
 */
router.patch('/mark-all-read', notificationController.markAllAsRead);

/**
 * @swagger
 * /notifications/{id}:
 *   delete:
 *     summary: Delete notification
 *     description: |
 *       Permanently delete a specific notification.
 *       This action cannot be undone.
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Notification ID to delete
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     responses:
 *       204:
 *         description: Notification deleted successfully (no content)
 *       404:
 *         description: Notification not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete('/:id', notificationController.deleteNotification);

module.exports = router;