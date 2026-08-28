/**
 * TravioGhana Supplier Routes — Ghana-Scoped Supplier Dashboard
 *
 * Mounted at /api/travioghana/supplier/*
 * Every route requires: protect + restrictTo('supplier')
 *
 * Ghana-specific endpoints use travioGhanaSupplierController.
 * Shared features (team, cancellation, settings sub-routes) proxy to
 * the shared controllers — no code duplication.
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { resolveSupplier } = require('../middleware/teamRoleMiddleware');
const ghanaSupplier = require('../controllers/travioGhanaSupplierController');

// Shared controllers for proxied endpoints
const supplierSettingsController = require('../controllers/supplierSettingsController');
const cancellationController = require('../controllers/cancellationController');
const teamController = require('../controllers/teamController');

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

// Settings (Ghana-scoped)
router.get('/settings', ghanaSupplier.getSettings);
router.patch('/settings', ghanaSupplier.updateSettings);

// Settings sub-routes (proxied to shared controllers)
router.get('/settings/notification-preferences', resolveSupplier, supplierSettingsController.getNotificationPreferences);
router.patch('/settings/notification-preferences', resolveSupplier, supplierSettingsController.updateNotificationPreferences);
router.get('/settings/tax-info', resolveSupplier, supplierSettingsController.getTaxInfo);
router.patch('/settings/tax-info', resolveSupplier, supplierSettingsController.updateTaxInfo);
router.get('/settings/booking-rules', resolveSupplier, supplierSettingsController.getBookingRules);
router.patch('/settings/booking-rules', resolveSupplier, supplierSettingsController.updateBookingRules);

// Team (proxied to shared controller)
router.get('/settings/team/my-role', resolveSupplier, teamController.getMyTeamRole);
router.get('/settings/team/members', resolveSupplier, teamController.getMembers);
router.post('/settings/team/invite', resolveSupplier, teamController.inviteMember);
router.patch('/settings/team/members/:id', resolveSupplier, teamController.updateMemberRole);
router.delete('/settings/team/members/:id', resolveSupplier, teamController.removeMember);

// Special Offers
router.get('/special-offers', ghanaSupplier.getSpecialOffers);

// Cancellation (proxied to shared controller)
router.get('/cancellation/summary', resolveSupplier, cancellationController.getCancellationSummary);
router.get('/cancellation/records', resolveSupplier, cancellationController.getCancellationRecords);

// Finance
router.get('/finance/summary', ghanaSupplier.getFinanceSummary);
router.get('/payouts', ghanaSupplier.getPayouts);

// Notifications
router.get('/notifications', ghanaSupplier.getNotifications);

module.exports = router;
