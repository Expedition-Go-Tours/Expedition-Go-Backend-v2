/**
 * Admin Role Routes — RBAC Permission & Role Management
 *
 * All routes require authentication + admin role.
 * Permission-based access for reading roles/permissions;
 * super-admin only for create, update, and delete operations.
 *
 * @module routes/adminRoleRoutes
 * @version 1.0.0
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission, requireSuperAdmin } = require('../middleware/permissionMiddleware');
const roleController = require('../controllers/adminRoleController');

const router = express.Router();

router.use(protect, restrictTo('admin'));

/**
 * @swagger
 * /api/admin/roles/permissions:
 *   get:
 *     summary: Get all permissions grouped by category
 *     description: |
 *       Returns every system permission with its assigned roles.
 *       Permissions are ordered by category then name, and also
 *       returned as a grouped object keyed by category for easy
 *       rendering in permission-checkbox UIs.
 *     tags: [Admin, Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Permissions retrieved successfully
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
 *                     permissions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           key:
 *                             type: string
 *                           name:
 *                             type: string
 *                           description:
 *                             type: string
 *                           category:
 *                             type: string
 *                           isSystem:
 *                             type: boolean
 *                           roles:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 role:
 *                                   type: object
 *                                   properties:
 *                                     id:
 *                                       type: string
 *                                     name:
 *                                       type: string
 *                     grouped:
 *                       type: object
 *                       additionalProperties:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: string
 *                             key:
 *                               type: string
 *                             name:
 *                               type: string
 *                             description:
 *                               type: string
 *                             isSystem:
 *                               type: boolean
 *       403:
 *         description: Insufficient permissions — requires roles.manage
 */
router.get('/permissions', requirePermission('roles.manage'), roleController.getPermissions);

/**
 * @swagger
 * /api/admin/roles:
 *   get:
 *     summary: List all admin roles
 *     description: |
 *       Returns all admin roles with their associated permissions
 *       and a count of users assigned to each role.
 *     tags: [Admin, Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Roles retrieved successfully
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
 *                       description:
 *                         type: string
 *                       isSystem:
 *                         type: boolean
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                       _count:
 *                         type: object
 *                         properties:
 *                           users:
 *                             type: integer
 *                       permissions:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             permission:
 *                               type: object
 *                               properties:
 *                                 id:
 *                                   type: string
 *                                 key:
 *                                   type: string
 *                                 name:
 *                                   type: string
 *                                 category:
 *                                   type: string
 *       403:
 *         description: Insufficient permissions — requires roles.manage
 */
router.get('/', requirePermission('roles.manage'), roleController.getRoles);

/**
 * @swagger
 * /api/admin/roles/{id}:
 *   get:
 *     summary: Get a single admin role by ID
 *     description: Returns a role with its permissions and user count.
 *     tags: [Admin, Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Role ID
 *     responses:
 *       200:
 *         description: Role retrieved successfully
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
 *                     description:
 *                       type: string
 *                     isSystem:
 *                       type: boolean
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                     _count:
 *                       type: object
 *                       properties:
 *                         users:
 *                           type: integer
 *                     permissions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           permission:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                               key:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                               category:
 *                                 type: string
 *       404:
 *         description: Role not found
 *       403:
 *         description: Insufficient permissions — requires roles.manage
 */
router.get('/:id', requirePermission('roles.manage'), roleController.getRole);

/**
 * @swagger
 * /api/admin/roles:
 *   post:
 *     summary: Create a new admin role
 *     description: |
 *       Creates a new role with an auto-generated key (lowercased, spaces→underscores).
 *       Optionally attaches permissions via permissionIds array.
 *       Super admin only. An audit log entry is recorded.
 *     tags: [Admin, Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: Display name for the role
 *                 example: Content Manager
 *               description:
 *                 type: string
 *                 description: Optional description of the role's purpose
 *                 example: Manages content articles and media
 *               permissionIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of permission IDs to grant
 *                 example:
 *                   - perm_abc123
 *                   - perm_def456
 *     responses:
 *       201:
 *         description: Role created successfully
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
 *                     description:
 *                       type: string
 *                     isSystem:
 *                       type: boolean
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                     _count:
 *                       type: object
 *                       properties:
 *                         users:
 *                           type: integer
 *                     permissions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           permission:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                               key:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                               category:
 *                                 type: string
 *       400:
 *         description: Name is required or role already exists
 *       403:
 *         description: Super admin access required
 */
router.post('/', requireSuperAdmin, roleController.createRole);

/**
 * @swagger
 * /api/admin/roles/{id}:
 *   put:
 *     summary: Update an existing admin role
 *     description: |
 *       Updates the role name, description, and/or permission assignments.
 *       System roles (isSystem = true) cannot be modified.
 *       When permissionIds is provided, all existing permissions are replaced.
 *       Super admin only. An audit log entry is recorded.
 *     tags: [Admin, Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Role ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: New display name
 *                 example: Senior Content Manager
 *               description:
 *                 type: string
 *                 description: New description
 *               permissionIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Full replacement array of permission IDs
 *                 example:
 *                   - perm_abc123
 *                   - perm_ghi789
 *     responses:
 *       200:
 *         description: Role updated successfully
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
 *                     description:
 *                       type: string
 *                     isSystem:
 *                       type: boolean
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                     _count:
 *                       type: object
 *                       properties:
 *                         users:
 *                           type: integer
 *                     permissions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           permission:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                               key:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                               category:
 *                                 type: string
 *       400:
 *         description: Validation error
 *       403:
 *         description: Cannot modify system roles or super admin access required
 *       404:
 *         description: Role not found
 */
router.put('/:id', requireSuperAdmin, roleController.updateRole);

/**
 * @swagger
 * /api/admin/roles/{id}:
 *   delete:
 *     summary: Delete an admin role
 *     description: |
 *       Permanently deletes a role. System roles cannot be deleted.
 *       Roles that still have assigned users cannot be deleted —
 *       reassign those users first. Super admin only.
 *       An audit log entry is recorded.
 *     tags: [Admin, Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Role ID
 *     responses:
 *       200:
 *         description: Role deleted successfully
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
 *                   example: Role "content_manager" deleted
 *       400:
 *         description: Role still has users assigned
 *       403:
 *         description: Cannot delete system roles or super admin access required
 *       404:
 *         description: Role not found
 */
router.delete('/:id', requireSuperAdmin, roleController.deleteRole);

module.exports = router;
