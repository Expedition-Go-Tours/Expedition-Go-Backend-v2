/**
 * Admin Routes — Platform Analytics & Management
 *
 * All routes require authentication + admin role.
 * Admin responsibilities:
 *  - View platform-wide analytics
 *  - Manage supplier applications (in supplierRoutes.js)
 *  - Moderate reviews (in reviewRoutes.js)
 *
 * @author Tour Platform Team
 * @version 1.0.0
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const adminController = require('../controllers/adminController');
const adminNotifController = require('../controllers/adminNotificationController');

const router = express.Router();

// Every admin route requires authentication + admin role
router.use(protect, restrictTo('admin'));

/**
 * @swagger
 * /admin/analytics/overview:
 *   get:
 *     summary: Platform-wide analytics snapshot
 *     description: |
 *       Revenue, bookings, signups, top tours/suppliers, booking status distribution,
 *       and recent event feed. All time periods are calendar-based (UTC midnight boundaries).
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Analytics overview retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/AnalyticsOverview'
 *       403:
 *         description: Admin access required
 */
router.get('/analytics/overview', adminController.getOverview);

/**
 * @swagger
 * /admin/analytics/revenue-trend:
 *   get:
 *     summary: Monthly revenue trend (last 24 months)
 *     description: Returns revenue, bookings, commission, and supplier payout per month for charting.
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Revenue trend retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/RevenueTrendResponse'
 */
router.get('/analytics/revenue-trend', adminController.getRevenueTrend);

/**
 * @swagger
 * /admin/analytics/user-growth:
 *   get:
 *     summary: Monthly user signup growth (last 24 months)
 *     description: Broken down by role (customer vs. supplier) for growth analysis.
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User growth data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/UserGrowthResponse'
 */
router.get('/analytics/user-growth', adminController.getUserGrowth);

/**
 * @swagger
 * /admin/analytics/tour-performance:
 *   get:
 *     summary: Tour-level performance metrics (paginated, filterable)
 *     description: |
 *       Paginated list of tours with earnings, bookings, ratings, and views.
 *       Filterable by status and category, sortable by any metric.
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [DRAFT, ACTIVE, PAUSED, ARCHIVED]
 *         description: Filter by tour status
 *       - name: category
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by tour category (e.g. Adventure, Cultural, Nature)
 *       - name: sortBy
 *         in: query
 *         schema:
 *           type: string
 *           enum: [totalRevenue, totalBookings, averageRating, viewCount, createdAt]
 *           default: totalRevenue
 *       - name: sortOrder
 *         in: query
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Tour performance data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/TourPerformanceResponse'
 */
router.get('/analytics/tour-performance', adminController.getTourPerformance);

/**
 * Phase 2 — Marketplace Intelligence
 */

/**
 * @swagger
 * /admin/analytics/funnel:
 *   get:
 *     summary: Booking conversion funnel
 *     description: |
 *       Tracks unique users through the booking funnel:
 *       viewed → cart_added → checkout_started → booking_completed.
 *       Each step is deduplicated by userId. View-to-book conversion rate included.
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: period
 *         in: query
 *         schema:
 *           type: string
 *           enum: [7d, 30d, 90d, 1y]
 *           default: 30d
 *         description: Lookback period for analysis
 *     responses:
 *       200:
 *         description: Funnel data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/FunnelResponse'
 */
router.get('/analytics/funnel', adminController.getFunnel);

/**
 * @swagger
 * /admin/analytics/clv:
 *   get:
 *     summary: Customer Lifetime Value & Repeat Booking Rate
 *     description: |
 *       Answers three critical questions:
 *       1. How much revenue does the average customer generate? (CLV)
 *       2. What percentage of customers book more than once? (Repeat Rate)
 *       3. Which customers and signup cohorts are most valuable?
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: CLV data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/CLVResponse'
 */
router.get('/analytics/clv', adminController.getCLV);

/**
 * @swagger
 * /admin/analytics/search:
 *   get:
 *     summary: Search analytics (queries, zero-result, trends)
 *     description: |
 *       Full visibility into what users are searching for:
 *       - Top queries ranked by frequency
 *       - Zero-result queries (unmet demand — product opportunities)
 *       - Search-to-view and search-to-book conversion rates
 *       - Daily search volume trends
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: period
 *         in: query
 *         schema:
 *           type: string
 *           enum: [7d, 30d, 90d, 1y]
 *           default: 30d
 *         description: Lookback period for analysis
 *     responses:
 *       200:
 *         description: Search analytics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/SearchAnalyticsResponse'
 */
router.get('/analytics/search', adminController.getSearchAnalytics);

/**
 * @swagger
 * /admin/analytics/cart-abandonment:
 *   get:
 *     summary: Cart abandonment rate & analysis
 *     description: |
 *       Tracks add-to-cart to booking conversion. Shows:
 *       - Overall cart abandonment rate
 *       - Which tours have the highest abandonment (fix pricing or UX?)
 *       - Daily abandonment trend chart
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: period
 *         in: query
 *         schema:
 *           type: string
 *           enum: [7d, 30d, 90d, 1y]
 *           default: 30d
 *         description: Lookback period for analysis
 *     responses:
 *       200:
 *         description: Cart abandonment data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/CartAbandonmentResponse'
 */
router.get('/analytics/cart-abandonment', adminController.getCartAbandonment);

/**
 * Admin Notifications
 */

/**
 * @swagger
 * /admin/notifications:
 *   get:
 *     summary: Get admin notifications (system-wide feed)
 *     description: |
 *       Returns system-wide admin notifications (new supplier applications,
 *       pending reviews, payout approvals needed, etc.) with pagination.
 *     tags: [Admin, Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         schema: { type: integer, default: 1 }
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 20 }
 *       - name: unacknowledgedOnly
 *         in: query
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Notifications retrieved
 */
router.get('/notifications', adminNotifController.getNotifications);

/**
 * @swagger
 * /admin/notifications/unread-count:
 *   get:
 *     summary: Get unacknowledged notification count
 *     tags: [Admin, Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unacknowledged count
 */
router.get('/notifications/unread-count', adminNotifController.getUnreadCount);

/**
 * @swagger
 * /admin/notifications/stats:
 *   get:
 *     summary: Admin notification statistics
 *     tags: [Admin, Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved
 */
router.get('/notifications/stats', adminNotifController.getStats);

/**
 * @swagger
 * /admin/notifications/{id}/acknowledge:
 *   patch:
 *     summary: Acknowledge a notification
 *     tags: [Admin, Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Notification acknowledged
 */
router.patch('/notifications/:id/acknowledge', adminNotifController.acknowledge);

/**
 * @swagger
 * /admin/notifications/acknowledge-all:
 *   patch:
 *     summary: Acknowledge all notifications
 *     tags: [Admin, Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications acknowledged
 */
router.patch('/notifications/acknowledge-all', adminNotifController.acknowledgeAll);

module.exports = router;
