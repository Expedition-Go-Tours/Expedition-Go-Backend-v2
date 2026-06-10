const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission, requireSuperAdmin } = require('../middleware/permissionMiddleware');
const settingsController = require('../controllers/adminSettingsController');

const router = express.Router();

router.use(protect, restrictTo('admin'));

router.get('/', requirePermission('settings.access'), settingsController.getSettings);
router.put('/', requireSuperAdmin, settingsController.updateSettings);
router.get('/:key', requirePermission('settings.access'), settingsController.getSetting);

module.exports = router;
