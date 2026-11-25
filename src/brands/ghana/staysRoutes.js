/**
 * Travio Ghana — Stays supplier routes.
 *
 * Mounted by supplierRoutes at /api/travioghana/supplier/stays, after the
 * shared protect + resolveSupplier guards. Permissions mirror the dashboard's
 * page-access map: stays.view for reads, stays.manage for builder writes,
 * stays.rates for rate plans and stays.availability for the calendar.
 */

const express = require('express');
const { requireTeamPermission } = require('../../../middleware/teamRoleMiddleware');
const validate = require('../../../middleware/validate');
const {
  uploadTourPhotos,
  uploadSupplierDocument,
  uploadChatImage,
} = require('../../../middleware/uploadMiddleware');
const controller = require('./staysController');
const offers = require('./staysOffersController');
const bookings = require('./staysBookingsController');
const analytics = require('./staysAnalyticsController');
const finance = require('./staysFinanceController');
const financeController = require('../../core/domain/financeController');
const payoutMethodController = require('../../core/domain/payoutMethodController');
const verification = require('./staysVerificationController');
const chatController = require('../../core/domain/chatController');
const notificationController = require('../../core/domain/notificationController');
const prisma = require('../../core/services/prismaClient');
const AppError = require('../../core/services/appError');
const schemas = require('../../core/services/staysValidation');

const router = express.Router();

/**
 * Force shared chat/notification controllers onto the Stays product domain.
 * These routes live under /supplier/stays, so Nginx serves them from the
 * stays-api container rather than the Experiences API.
 */
function staysDomain(req, _res, next) {
  req.query = { ...(req.query || {}), domain: 'stays' };
  next();
}

/**
 * A by-ID chat operation must prove the conversation is a Stays thread before
 * the controller reads or mutates it. List-level filtering alone would let a
 * supplier open a tour thread by guessing its id.
 */
async function assertStayConversation(req, _res, next) {
  try {
    const accessIds = [req.supplierId, req.user?.id].filter(Boolean);
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: req.params.id,
        domain: 'STAYS',
        participants: { some: { userId: { in: accessIds } } },
      },
      select: { id: true },
    });
    if (!conversation) return next(new AppError('Conversation not found', 404));
    next();
  } catch (error) {
    next(error);
  }
}

// Dashboard is available to every signed-in supplier member, matching the
// frontend's `"/stays": null` page-access rule.
router.get('/dashboard', controller.getDashboard);

// Stays-only chat. The shared controller is forced onto the STAYS domain, and
// every by-ID operation is checked against that domain before it runs.
router.get('/conversations', requireTeamPermission('chat.view'), staysDomain, chatController.getConversations);
router.get('/conversations/unread-count', requireTeamPermission('chat.view'), staysDomain, chatController.getUnreadCount);
router.get('/conversations/:id/messages', requireTeamPermission('chat.view'), assertStayConversation, chatController.getMessages);
router.post('/conversations/:id/messages', requireTeamPermission('chat.respond'), assertStayConversation, chatController.sendMessage);
router.patch('/conversations/:id/read', requireTeamPermission('chat.view'), assertStayConversation, chatController.markAsRead);
router.delete('/conversations/:id', requireTeamPermission('chat.respond'), assertStayConversation, chatController.deleteConversation);
router.post('/chat/upload', requireTeamPermission('chat.respond'), uploadChatImage, chatController.uploadImage);

// Stays-only notifications. The by-ID operations receive domain=STAYS too, so
// a tour notification id can never be marked read or deleted from this bell.
router.get('/notifications', staysDomain, notificationController.getNotifications);
router.patch('/notifications/mark-all-read', staysDomain, notificationController.markAllAsRead);
router.patch('/notifications/:id/read', staysDomain, notificationController.markAsRead);
router.delete('/notifications/:id', staysDomain, notificationController.deleteNotification);

