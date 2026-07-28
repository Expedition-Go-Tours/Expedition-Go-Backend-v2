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
const { requirePermission } = require('../middleware/permissionMiddleware');
const adminController = require('../controllers/adminController');
const adminNotifController = require('../controllers/adminNotificationController');
const adminSettingsController = require('../controllers/adminSettingsController');

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
router.get('/analytics/overview', requirePermission('dashboard.*', 'analytics.view'), adminController.getOverview);

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
router.get('/analytics/revenue-trend', requirePermission('analytics.view'), adminController.getRevenueTrend);

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
router.get('/analytics/user-growth', requirePermission('analytics.view'), adminController.getUserGrowth);

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
router.get('/analytics/tour-performance', requirePermission('analytics.view'), adminController.getTourPerformance);

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
router.get('/analytics/funnel', requirePermission('analytics.view'), adminController.getFunnel);

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
router.get('/analytics/clv', requirePermission('analytics.view'), adminController.getCLV);

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
router.get('/analytics/search', requirePermission('analytics.view'), adminController.getSearchAnalytics);

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
router.get('/analytics/cart-abandonment', requirePermission('analytics.view'), adminController.getCartAbandonment);

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
router.get('/notifications', requirePermission('notifications.view'), adminNotifController.getNotifications);

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
router.get('/notifications/unread-count', requirePermission('notifications.view'), adminNotifController.getUnreadCount);

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
router.get('/notifications/stats', requirePermission('notifications.view'), adminNotifController.getStats);

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
router.patch('/notifications/:id/acknowledge', requirePermission('notifications.view'), adminNotifController.acknowledge);

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
router.patch('/notifications/acknowledge-all', requirePermission('notifications.view'), adminNotifController.acknowledgeAll);

/**
 * @swagger
 * /admin/users/active:
 *   get:
 *     summary: List recently active users
 *     description: Returns users who have logged in within the last 30 days.
 *     tags: [Admin, Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active users list
 */
router.get('/users/active', requirePermission('users.view'), adminController.getActiveUsers);

/**
 * @swagger
 * /admin/users/new-signups:
 *   get:
 *     summary: Recent new user signups
 *     description: Returns users who signed up in the last 30 days.
 *     tags: [Admin, Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Recent signups list
 */
router.get('/users/new-signups', requirePermission('users.view'), adminController.getRecentSignups);

/**
 * @swagger
 * /admin/users/new:
 *   get:
 *     summary: New users within a period
 *     description: Returns users who signed up in the given period, optionally filtered by role.
 *     tags: [Admin, Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema: { type: string, default: '30d' }
 *       - in: query
 *         name: role
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: New users list
 */
router.get('/users/new', requirePermission('users.view'), adminController.getRecentSignups);

/**
 * @swagger
 * /admin/bookings/today:
 *   get:
 *     summary: Today's bookings
 *     description: Returns all bookings created today with customer, tour, and supplier details.
 *     tags: [Admin, Bookings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Today's bookings list
 */
router.get('/bookings/today', requirePermission('dashboard.bookings', 'dashboard.revenue'), adminController.getTodayBookings);

/**
 * @swagger
 * /admin/users/search:
 *   get:
 *     summary: Search users by name or email (admin)
 *     tags: [Admin, Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: q
 *         in: query
 *         description: Search query
 *         schema:
 *           type: string
 *       - name: role
 *         in: query
 *         description: Filter by role (customer, supplier)
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Users found
 */
router.get('/users/search', requirePermission('users.view'), adminController.searchUsers);
router.get('/users/:id', requirePermission('users.view'), adminController.getUser);

/**
 * @swagger
 * /admin/me:
 *   get:
 *     summary: Get current admin user profile
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current admin user
 */
router.get('/me', adminController.getMe);

