const express = require('express');
const rateLimit = require('express-rate-limit');
const locationController = require('../controllers/locationController');

const router = express.Router();

const locationLimiter = rateLimit({
  max: 60,
  windowMs: 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  message: { status: 'fail', message: 'Too many location requests, please try again later.' },
});

router.use(locationLimiter);

router.get('/search', locationController.search);
router.get('/autocomplete', locationController.autocomplete);
router.get('/reverse', locationController.reverse);
router.get('/nearby', locationController.nearby);

module.exports = router;
