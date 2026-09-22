/**
 * Travio Africa Admin Routes — Africa-Isolated Admin API
 *
 * Mounted at /api/travioafrica/admin/*
 *
 * Mirrors travioGhanaAdminRoutes.js. Route paths match what the frontend
 * interceptor sends (/admin/* → /travioafrica/admin/*, etc.).
 *
 * Unlike Ghana, Travio Africa has NO Expedition sub-store, so the Expedition
 * management routes (/tours/:tourId/expedition-publish, /expedition/*,
 * /suppliers/:id/expedition-role) are intentionally absent.
 */

const express = require('express');
const { protect, restrictTo } = require('../../../middleware/authMiddleware');
const { requirePermission } = require('../../../middleware/permissionMiddleware');
const { createLimiter } = require('../../../middleware/dynamicRateLimiter');
const { attachBrand } = require('../../../middleware/brandContext');

const africa = require('./adminController');
const adminController = require('../../core/domain/adminController');
const cancellationRequestController = require('../../core/domain/cancellationRequestController');
const adminAiController = require('../../core/domain/adminAiController');
const verificationController = require('../../core/domain/supplierVerificationController');

// Shared platform controllers (proxied — same data, same permissions)
const adminSettingsController = require('../../core/domain/adminSettingsController');
const adminFinanceController = require('../../core/domain/adminFinanceController');
const adminRoleController = require('../../core/domain/adminRoleController');
const adminUserController = require('../../core/domain/adminUserController');
const payoutController = require('../../core/domain/payoutController');
const payoutMethodController = require('../../core/domain/payoutMethodController');
const supplierController = require('../../core/domain/supplierController');
const reviewController = require('../../core/domain/reviewController');
const adminNotifController = require('../../core/domain/adminNotificationController');

const router = express.Router();

const adminLimiter = createLimiter({
  name: 'africa-admin',
  defaultMax: 200,
  defaultWindowMs: 15 * 60 * 1000,
  message: { status: 'fail', message: 'Too many requests from this IP, please try again later.' },
});

// attachBrand scopes shared controllers (chat) to the Africa platform.
router.use(protect, restrictTo('admin'), adminLimiter, attachBrand('africa'));

// SESSION
router.get('/me', africa.getMe);

// ANALYTICS — Africa-scoped
router.get('/analytics/overview', requirePermission('dashboard.*', 'analytics.view'), africa.getOverview);
router.get('/analytics/revenue-trend', requirePermission('analytics.view'), africa.getRevenueTrend);
router.get('/analytics/tour-performance', requirePermission('analytics.view'), africa.getTourPerformance);
router.get('/analytics/user-growth', requirePermission('analytics.view'), africa.getUserGrowth);
router.get('/analytics/funnel', requirePermission('analytics.view'), africa.getFunnel);
router.get('/analytics/clv', requirePermission('analytics.view'), africa.getCLV);
router.get('/analytics/search', requirePermission('analytics.view'), africa.getSearchAnalytics);
router.get('/analytics/cart-abandonment', requirePermission('analytics.view'), africa.getCartAbandonment);

// TOURS — TravioAfricaTour model + shared tour admin endpoints (proxied)
router.get('/tours', requirePermission('tours.view', 'dashboard.*'), africa.getTours);
router.get('/tours/review', requirePermission('tours.view', 'tours.approve'), africa.getTourReviewQueue);
router.get('/tours/search', requirePermission('tours.view'), africa.searchTours);
router.get('/tours/:id', requirePermission('tours.view', 'tours.approve'), africa.getTourDetail);
router.patch('/tours/:id', requirePermission('tours.approve'), africa.updateTour);
router.patch('/tours/:id/review', requirePermission('tours.approve'), africa.reviewTour);
router.delete('/tours/:id', requirePermission('tours.approve'), africa.deleteTour);
router.get('/tours/:id/draft', requirePermission('tours.view', 'tours.approve'), adminController.getTourDraftReview);
router.patch('/tours/:id/draft-review', requirePermission('tours.approve'), adminController.reviewTourDraft);

// BOOKINGS — source = 'TRAVIO_AFRICA' + shared booking endpoints (proxied)
router.get('/bookings', requirePermission('bookings.view', 'dashboard.*'), africa.getBookings);
router.get('/bookings/today', requirePermission('dashboard.bookings', 'dashboard.revenue'), africa.getTodayBookings);
router.get('/bookings/:id', requirePermission('bookings.view', 'dashboard.*'), africa.getBookingById);
router.patch('/bookings/:id/confirm-payment', requirePermission('bookings.confirm-payment', 'dashboard.*'), africa.confirmPayment);
router.post('/bookings/:id/charge-now', requirePermission('bookings.confirm-payment', 'dashboard.*'), adminController.chargePayLaterBooking);

