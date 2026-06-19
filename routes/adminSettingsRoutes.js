/**
 * Admin Settings Routes — System Configuration Management
 *
 * All routes require authentication + admin role.
 * Reading settings requires the settings.access permission;
 * updating settings is restricted to super admins only.
 *
 * @module routes/adminSettingsRoutes
 * @version 1.0.0
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission, requireSuperAdmin } = require('../middleware/permissionMiddleware');
const settingsController = require('../controllers/adminSettingsController');

const router = express.Router();

router.use(protect, restrictTo('admin'));

/**
 * @swagger
 * /api/admin/settings:
 *   get:
 *     summary: Get all system settings
 *     description: |
 *       Returns every system configuration key-value pair as a flat object.
 *       Keys include settings like system.maintenance_mode, site.name, etc.
 *     tags: [Admin, Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Settings retrieved successfully
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
 *                   description: Flat key-value map of all settings
 *                   example:
 *                     site.name: My Tour Platform
 *                     site.description: Book amazing tours
 *                     system.maintenance_mode: "false"
 *       403:
 *         description: Insufficient permissions — requires settings.access
 */
router.get('/', requirePermission('settings.access'), settingsController.getSettings);

/**
 * @swagger
 * /api/admin/settings:
 *   put:
 *     summary: Update system settings (upsert)
 *     description: |
 *       Bulk upsert system configuration. Pass an object of key-value pairs.
 *       Existing keys are updated, new keys are created.
 *       If system.maintenance_mode is included, the maintenance-mode cache
 *       is automatically cleared. Super admin only. An audit log entry is recorded.
 *     tags: [Admin, Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - settings
 *             properties:
 *               settings:
 *                 type: object
 *                 description: Key-value pairs to upsert
 *                 example:
 *                   site.name: My Tour Platform
 *                   site.description: Book amazing tours worldwide
 *                   system.maintenance_mode: "false"
 *     responses:
 *       200:
 *         description: Settings updated successfully
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
 *                   description: Complete settings map after update
 *                   example:
 *                     site.name: My Tour Platform
 *                     site.description: Book amazing tours worldwide
 *                     system.maintenance_mode: "false"
 *       400:
 *         description: settings object is required
 *       403:
 *         description: Super admin access required
 */
router.put('/', requireSuperAdmin, settingsController.updateSettings);

/**
 * @swagger
 * /api/admin/settings/{key}:
 *   get:
 *     summary: Get a single setting by key
 *     description: |
 *       Returns the value for a specific system configuration key.
 *       Returns 404 if the key does not exist.
 *     tags: [Admin, Settings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: key
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Setting key (e.g. site.name, system.maintenance_mode)
 *         example: system.maintenance_mode
 *     responses:
 *       200:
 *         description: Setting retrieved successfully
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
 *                   description: Single key-value pair
 *                   example:
 *                     system.maintenance_mode: "false"
 *       404:
 *         description: Setting not found
 *       403:
 *         description: Insufficient permissions — requires settings.access
 */
router.get('/:key', requirePermission('settings.access'), settingsController.getSetting);

module.exports = router;
