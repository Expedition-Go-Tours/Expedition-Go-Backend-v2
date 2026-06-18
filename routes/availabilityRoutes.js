const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const availabilityController = require('../controllers/availabilityController');

const router = express.Router();

router.get('/availability/public/:tourId', availabilityController.getPublicAvailability);

router.use(protect);

router.get('/:tourId/availability', resolveSupplier, requireTeamPermission('tours.view', 'bookings.view'), availabilityController.getAvailability);
router.patch('/:tourId/availability/:date', resolveSupplier, requireTeamPermission('tours.update'), availabilityController.updateDateAvailability);
router.delete('/:tourId/availability/:date', resolveSupplier, requireTeamPermission('tours.update'), availabilityController.removeDateOverride);
router.post('/:tourId/availability/batch', resolveSupplier, requireTeamPermission('tours.update'), availabilityController.batchUpdateAvailability);

module.exports = router;