// ══════════════════════════════════════════════════════════════════════════
// CANCELLATION REQUESTS — supplier cancels awaiting admin approval
// (brand-scoped by attachBrand → req.brandKey; same shared controller)
// ══════════════════════════════════════════════════════════════════════════
router.get('/cancellation-requests', requirePermission('bookings.view', 'dashboard.*'), cancellationRequestController.listAdmin);
router.post('/cancellation-requests/batch-approve', requirePermission('cancellations.approve'), cancellationRequestController.batchApprove);
router.get('/cancellation-requests/:id', requirePermission('bookings.view', 'dashboard.*'), cancellationRequestController.getAdminOne);
router.post('/cancellation-requests/:id/approve', requirePermission('cancellations.approve'), cancellationRequestController.approve);
router.post('/cancellation-requests/:id/reject', requirePermission('cancellations.approve'), cancellationRequestController.reject);

// SUPPLIERS — role = 'travioafrica' + shared supplier management (proxied)
router.get('/suppliers', requirePermission('suppliers.view'), africa.getSuppliers);
router.get('/suppliers/applications', requirePermission('suppliers.view'), supplierController.getAllApplications);
router.get('/suppliers/qc-dashboard', requirePermission('suppliers.view'), verificationController.getQcDashboard);
router.get('/suppliers/:id', requirePermission('suppliers.view'), africa.getSupplierDetail);
router.get('/suppliers/:id/profile', requirePermission('suppliers.view'), supplierController.getSupplierProfile);
router.get('/suppliers/:id/tours', requirePermission('suppliers.view'), supplierController.getSupplierTours);
router.get('/suppliers/:id/reviews', requirePermission('suppliers.view'), supplierController.getSupplierReviews);
router.get('/suppliers/:id/analytics', requirePermission('suppliers.view'), supplierController.getSupplierAnalytics);
router.get('/suppliers/:id/verification', requirePermission('suppliers.view'), verificationController.getSupplierVerification);
router.patch('/suppliers/applications/:id/review', requirePermission('suppliers.approve'), supplierController.reviewApplication);
router.patch('/suppliers/:id/suspend', requirePermission('suppliers.approve'), supplierController.suspendSupplier);
router.patch('/suppliers/:id/activate', requirePermission('suppliers.approve'), supplierController.activateSupplier);
router.patch('/suppliers/documents/:docId', requirePermission('suppliers.approve'), verificationController.reviewDocument);
router.patch('/suppliers/vehicles/:vehicleId', requirePermission('suppliers.approve'), verificationController.reviewVehicle);
router.patch('/suppliers/guides/:guideId', requirePermission('suppliers.approve'), verificationController.reviewGuide);

// USERS — role = 'travioafrica' + shared user endpoints (proxied)
router.get('/users/active', requirePermission('users.view'), africa.getActiveUsers);
router.get('/users/new-signups', requirePermission('users.view'), africa.getRecentSignups);
router.get('/users/new', requirePermission('users.view'), africa.getRecentSignups);
router.get('/users/search', requirePermission('users.view'), africa.searchUsers);
router.get('/users/:id', requirePermission('users.view'), adminController.getUser);

// AI PROCESSING
router.get('/ai/status', requirePermission('tours.view'), africa.getAiStatus);
router.get('/ai/failed', requirePermission('tours.view'), africa.getFailedTours);
router.post('/ai/retry', requirePermission('tours.approve'), adminAiController.retryFailed);

// REVIEWS — Africa tours only + shared review moderation (proxied)
router.get('/reviews/pending', requirePermission('reviews.view'), africa.getPendingReviews);
router.patch('/reviews/:id/moderate', requirePermission('reviews.moderate'), africa.moderateReview);
router.patch('/reviews/:id/admin', requirePermission('reviews.moderate'), reviewController.adminUpdateReview);
router.delete('/reviews/:id/admin', requirePermission('reviews.moderate'), reviewController.adminDeleteReview);
router.patch('/reviews/:id/admin/response', requirePermission('reviews.moderate'), reviewController.adminUpdateSupplierResponse);
router.delete('/reviews/:id/admin/response', requirePermission('reviews.moderate'), reviewController.adminDeleteSupplierResponse);

// NOTIFICATIONS — Africa-scoped
// AdminNotification model (not the customer Notification model), scoped to
// everything not tagged Ghana by the shared controller.
router.get('/notifications', adminNotifController.getNotifications);
router.get('/notifications/unread-count', adminNotifController.getUnreadCount);
router.get('/notifications/stats', adminNotifController.getStats);
router.patch('/notifications/:id/acknowledge', adminNotifController.acknowledge);
router.patch('/notifications/acknowledge-all', adminNotifController.acknowledgeAll);

