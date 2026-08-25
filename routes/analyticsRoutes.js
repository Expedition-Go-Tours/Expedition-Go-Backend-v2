/**
 * Analytics Routes
 *
 * Frontend-initiated event tracking endpoints.
 * No auth required — events are tracked by session ID for anonymous users.
 *
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { optionalAuth } = require('../middleware/authMiddleware');

router.post('/event', optionalAuth, analyticsController.trackEvent);
router.post('/batch', optionalAuth, analyticsController.trackBatch);

module.exports = router;
