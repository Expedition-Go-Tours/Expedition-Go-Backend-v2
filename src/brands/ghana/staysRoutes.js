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
const { uploadTourPhotos } = require('../../../middleware/uploadMiddleware');
const controller = require('./staysController');
const offers = require('./staysOffersController');
const bookings = require('./staysBookingsController');
const analytics = require('./staysAnalyticsController');
const schemas = require('../../core/services/staysValidation');

const router = express.Router();

// Dashboard is available to every signed-in supplier member, matching the
// frontend's `"/stays": null` page-access rule.
router.get('/dashboard', controller.getDashboard);

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

module.exports = router;
