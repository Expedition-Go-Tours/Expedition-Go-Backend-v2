const express = require('express');
const { createLimiter } = require('../middleware/dynamicRateLimiter');
const locationController = require('../controllers/locationController');

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
router.get('/reverse', locationController.reverse);
router.get('/nearby', locationController.nearby);

module.exports = router;
