const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const payoutMethodController = require('../controllers/payoutMethodController');

const router = express.Router();

router.use(protect);

// ── Supplier routes ──
router.get('/me', restrictTo('supplier'), payoutMethodController.getMyMethods);
router.post('/', restrictTo('supplier'), payoutMethodController.addMethod);
router.patch('/:id', restrictTo('supplier'), payoutMethodController.updateMethod);
router.delete('/:id', restrictTo('supplier'), payoutMethodController.deleteMethod);

// ── Admin routes ──
router.get('/admin/suppliers/:supplierId', restrictTo('admin'), payoutMethodController.getSupplierMethods);
router.get('/admin', restrictTo('admin'), payoutMethodController.getAllSuppliersMethods);

module.exports = router;
