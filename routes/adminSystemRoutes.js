/**
 * Admin System Routes — System Health & Cache Management
 *
 * All routes require authentication + admin role.
 * Provides operational endpoints for monitoring system status
 * and performing administrative maintenance tasks.
 *
 * @module routes/adminSystemRoutes
 * @version 1.0.0
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const adminSystemController = require('../controllers/adminSystemController');

const router = express.Router();

router.use(protect, restrictTo('admin'));

/**
 * @swagger
 * /api/admin/system/health:
 *   get:
 *     summary: Get system health status
 *     description: |
 *       Performs a quick health check of core platform services.
 *       Checks API responsiveness and database connectivity.
 *       Returns the operational status of each component along
 *       with server time and process uptime.
 *     tags: [Admin, System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System health status
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
 *                     checks:
 *                       type: object
 *                       properties:
 *                         api:
 *                           type: object
 *                           properties:
 *                             status:
 *                               type: string
 *                               enum: [operational]
 *                         database:
 *                           type: object
 *                           properties:
 *                             status:
 *                               type: string
 *                               enum: [connected, disconnected]
 *                     serverTime:
 *                       type: string
 *                       format: date-time
 *                     uptime:
 *                       type: number
 *                       description: Server process uptime in seconds
 */
router.get('/health', adminSystemController.getSystemHealth);

/**
 * @swagger
 * /api/admin/system/cache/clear:
 *   post:
 *     summary: Clear system cache
 *     description: |
 *       Purges the application-level cache — currently clears the
 *       maintenance mode cache. Useful after updating settings or
 *       to force a fresh state without restarting the server.
 *     tags: [Admin, System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cache cleared successfully
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
 *                   example: Application cache cleared
 */
router.post('/cache/clear', adminSystemController.clearSystemCache);

module.exports = router;