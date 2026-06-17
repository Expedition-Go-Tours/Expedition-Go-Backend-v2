const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const adminSystemController = require('../controllers/adminSystemController');

const router = express.Router();

router.use(protect, restrictTo('admin'));

router.get('/health', adminSystemController.getSystemHealth);
router.post('/cache/clear', adminSystemController.clearSystemCache);

module.exports = router;