// CHAT — proxied to shared chat controller
const chatController = require('../../core/domain/chatController');
router.get('/chat/conversations', chatController.getConversations);
router.post('/chat/conversations', chatController.getOrCreateConversation);
router.get('/chat/conversations/unread-count', chatController.getUnreadCount);
router.get('/chat/conversations/:id/messages', chatController.getMessages);
router.post('/chat/conversations/:id/messages', chatController.sendMessage);
router.patch('/chat/conversations/:id/read', chatController.markAsRead);
router.put('/chat/conversations/:id/messages/:messageId', chatController.updateMessage);
router.delete('/chat/conversations/:id/messages/:messageId', chatController.deleteMessage);
router.delete('/chat/conversations/:id', chatController.deleteConversation);
router.post('/chat/upload', chatController.uploadImage);
router.get('/chat/admin-support', chatController.getAdminSupport);

// SETTINGS — shared platform endpoint (proxied)
router.get('/settings', requirePermission('settings.access'), adminSettingsController.getSettings);
router.put('/settings', requirePermission('settings.access'), adminSettingsController.updateSettings);
router.get('/settings/:key', requirePermission('settings.access'), adminSettingsController.getSetting);

// AUDIT LOG — shared platform endpoint (proxied)
router.get('/audit-log', requirePermission('settings.access', 'audit.view'), adminSettingsController.getAuditLog);
router.get('/audit-log/export', requirePermission('settings.access', 'audit.view'), adminSettingsController.exportAuditLog);
router.get('/audit-log/stats', requirePermission('settings.access', 'audit.view'), adminSettingsController.getAuditLogStats);
router.get('/audit-log/actions', requirePermission('settings.access', 'audit.view'), adminSettingsController.getAuditActions);
router.get('/audit-log/verify', requirePermission('settings.access', 'audit.view'), adminSettingsController.verifyAuditChain);

// ROLES — shared platform endpoint (proxied)
router.get('/roles', requirePermission('settings.access'), adminRoleController.getRoles);
router.get('/roles/permissions', requirePermission('settings.access'), adminRoleController.getPermissions);
router.post('/roles', requirePermission('settings.access'), adminRoleController.createRole);
router.put('/roles/:id', requirePermission('settings.access'), adminRoleController.updateRole);
router.delete('/roles/:id', requirePermission('settings.access'), adminRoleController.deleteRole);

// ADMINS — shared platform endpoint (proxied)
router.get('/admins', requirePermission('settings.access'), adminUserController.getAdminUsers);
router.post('/admins', requirePermission('settings.access'), adminUserController.addAdmin);
router.patch('/admins/:userId/role', requirePermission('settings.access'), adminUserController.updateAdminRole);
router.delete('/admins/:userId/revoke', requirePermission('settings.access'), adminUserController.revokeAdmin);

// FINANCE — shared platform endpoints (proxied)
router.get('/finance/payout-requests', requirePermission('payouts.view', 'dashboard.*'), adminFinanceController.getPayoutRequests);
router.get('/finance/payout-requests/:id', requirePermission('payouts.view', 'dashboard.*'), adminFinanceController.getPayoutRequestById);
router.patch('/finance/payout-requests/:id/approve', requirePermission('payouts.approve'), adminFinanceController.approvePayoutRequest);
router.patch('/finance/payout-requests/:id/reject', requirePermission('payouts.approve'), adminFinanceController.rejectPayoutRequest);
router.patch('/finance/payout-requests/:id/complete', requirePermission('payouts.approve'), adminFinanceController.completePayoutRequest);
router.get('/finance/disputes', requirePermission('payouts.view', 'dashboard.*'), adminFinanceController.getDisputes);
router.get('/finance/disputes/:id', requirePermission('payouts.view', 'dashboard.*'), adminFinanceController.getDisputeById);
router.patch('/finance/disputes/:id/resolve', requirePermission('payouts.approve'), adminFinanceController.resolveDispute);

// PAYOUTS — shared platform endpoints (proxied)
router.get('/payouts', requirePermission('payouts.view'), payoutController.getAllPayouts);
router.get('/payouts/summary', requirePermission('payouts.view', 'dashboard.*'), payoutController.getPayoutSummary);
router.get('/payouts/export', requirePermission('payouts.view'), payoutController.exportPayouts);
router.patch('/payouts/:id/approve', requirePermission('payouts.approve'), payoutController.approvePayout);
router.patch('/payouts/:id/release', requirePermission('payouts.approve'), payoutController.releasePayout);
router.patch('/payouts/:id/settle', requirePermission('payouts.approve'), payoutController.settlePayout);
router.patch('/payouts/:id/fail', requirePermission('payouts.approve'), payoutController.failPayout);

// PAYOUT METHODS — shared platform endpoints (proxied)
router.get('/payout-methods', requirePermission('payouts.view'), payoutMethodController.getAllSuppliersMethods);
router.get('/payout-methods/summary', requirePermission('payouts.view'), payoutMethodController.getPayoutMethodSummary);
router.get('/payout-methods/suppliers/:supplierId', requirePermission('payouts.view'), payoutMethodController.getSupplierMethods);
router.patch('/payout-methods/:id/verify', requirePermission('payouts.approve'), payoutMethodController.verifyPayoutMethod);

module.exports = router;
