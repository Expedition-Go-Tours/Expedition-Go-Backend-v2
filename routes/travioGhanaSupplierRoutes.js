/**
 * TravioGhana Supplier Routes — Ghana-Scoped Supplier Dashboard
 *
 * Mounted at /api/travioghana/supplier/*
 * Every route requires: protect + restrictTo('supplier')
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const ghanaSupplier = require('../controllers/travioGhanaSupplierController');

const router = express.Router();

// All supplier routes require authentication + supplier role
router.use(protect, restrictTo('supplier'));

// Dashboard
router.get('/dashboard', ghanaSupplier.getDashboard);
router.get('/monthly-revenue', ghanaSupplier.getMonthlyRevenue);

// Tours
router.get('/tours', ghanaSupplier.getSupplierTours);

// Reviews
router.get('/reviews', ghanaSupplier.getSupplierReviews);

// Availability
router.get('/availability/:tourId', ghanaSupplier.getAvailability);
router.post('/availability/:tourId', ghanaSupplier.setAvailability);

// Settings
router.get('/settings', ghanaSupplier.getSettings);
router.patch('/settings', ghanaSupplier.updateSettings);

// Special Offers
router.get('/special-offers', ghanaSupplier.getSpecialOffers);

// Finance
router.get('/finance/summary', ghanaSupplier.getFinanceSummary);
router.get('/payouts', ghanaSupplier.getPayouts);

// Notifications
router.get('/notifications', ghanaSupplier.getNotifications);

module.exports = router;
