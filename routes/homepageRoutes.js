/**
 * Homepage Routes
 *
 * Public endpoints (no auth required) for homepage sections.
 * Authenticated users get personalized results; anonymous users
 * get popularity-based defaults.
 *
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();
const homepageController = require('../controllers/homepageController');
const { optionalAuth } = require('../middleware/authMiddleware');

// All routes use optionalAuth — authenticated users get personalized results,
// anonymous users get popularity-based defaults.
router.get('/sell-out', optionalAuth, homepageController.getSellOut);
router.get('/top-rated', optionalAuth, homepageController.getTopRated);
router.get('/trending', optionalAuth, homepageController.getTrending);
router.get('/recommended', optionalAuth, homepageController.getRecommended);
router.get('/new', optionalAuth, homepageController.getNew);
router.get('/attractions', optionalAuth, homepageController.getAttractions);
router.get('/mood', optionalAuth, homepageController.getMood);
router.get('/destinations', optionalAuth, homepageController.getDestinations);
router.get('/', optionalAuth, homepageController.getHomepage);

module.exports = router;
