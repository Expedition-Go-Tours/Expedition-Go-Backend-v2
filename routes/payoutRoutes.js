const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const payoutController = require('../controllers/payoutController');

const router = express.Router();

router.use(protect);

// ── Supplier routes ──
router.get('/me', restrictTo('supplier'), payoutController.getMyPayouts);

// ── Admin routes ──
router.get('/admin', restrictTo('admin'), payoutController.getAllPayouts);
router.get('/admin/summary', restrictTo('admin'), payoutController.getPayoutSummary);
router.patch('/admin/:id/approve', restrictTo('admin'), payoutController.approvePayout);
router.patch('/admin/:id/release', restrictTo('admin'), payoutController.releasePayout);
router.patch('/admin/:id/fail', restrictTo('admin'), payoutController.failPayout);

module.exports = router;
