/**
 * TravioGhana Supplier Routes — Ghana-Scoped Supplier Dashboard
 *
 * Mounted at /api/travioghana/supplier/*
 * Every route requires: protect + supplier access (owner OR accepted team
 * member — see resolveSupplier). Team invitations are the exception: an invitee
 * is still a plain account until they accept, so those routes only need
 * `protect`.
 *
 * Ghana-specific endpoints use travioGhanaSupplierController.
 * Shared features (team, cancellation, settings sub-routes) proxy to
 * the shared controllers — no code duplication.
 */

const express = require('express');
const { protect } = require('../../../middleware/authMiddleware');
const validate = require('../../../middleware/validate');
const { supplierUpdatePickupSchema, pickupReorderSchema } = require('../../core/services/expeditionValidation');
const { resolveSupplier, requireTeamRole, requireTeamPermission } = require('../../../middleware/teamRoleMiddleware');
const ghanaSupplier = require('./supplierController');

// Shared controllers for proxied endpoints
const supplierSettingsController = require('../../core/domain/supplierSettingsController');
const cancellationController = require('../../core/domain/cancellationController');
const teamController = require('../../core/domain/teamController');
const bookingController = require('../../core/domain/bookingController');
const supplierBookingController = require('../../core/domain/supplierBookingController');
const {
  quoteSupplierBookingSchema,
  createSupplierBookingSchema,
  recordCollectionSchema,
  supplierBookingParamsSchema,
} = require('../../core/services/travioGhanaValidation');
const financeController = require('../../core/domain/financeController');
const payoutMethodController = require('../../core/domain/payoutMethodController');
const specialOfferController = require('../../core/domain/specialOfferController');
const notificationController = require('../../core/domain/notificationController');
const staysRoutes = require('./staysRoutes');

const router = express.Router();

// ── Team invitations (pre-membership) ───────────────────────────────────────
// An invitee holds `roles: ['customer']` (the signup default) until they
// accept, when acceptInvite grants supplier access. These four must therefore
// sit BEFORE the supplier-access guard below — behind `restrictTo('supplier')`
// every invite failed with 403 and the team feature could never complete.
// `protect` is enough: the token is the secret, and the controller enforces
// that the signed-in email matches the invited one.
router.get('/settings/team/invite/:token', protect, teamController.getInviteDetails);
router.post('/settings/team/invite/:token/accept', protect, teamController.acceptInvite);
router.post('/settings/team/invite/:token/decline', protect, teamController.declineInvite);
// Membership discovery: owner → admin, member → their role, stranger → null.
router.get('/settings/team/my-role', protect, teamController.getMyTeamRole);

// ── Everything below is supplier-scoped ────────────────────────────────────
// resolveSupplier accepts the owner or an accepted team member and sets
// req.supplierId to the owning supplier, so member calls read/write the
// supplier's data instead of their own (previously req.user.id was assumed to
// be the supplier, which made every member-scoped query return nothing).
router.use(protect, resolveSupplier);

// Stays workspace (properties, builder, rates, availability). The child router
// declares its own stays.* permissions and inherits supplier scoping above.
router.use('/stays', staysRoutes);

// Dashboard
router.get('/dashboard', ghanaSupplier.getDashboard);
router.get('/monthly-revenue', ghanaSupplier.getMonthlyRevenue);

// Tours
router.get('/tours', ghanaSupplier.getSupplierTours);

// Reviews
router.get('/reviews', ghanaSupplier.getSupplierReviews);

// Availability
router.get('/availability/:tourId', ghanaSupplier.getAvailability);
router.post('/availability/:tourId', requireTeamPermission('tours.update'), ghanaSupplier.setAvailability);

// Settings (Ghana-scoped)
router.get('/settings', ghanaSupplier.getSettings);
router.patch('/settings', requireTeamRole('admin'), ghanaSupplier.updateSettings);

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

// Special Offers (GET is Ghana-scoped; CRUD proxies to shared controller —
// the frontend rewrites /suppliers/special-offers/* to this namespace)
router.get('/special-offers', ghanaSupplier.getSpecialOffers);
router.get('/special-offers/:id', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.getOffer);
router.post('/special-offers', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.createOffer);
router.put('/special-offers/:id', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.updateOffer);
router.patch('/special-offers/:id/toggle', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.toggleOffer);
router.delete('/special-offers/:id', resolveSupplier, requireTeamPermission('products.update'), specialOfferController.deleteOffer);

// Cancellation (proxied to shared controller)
router.get('/cancellation/summary', resolveSupplier, cancellationController.getCancellationSummary);
router.get('/cancellation/records', resolveSupplier, cancellationController.getCancellationRecords);
router.get('/products/list', resolveSupplier, cancellationController.getCancellationProducts);