/**
 * @swagger
 * /admin/audit-log:
 *   get:
 *     summary: Get audit log entries
 *     description: |
 *       Returns paginated audit log entries with optional filtering by action type,
 *       resource, and date range. Each entry records administrative actions for
 *       compliance and security monitoring.
 *     tags: [Admin, Audit]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *         description: Records per page (max 100)
 *       - name: action
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by action type (case-insensitive partial match)
 *         example: settings.updated
 *       - name: resource
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by resource type (case-insensitive partial match)
 *         example: SystemConfig
 *       - name: startDate
 *         in: query
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter entries from this date (ISO 8601)
 *         example: "2026-01-01"
 *       - name: endDate
 *         in: query
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter entries until this date (ISO 8601)
 *         example: "2026-06-19"
 *     responses:
 *       200:
 *         description: Audit log entries retrieved
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
 *                     entries:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: audit_abc123
 *                           userId:
 *                             type: string
 *                             example: user_abc123
 *                           userEmail:
 *                             type: string
 *                             example: admin@example.com
 *                           userName:
 *                             type: string
 *                             description: Resolved admin name (from user lookup)
 *                             example: John Admin
 *                           action:
 *                             type: string
 *                             description: The action performed
 *                             example: settings.updated
 *                           resource:
 *                             type: string
 *                             example: SystemConfig
 *                           resourceId:
 *                             type: string
 *                             nullable: true
 *                             example: system.maintenance_mode
 *                           oldValues:
 *                             type: object
 *                             nullable: true
 *                             description: Previous values (for update actions)
 *                           newValues:
 *                             type: object
 *                             nullable: true
 *                             description: New values (for create/update actions)
 *                             example: {"system.maintenance_mode": "true"}
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *                             example: "2026-06-19T14:30:00.000Z"
 *                     total:
 *                       type: integer
 *                       example: 156
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     pages:
 *                       type: integer
 *                       example: 8
 *       403:
 *         description: Access denied - admin role required
 */
router.get('/audit-log', requirePermission('settings.access', 'audit.view'), adminSettingsController.getAuditLog);

/**
 * @swagger
 * /admin/audit-log/export:
 *   get:
 *     summary: Export audit log as CSV
 *     description: |
 *       Exports audit log entries as a CSV file download. Supports the same
 *       filtering parameters as the audit log list endpoint.
 *       The CSV includes columns: Date/Time, Admin, Email, Action, Resource, Resource ID, Details.
 *     tags: [Admin, Audit]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: action
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by action type (case-insensitive partial match)
 *         example: settings.updated
 *       - name: resource
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by resource type (case-insensitive partial match)
 *         example: SystemConfig
 *       - name: startDate
 *         in: query
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter entries from this date (ISO 8601)
 *         example: "2026-01-01"
 *       - name: endDate
 *         in: query
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter entries until this date (ISO 8601)
 *         example: "2026-06-19"
 *     responses:
 *       200:
 *         description: CSV file download
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 *       403:
 *         description: Access denied - admin role required
 */
router.get('/audit-log/export', requirePermission('settings.access', 'audit.view'), adminSettingsController.exportAuditLog);

/**
 * @swagger
 * /admin/bookings:
 *   get:
 *     summary: Paginated bookings list
 *     tags: [Admin, Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         schema: { type: integer, default: 1 }
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 20 }
 *       - name: status
 *         in: query
 *         schema: { type: string }
 *         description: Filter by booking status (PENDING, CONFIRMED, COMPLETED, CANCELLED)
 *       - name: search
 *         in: query
 *         schema: { type: string }
 *         description: Search by booking number, customer name, tour title, supplier name
 *       - name: startDate
 *         in: query
 *         schema: { type: string, format: date }
 *       - name: endDate
 *         in: query
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Bookings list
 */
router.get('/bookings', requirePermission('bookings.view', 'dashboard.*'), adminController.getBookings);

/**
 * @swagger
 * /admin/bookings/{id}:
 *   get:
 *     summary: Get booking by ID
 *     tags: [Admin, Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Booking details
 *       404:
 *         description: Booking not found
 */
router.get('/bookings/:id', requirePermission('bookings.view', 'dashboard.*'), adminController.getBookingById);

/**
 * @swagger
 * /admin/bookings/{id}/confirm-payment:
 *   patch:
 *     summary: Confirm payment for a booking
 *     tags: [Admin, Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reference:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment confirmed
 *       400:
 *         description: Payment already confirmed
 *       404:
 *         description: Booking not found
 */
router.patch('/bookings/:id/confirm-payment', requirePermission('bookings.confirm-payment', 'dashboard.*'), adminController.confirmPayment);

// ── Expedition Go Listing Management ──
router.get('/expedition/listings', adminController.getExpeditionListings);
router.patch('/tours/:tourId/expedition-publish', adminController.toggleExpeditionPublish);
router.patch('/expedition/bulk-publish', adminController.bulkExpeditionPublish);

module.exports = router;