// Properties / builder
router.get('/properties', requireTeamPermission('stays.view'), controller.listProperties);
router.post(
  '/properties',
  requireTeamPermission('stays.manage'),
  validate(schemas.createPropertySchema),
  controller.createProperty,
);
router.get(
  '/properties/:id',
  requireTeamPermission('stays.view'),
  validate(schemas.propertyParams),
  controller.getProperty,
);
router.patch(
  '/properties/:id',
  requireTeamPermission('stays.manage'),
  validate(schemas.propertyParams),
  controller.updateProperty,
);
router.delete(
  '/properties/:id',
  requireTeamPermission('stays.manage'),
  validate(schemas.propertyParams),
  controller.deleteProperty,
);
router.post(
  '/properties/:id/submit-for-review',
  requireTeamPermission('stays.manage'),
  validate(schemas.emptyBody),
  controller.submitProperty,
);

// Photos (multipart; the JSON fallback is handled by the controller)
router.post(
  '/properties/:id/photos',
  requireTeamPermission('stays.manage'),
  uploadTourPhotos,
  controller.addPhotos,
);
router.delete(
  '/properties/:id/photos/:index',
  requireTeamPermission('stays.manage'),
  validate(schemas.photoIndexParams),
  controller.removePhoto,
);

// Rate plans
router.post(
  '/properties/:id/rate-plans',
  requireTeamPermission('stays.rates'),
  validate(schemas.propertyParams),
  controller.saveRatePlan,
);
router.patch(
  '/properties/:id/rate-plans/:planId',
  requireTeamPermission('stays.rates'),
  validate(schemas.ratePlanParams),
  controller.saveRatePlan,
);
router.delete(
  '/properties/:id/rate-plans/:planId',
  requireTeamPermission('stays.rates'),
  validate(schemas.ratePlanParams),
  controller.deleteRatePlan,
);

// Availability calendar
router.get(
  '/properties/:id/availability',
  requireTeamPermission('stays.availability'),
  validate(schemas.availabilityQuery),
  controller.getAvailability,
);
router.put(
  '/properties/:id/availability',
  requireTeamPermission('stays.availability'),
  validate(schemas.availabilityCellBody),
  controller.setAvailabilityCell,
);
router.delete(
  '/properties/:id/availability',
  requireTeamPermission('stays.availability'),
  validate(schemas.availabilityCellDelete),
  controller.clearAvailabilityCell,
);

// Offers
router.get('/offers', requireTeamPermission('stays.offers'), validate(schemas.listQuery), offers.listOffers);
router.get('/offers/:id', requireTeamPermission('stays.offers'), validate(schemas.idParams), offers.getOffer);
router.post('/offers', requireTeamPermission('stays.offers'), validate(schemas.offerSaveSchema), offers.saveOffer);
router.patch('/offers/:id', requireTeamPermission('stays.offers'), validate(schemas.offerSaveSchema), offers.saveOffer);
router.post('/offers/:id/toggle', requireTeamPermission('stays.offers'), validate(schemas.idParams), offers.toggleOffer);
router.delete('/offers/:id', requireTeamPermission('stays.offers'), validate(schemas.idParams), offers.deleteOffer);

// Bookings + manual supplier creation
router.get('/bookings', requireTeamPermission('stays.bookings'), validate(schemas.listQuery), bookings.listBookings);
router.get('/bookings/:id', requireTeamPermission('stays.bookings'), validate(schemas.idParams), bookings.getBooking);
router.post('/bookings', requireTeamPermission('stays.bookings'), validate(schemas.createBookingSchema), bookings.createBooking);
router.patch('/bookings/:id/status', requireTeamPermission('stays.bookings'), validate(schemas.bookingStatusSchema), bookings.updateBookingStatus);

// Cancellation reporting (read-only gauge open to every supplier member)
router.get('/cancellation', validate(schemas.cancellationQuery), bookings.getCancellationSummary);
router.get('/cancellation/records', validate(schemas.cancellationQuery), bookings.getCancellationRecords);

