const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const availabilityController = require('../controllers/availabilityController');

const router = express.Router();

router.use(protect);

router.get('/:tourId/availability', restrictTo('supplier'), availabilityController.getAvailability);
router.patch('/:tourId/availability/:date', restrictTo('supplier'), availabilityController.updateDateAvailability);
router.delete('/:tourId/availability/:date', restrictTo('supplier'), availabilityController.removeDateOverride);
router.post('/:tourId/availability/batch', restrictTo('supplier'), availabilityController.batchUpdateAvailability);

module.exports = router;
