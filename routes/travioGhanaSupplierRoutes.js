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
const { resolveSupplier, requireTeamRole, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const ghanaSupplier = require('../controllers/travioGhanaSupplierController');

// Shared controllers for proxied endpoints
const supplierSettingsController = require('../controllers/supplierSettingsController');
const cancellationController = require('../controllers/cancellationController');
const teamController = require('../controllers/teamController');
const bookingController = require('../controllers/bookingController');

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
router.get('/settings/business-profile', resolveSupplier, supplierSettingsController.getBusinessProfile);
router.patch('/settings/business-profile', resolveSupplier, requireTeamRole('admin', 'editor'), supplierSettingsController.updateBusinessProfile);
router.get('/settings/notification-preferences', resolveSupplier, supplierSettingsController.getNotificationPreferences);
router.put('/settings/notification-preferences', resolveSupplier, requireTeamRole('admin'), supplierSettingsController.updateNotificationPreferences);
router.get('/settings/tax-info', resolveSupplier, supplierSettingsController.getTaxInfo);
router.patch('/settings/tax-info', resolveSupplier, requireTeamRole('admin', 'finance'), supplierSettingsController.updateTaxInfo);
router.get('/settings/booking-rules', resolveSupplier, supplierSettingsController.getBookingRules);
router.put('/settings/booking-rules', resolveSupplier, requireTeamRole('admin', 'editor'), supplierSettingsController.updateBookingRules);

// Team (proxied to shared controller)
router.get('/settings/team/invite/:token', teamController.getInviteDetails);
router.get('/settings/team/my-role', resolveSupplier, teamController.getMyTeamRole);
router.get('/settings/team/members', resolveSupplier, requireTeamRole('admin'), teamController.getMembers);
router.post('/settings/team/invite', resolveSupplier, requireTeamRole('admin'), teamController.inviteMember);
router.post('/settings/team/invite/resend', resolveSupplier, requireTeamRole('admin'), teamController.resendInvite);
router.post('/settings/team/invite/:token/accept', teamController.acceptInvite);
router.post('/settings/team/invite/:token/decline', teamController.declineInvite);
router.post('/settings/team/direct-add', resolveSupplier, requireTeamRole('admin'), teamController.directAddMember);
router.patch('/settings/team/members/:id/role', resolveSupplier, requireTeamRole('admin'), teamController.updateMemberRole);
router.delete('/settings/team/members/:id', resolveSupplier, requireTeamRole('admin'), teamController.removeMember);

// Special Offers
router.get('/special-offers', ghanaSupplier.getSpecialOffers);

// Cancellation (proxied to shared controller)
router.get('/cancellation/summary', resolveSupplier, cancellationController.getCancellationSummary);
router.get('/cancellation/records', resolveSupplier, cancellationController.getCancellationRecords);

// Pickup planner (proxied to shared bookingController — the frontend rewrites
// /bookings/supplier/pickup-planner to this Ghana namespace)
router.get('/pickup-planner', resolveSupplier, requireTeamPermission('bookings.view'), bookingController.getPickupPlanner);
router.patch('/pickup-planner/:id', resolveSupplier, requireTeamPermission('bookings.manage'), bookingController.updateBookingPickup);

// Finance
router.get('/finance/summary', ghanaSupplier.getFinanceSummary);
router.get('/payouts', ghanaSupplier.getPayouts);

// Notifications
router.get('/notifications', ghanaSupplier.getNotifications);

module.exports = router;
