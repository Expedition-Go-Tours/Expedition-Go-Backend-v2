const express = require('express');
const { requireServiceToken } = require('../middleware/serviceToken');
const { createLimiter } = require('../middleware/dynamicRateLimiter');
const { syncExternalReviews } = require('../controllers/externalReviewController');

const router = express.Router();

// A scraper runs at most a few times a day; cap generously but bounded so a
// leaked token can't be used to hammer the endpoint.
const syncLimiter = createLimiter({
  name: 'externalReviewsSync',
  defaultMax: 30,
  defaultWindowMs: 60 * 60 * 1000,
  message: 'Too many external review sync requests, please try again later.',
});

/**
 * POST /api/admin/external-reviews/sync
 *
 * Called by the storefront's daily `sync-reviews` GitHub Action with a bearer
 * token (EXTERNAL_REVIEWS_SYNC_TOKEN). Mounted ahead of the admin router so it
 * is guarded by the service token rather than an admin JWT.
 */
router.post('/sync', syncLimiter, requireServiceToken('EXTERNAL_REVIEWS_SYNC_TOKEN'), syncExternalReviews);

module.exports = router;
