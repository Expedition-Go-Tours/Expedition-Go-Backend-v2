const express = require('express');
const { createLimiter } = require('../middleware/dynamicRateLimiter');
const locationController = require('../src/core/domain/locationController');

const router = express.Router();

const locationLimiter = createLimiter({
  name: 'location',
  defaultMax: 120,
  defaultWindowMs: 60 * 1000,
  skip: (req) => req.method === 'OPTIONS',
  message: { status: 'fail', message: 'Too many location requests, please try again later.' },
});

router.use(locationLimiter);

router.get('/search', locationController.search);
router.get('/autocomplete', locationController.autocomplete);
// SerpApi Google Maps fallback — an explicit, credit-charged search the UI
// offers only when the free providers found nothing. Key stays server-side.
router.get('/google-search', locationController.googleSearch);
router.get('/reverse', locationController.reverse);
router.get('/nearby', locationController.nearby);
router.get('/my-location', locationController.myLocation);
router.get('/resolve', locationController.resolveLocation);

module.exports = router;
