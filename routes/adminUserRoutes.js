const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission, requireSuperAdmin } = require('../middleware/permissionMiddleware');
const adminUserController = require('../controllers/adminUserController');

const router = express.Router();

router.use(protect, restrictTo('admin'));

router.get('/', requirePermission('roles.manage'), adminUserController.getAdminUsers);
router.post('/', requireSuperAdmin, adminUserController.addAdmin);
router.patch('/:id/role', requireSuperAdmin, adminUserController.updateAdminRole);
router.delete('/:id/revoke', requireSuperAdmin, adminUserController.revokeAdmin);

module.exports = router;
