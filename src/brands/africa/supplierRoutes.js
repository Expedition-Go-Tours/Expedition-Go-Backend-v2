/**
 * TravioAfrica Supplier Routes — Africa-Scoped Supplier Dashboard
 *
 * Mounted at /api/travioafrica/supplier/*
 * Every route requires: protect + supplier access (owner OR accepted team
 * member — see resolveSupplier). Team invitations are the exception: an invitee
 * is still a plain account until they accept, so those routes only need
 * `protect`.
 *
 * Africa-specific endpoints use travioAfricaSupplierController.
 * Shared features (team, cancellation, settings sub-routes, finance, payouts)
 * proxy to the shared controllers — no code duplication (same as Ghana).
 */

const express = require('express');
const { protect } = require('../../../middleware/authMiddleware');
const { resolveSupplier, requireTeamRole, requireTeamPermission } = require('../../../middleware/teamRoleMiddleware');
const africaSupplier = require('./supplierController');

// Shared controllers for proxied endpoints
const supplierSettingsController = require('../../core/domain/supplierSettingsController');
const cancellationController = require('../../core/domain/cancellationController');
const teamController = require('../../core/domain/teamController');
const bookingController = require('../../core/domain/bookingController');
const financeController = require('../../core/domain/financeController');
const payoutMethodController = require('../../core/domain/payoutMethodController');
const specialOfferController = require('../../core/domain/specialOfferController');
const notificationController = require('../../core/domain/notificationController');

const router = express.Router();

// ── Team invitations (pre-membership) ───────────────────────────────────────
// An invitee holds `roles: ['customer']` (the signup default) until they
// accept, when acceptInvite grants supplier access. These four must therefore
// sit BEFORE the supplier-access guard below — behind `restrictTo('supplier')`
// every invite failed with 403 and the team feature could never complete.
router.get('/settings/team/invite/:token', protect, teamController.getInviteDetails);
router.post('/settings/team/invite/:token/accept', protect, teamController.acceptInvite);
router.post('/settings/team/invite/:token/decline', protect, teamController.declineInvite);
router.get('/settings/team/my-role', protect, teamController.getMyTeamRole);

// ── Everything below is supplier-scoped ────────────────────────────────────
// resolveSupplier accepts the owner or an accepted team member and sets
// req.supplierId to the owning supplier (see the Ghana router for details).
router.use(protect, resolveSupplier);

// Dashboard
router.get('/dashboard', africaSupplier.getDashboard);
router.get('/monthly-revenue', africaSupplier.getMonthlyRevenue);

// Tours
router.get('/tours', africaSupplier.getSupplierTours);

// Reviews
router.get('/reviews', africaSupplier.getSupplierReviews);

// Availability
router.get('/availability/:tourId', africaSupplier.getAvailability);
router.post('/availability/:tourId', requireTeamPermission('tours.update'), africaSupplier.setAvailability);

// Settings (Africa-scoped)
router.get('/settings', africaSupplier.getSettings);
router.patch('/settings', requireTeamRole('admin'), africaSupplier.updateSettings);

// Settings sub-routes (proxied to shared controllers)
router.get('/settings/business-profile', resolveSupplier, supplierSettingsController.getBusinessProfile);
router.patch('/settings/business-profile', resolveSupplier, requireTeamPermission('settings.business'), supplierSettingsController.updateBusinessProfile);
router.get('/settings/notification-preferences', resolveSupplier, supplierSettingsController.getNotificationPreferences);
router.put('/settings/notification-preferences', resolveSupplier, requireTeamPermission('settings.manage'), supplierSettingsController.updateNotificationPreferences);