// Analytics
router.get('/analytics', requireTeamPermission('stays.analytics'), validate(schemas.analyticsQuery), analytics.getAnalytics);
router.get('/analytics/summary', requireTeamPermission('stays.analytics'), validate(schemas.analyticsQuery), analytics.getAnalyticsSummary);
router.get('/analytics/properties', requireTeamPermission('stays.analytics'), validate(schemas.analyticsQuery), analytics.getPropertyAnalytics);
router.get('/analytics/monthly-revenue', requireTeamPermission('stays.analytics'), validate(schemas.analyticsQuery), analytics.getMonthlyRevenue);

// Reviews
router.get('/reviews', requireTeamPermission('stays.reviews'), validate(schemas.listQuery), analytics.listReviews);
router.post('/reviews/:id/reply', requireTeamPermission('stays.reviews'), validate(schemas.reviewReplySchema), analytics.replyToReview);

// Finance (parallel stays ledger)
router.get('/finance/summary', requireTeamPermission('payouts.view'), finance.getSummary);
router.get('/finance/earnings', requireTeamPermission('payouts.view'), validate(schemas.listQuery), finance.getEarnings);
router.get('/finance/payouts/requests', requireTeamPermission('payouts.view'), validate(schemas.listQuery), finance.getPayoutRequests);
router.post('/finance/payout/request', requireTeamPermission('payouts.request'), finance.createPayoutRequest);
router.patch('/finance/payouts/requests/:id/cancel', requireTeamPermission('payouts.request'), validate(schemas.idParams), finance.cancelPayoutRequest);
router.get('/finance/payout-settings', requireTeamPermission('payouts.view'), financeController.getPayoutSettings);
router.patch('/finance/payout-settings', requireTeamPermission('payouts.request'), financeController.updatePayoutSettings);
router.get('/finance/charges', requireTeamPermission('payouts.view'), finance.getCharges);

// Refund requests / disputes
router.get('/finance/disputes', requireTeamPermission('payouts.view'), validate(schemas.listQuery), finance.getDisputes);
router.post('/disputes', requireTeamPermission('payouts.request'), finance.createDispute);
router.patch('/disputes/:id/withdraw', requireTeamPermission('payouts.request'), validate(schemas.idParams), finance.withdrawDispute);

// Payout methods are supplier-scoped and shared with the tour dashboard.
router.get('/payout-methods/me', requireTeamPermission('payout-methods.view'), payoutMethodController.getMyMethods);
router.post('/payout-methods', requireTeamPermission('payout-methods.manage'), payoutMethodController.addMethod);
router.patch('/payout-methods/:id', requireTeamPermission('payout-methods.manage'), validate(schemas.idParams), payoutMethodController.updateMethod);
router.delete('/payout-methods/:id', requireTeamPermission('payout-methods.manage'), validate(schemas.idParams), payoutMethodController.deleteMethod);

// Refund claims raised by guests (customer storefront is a separate project).
router.get('/refund-claims/supplier', requireTeamPermission('payouts.view'), validate(schemas.listQuery), finance.getRefundClaims);
router.patch('/refund-claims/supplier/:id/approve', requireTeamPermission('payouts.request'), validate(schemas.idParams), finance.approveRefundClaim);
router.patch('/refund-claims/supplier/:id/decline', requireTeamPermission('payouts.request'), validate(schemas.idParams), finance.declineRefundClaim);

// Stays-specific verification (never the tour/experience KYC routes)
router.get('/verification', requireTeamPermission('settings.manage'), verification.getVerification);
router.post(
  '/verification/documents',
  requireTeamPermission('settings.manage'),
  uploadSupplierDocument,
  verification.addDocument,
);
router.post(
  '/verification/documents/:id/replace',
  requireTeamPermission('settings.manage'),
  validate(schemas.idParams),
  uploadSupplierDocument,
  verification.replaceDocument,
);

module.exports = router;
// Exported for the isolation unit test; not part of the HTTP surface.
module.exports._assertStayConversation = assertStayConversation;
