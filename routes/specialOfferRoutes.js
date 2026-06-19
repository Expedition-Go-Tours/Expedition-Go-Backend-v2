const express = require('express');
const router = express.Router();
const specialOfferController = require('../controllers/specialOfferController');
const { protect } = require('../middleware/authMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');

router.use(protect, resolveSupplier, requireTeamPermission('tours', 'manage'));

router.get('/', specialOfferController.getOffers);
router.post('/', specialOfferController.createOffer);
router.get('/:id', specialOfferController.getOffer);
router.put('/:id', specialOfferController.updateOffer);
router.delete('/:id', specialOfferController.deleteOffer);
router.patch('/:id/toggle', specialOfferController.toggleOffer);

module.exports = router;