// Pickup planner (proxied to shared bookingController — the frontend rewrites
// /bookings/supplier/pickup-planner to this Ghana namespace)
// ── Supplier-created bookings (walk-ins, offline collection) ────────────────
// Feature-flagged SERVER-SIDE: when it is off, every route here 403s — hiding
// the button is not a control. `bookings.manage` gates creation and money;
// `bookings.view` gates reading the collection history.
//
// Note on routing: the shared router mounted at /api/travioghana owns
// /supplier/bookings* and is registered first, so anything it declares wins;
// these paths are declared only here and fall through to this router.
router.post('/bookings', resolveSupplier, requireTeamPermission('bookings.manage'), validate(createSupplierBookingSchema), supplierBookingController.create);
router.post('/bookings/quote', resolveSupplier, requireTeamPermission('bookings.manage'), validate(quoteSupplierBookingSchema), supplierBookingController.quote);
router.get('/bookings/:id/collections', resolveSupplier, requireTeamPermission('bookings.view'), validate(supplierBookingParamsSchema), supplierBookingController.collections);
router.post('/bookings/:id/collections', resolveSupplier, requireTeamPermission('bookings.manage'), validate(recordCollectionSchema), supplierBookingController.recordCollection);
router.post('/bookings/:id/refunds', resolveSupplier, requireTeamPermission('bookings.manage'), validate(recordCollectionSchema), supplierBookingController.recordOfflineRefund);

// Commission cover — the supplier's available balance, which the "Create
// booking" button gates on. Declared under /finance because /bookings/cover
// would be swallowed by the shared router's earlier `/supplier/bookings/:id`
// route, and because the figure it returns is a finance number: what the
// platform is holding for this supplier, per currency, against the commission
// a supplier-created booking would raise. `bookings.view` rather than
// `payouts.view` — it drives a bookings action.
router.get('/finance/commission-cover', resolveSupplier, requireTeamPermission('bookings.view'), supplierBookingController.cover);

router.get('/pickup-planner', resolveSupplier, requireTeamPermission('bookings.view'), bookingController.getPickupPlanner);
router.patch('/pickup-planner/reorder', resolveSupplier, requireTeamPermission('bookings.manage'), validate(pickupReorderSchema), bookingController.reorderPickupStops);
router.patch('/pickup-planner/:id', resolveSupplier, requireTeamPermission('bookings.manage'), validate(supplierUpdatePickupSchema), bookingController.updateBookingPickup);

// Finance (all proxied to shared controller — matches the finance page's
// expected response shapes; the old Ghana-specific summary returned a flat
// shape the frontend couldn't read, so everything showed $0)
router.get('/finance/summary', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getFinanceSummary);
router.get('/finance/invoices', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getMyInvoices);
router.get('/finance/invoices/:id', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getInvoiceById);
router.get('/finance/invoices/:id/pdf', resolveSupplier, requireTeamPermission('payouts.view'), financeController.downloadInvoicePdf);
router.get('/finance/charges', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getSupplierCharges);
router.get('/finance/earnings', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getEarnings);
router.get('/finance/payouts/requests', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getPayoutRequests);
router.post('/finance/payout/request', resolveSupplier, requireTeamPermission('payouts.request'), financeController.createPayoutRequest);
router.patch('/finance/payouts/requests/:id/cancel', resolveSupplier, requireTeamPermission('payouts.request'), financeController.cancelPayoutRequest);
router.get('/finance/disputes', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getDisputes);
router.get('/finance/payout-settings', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getPayoutSettings);
router.patch('/finance/payout-settings', resolveSupplier, requireTeamPermission('payouts.request'), financeController.updatePayoutSettings);
router.get('/payouts', requireTeamPermission('payouts.view'), ghanaSupplier.getPayouts);

// Payout methods (proxied to shared controller — frontend rewrites /payout-methods/* here)
router.get('/payout-methods', resolveSupplier, requireTeamPermission('payout-methods.view'), payoutMethodController.getMyMethods);
router.post('/payout-methods', resolveSupplier, requireTeamPermission('payout-methods.manage'), payoutMethodController.addMethod);
router.patch('/payout-methods/:id', resolveSupplier, requireTeamPermission('payout-methods.manage'), payoutMethodController.updateMethod);
router.delete('/payout-methods/:id', resolveSupplier, requireTeamPermission('payout-methods.manage'), payoutMethodController.deleteMethod);

// Notifications (GET is Ghana-scoped; read/delete proxy to shared controller)
router.get('/notifications', ghanaSupplier.getNotifications);
router.patch('/notifications/:id/read', notificationController.markAsRead);
router.patch('/notifications/mark-all-read', notificationController.markAllAsRead);
router.delete('/notifications/:id', notificationController.deleteNotification);

module.exports = router;
