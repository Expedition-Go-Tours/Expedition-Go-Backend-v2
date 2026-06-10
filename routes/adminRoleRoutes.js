const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission, requireSuperAdmin } = require('../middleware/permissionMiddleware');
const roleController = require('../controllers/adminRoleController');

const router = express.Router();

router.use(protect, restrictTo('admin'));

router.get('/permissions', requirePermission('roles.manage'), roleController.getPermissions);

router.get('/', requirePermission('roles.manage'), roleController.getRoles);
router.get('/:id', requirePermission('roles.manage'), roleController.getRole);
router.post('/', requireSuperAdmin, roleController.createRole);
router.put('/:id', requireSuperAdmin, roleController.updateRole);
router.delete('/:id', requireSuperAdmin, roleController.deleteRole);

module.exports = router;
