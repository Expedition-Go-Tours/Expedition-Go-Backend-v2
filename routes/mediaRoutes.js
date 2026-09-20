const router = require('express').Router();
const mediaController = require('../src/core/domain/mediaController');
const { protect } = require('../middleware/authMiddleware');

router.delete('/cleanup', protect, mediaController.cleanupPending);

router.delete('/cleanup-orphaned', protect, mediaController.cleanupOrphaned);

module.exports = router;
