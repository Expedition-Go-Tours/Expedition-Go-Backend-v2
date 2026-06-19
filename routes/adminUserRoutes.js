/**
 * Admin User Routes — Admin Account Management
 *
 * All routes require authentication + admin role.
 * Listing admin users requires roles.manage permission;
 * adding, updating role, and revoking admin access are
 * restricted to super admins only.
 *
 * @module routes/adminUserRoutes
 * @version 1.0.0
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission, requireSuperAdmin } = require('../middleware/permissionMiddleware');
const adminUserController = require('../controllers/adminUserController');

const router = express.Router();

router.use(protect, restrictTo('admin'));

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: List all admin users
 *     description: |
 *       Returns all users who have the admin role, along with
 *       their assigned admin role info. Photo URLs are optimized
 *       via Cloudinary to 64px. Ordered by creation date descending.
 *     tags: [Admin, Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Admin users retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       email:
 *                         type: string
 *                         format: email
 *                       photoURL:
 *                         type: string
 *                         nullable: true
 *                       active:
 *                         type: boolean
 *                       lastLoginAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       adminRoleId:
 *                         type: string
 *                         nullable: true
 *                       adminRole:
 *                         type: object
 *                         nullable: true
 *                         properties:
 *                           id:
 *                             type: string
 *                           name:
 *                             type: string
 *                           description:
 *                             type: string
 *       403:
 *         description: Insufficient permissions — requires roles.manage
 */
router.get('/', requirePermission('roles.manage'), adminUserController.getAdminUsers);

/**
 * @swagger
 * /api/admin/users:
 *   post:
 *     summary: Grant admin privileges to a user
 *     description: |
 *       Promotes an existing user to admin by assigning them an
 *       admin role. The user must not already be an admin.
 *       Super admin only. An audit log entry is recorded.
 *     tags: [Admin, Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - adminRoleId
 *             properties:
 *               userId:
 *                 type: string
 *                 description: ID of the user to promote
 *                 example: user_abc123
 *               adminRoleId:
 *                 type: string
 *                 description: ID of the admin role to assign
 *                 example: role_xyz789
 *     responses:
 *       200:
 *         description: Admin privileges granted successfully
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
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     email:
 *                       type: string
 *                     photoURL:
 *                       type: string
 *                       nullable: true
 *                     active:
 *                       type: boolean
 *                     roles:
 *                       type: array
 *                       items:
 *                         type: string
 *                     adminRoleId:
 *                       type: string
 *                     adminRole:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         name:
 *                           type: string
 *                         description:
 *                           type: string
 *       400:
 *         description: userId and adminRoleId required, or user is already an admin
 *       404:
 *         description: User or admin role not found
 *       403:
 *         description: Super admin access required
 */
router.post('/', requireSuperAdmin, adminUserController.addAdmin);

/**
 * @swagger
 * /api/admin/users/{id}/role:
 *   patch:
 *     summary: Change an admin user's role
 *     description: |
 *       Reassigns an existing admin user to a different admin role.
 *       The user must already be an admin. Super admin only.
 *       An audit log entry is recorded.
 *     tags: [Admin, Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Admin user ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - adminRoleId
 *             properties:
 *               adminRoleId:
 *                 type: string
 *                 description: ID of the new admin role
 *                 example: role_new456
 *     responses:
 *       200:
 *         description: Admin role updated successfully
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
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     email:
 *                       type: string
 *                     photoURL:
 *                       type: string
 *                       nullable: true
 *                     active:
 *                       type: boolean
 *                     roles:
 *                       type: array
 *                       items:
 *                         type: string
 *                     adminRoleId:
 *                       type: string
 *                     adminRole:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         name:
 *                           type: string
 *                         description:
 *                           type: string
 *       400:
 *         description: adminRoleId required, or user is not an admin
 *       404:
 *         description: User or admin role not found
 *       403:
 *         description: Super admin access required
 */
router.patch('/:id/role', requireSuperAdmin, adminUserController.updateAdminRole);

/**
 * @swagger
 * /api/admin/users/{id}/revoke:
 *   delete:
 *     summary: Revoke admin privileges from a user
 *     description: |
 *       Removes the admin role from a user. The user must be an
 *       existing admin. Super admins cannot revoke their own access.
 *       Super admin only. An audit log entry is recorded.
 *     tags: [Admin, Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Admin user ID to demote
 *     responses:
 *       200:
 *         description: Admin privileges revoked successfully
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
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     email:
 *                       type: string
 *                     roles:
 *                       type: array
 *                       items:
 *                         type: string
 *                     adminRoleId:
 *                       type: string
 *                       nullable: true
 *       400:
 *         description: Cannot revoke your own admin access, or user is not an admin
 *       404:
 *         description: User not found
 *       403:
 *         description: Super admin access required
 */
router.delete('/:id/revoke', requireSuperAdmin, adminUserController.revokeAdmin);

module.exports = router;