// Additional notification email addresses (email delivery only — not logins)
router.get('/settings/notification-recipients', resolveSupplier, supplierSettingsController.listNotificationRecipients);
router.post('/settings/notification-recipients', resolveSupplier, requireTeamPermission('settings.manage'), supplierSettingsController.addNotificationRecipient);
router.post('/settings/notification-recipients/:id/resend', resolveSupplier, requireTeamPermission('settings.manage'), supplierSettingsController.resendNotificationRecipient);
router.patch('/settings/notification-recipients/:id', resolveSupplier, requireTeamPermission('settings.manage'), supplierSettingsController.updateNotificationRecipient);
router.delete('/settings/notification-recipients/:id', resolveSupplier, requireTeamPermission('settings.manage'), supplierSettingsController.removeNotificationRecipient);
router.get('/settings/tax-info', resolveSupplier, supplierSettingsController.getTaxInfo);
router.patch('/settings/tax-info', resolveSupplier, requireTeamPermission('settings.tax'), supplierSettingsController.updateTaxInfo);
router.get('/settings/booking-rules', resolveSupplier, supplierSettingsController.getBookingRules);
router.put('/settings/booking-rules', resolveSupplier, requireTeamRole('admin', 'editor'), supplierSettingsController.updateBookingRules);

// Team (proxied to shared controller). Invite accept/decline/details and
// my-role are declared above the supplier-access guard.
router.get('/settings/team/members', requireTeamRole('admin'), teamController.getMembers);
router.post('/settings/team/invite', requireTeamRole('admin'), teamController.inviteMember);
router.post('/settings/team/invite/resend', requireTeamRole('admin'), teamController.resendInvite);
router.post('/settings/team/direct-add', requireTeamRole('admin'), teamController.directAddMember);
router.patch('/settings/team/members/:id/role', requireTeamRole('admin'), teamController.updateMemberRole);
router.delete('/settings/team/members/:id', requireTeamRole('admin'), teamController.removeMember);
router.delete('/settings/team/invite/:memberId', requireTeamRole('admin'), teamController.revokeInvite);

// Special Offers (GET is Africa-scoped; CRUD proxies to shared controller)
router.get('/special-offers', africaSupplier.getSpecialOffers);
router.get('/special-offers/:id', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.getOffer);
router.post('/special-offers', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.createOffer);
router.put('/special-offers/:id', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.updateOffer);
router.patch('/special-offers/:id/toggle', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.toggleOffer);
router.delete('/special-offers/:id', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.deleteOffer);

// Cancellation (proxied to shared controller)
router.get('/cancellation/summary', resolveSupplier, cancellationController.getCancellationSummary);
router.get('/cancellation/records', resolveSupplier, cancellationController.getCancellationRecords);
router.get('/products/list', resolveSupplier, cancellationController.getCancellationProducts);

// Pickup planner (proxied to shared bookingController)
router.get('/pickup-planner', resolveSupplier, requireTeamPermission('bookings.view'), bookingController.getPickupPlanner);
router.patch('/pickup-planner/:id', resolveSupplier, requireTeamPermission('bookings.manage'), bookingController.updateBookingPickup);

// Finance (proxied to shared controller)
router.get('/finance/summary', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getFinanceSummary);
router.get('/finance/charges', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getSupplierCharges);
router.get('/finance/earnings', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getEarnings);
router.get('/finance/payouts/requests', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getPayoutRequests);
router.post('/finance/payout/request', resolveSupplier, requireTeamPermission('payouts.request'), financeController.createPayoutRequest);
router.patch('/finance/payouts/requests/:id/cancel', resolveSupplier, requireTeamPermission('payouts.request'), financeController.cancelPayoutRequest);
router.get('/finance/disputes', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getDisputes);
router.get('/payouts', requireTeamPermission('payouts.view'), africaSupplier.getPayouts);

// Payout methods (proxied to shared controller)
router.get('/payout-methods', resolveSupplier, requireTeamPermission('payout-methods.view'), payoutMethodController.getMyMethods);
router.post('/payout-methods', resolveSupplier, requireTeamPermission('payout-methods.manage'), payoutMethodController.addMethod);
router.patch('/payout-methods/:id', resolveSupplier, requireTeamPermission('payout-methods.manage'), payoutMethodController.updateMethod);
router.delete('/payout-methods/:id', resolveSupplier, requireTeamPermission('payout-methods.manage'), payoutMethodController.deleteMethod);

// Notifications (GET is Africa-scoped; read/delete proxy to shared controller)
router.get('/notifications', africaSupplier.getNotifications);
router.patch('/notifications/:id/read', notificationController.markAsRead);
router.patch('/notifications/mark-all-read', notificationController.markAllAsRead);
router.delete('/notifications/:id', notificationController.deleteNotification);

module.exports = router;
