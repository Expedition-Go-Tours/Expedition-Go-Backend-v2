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

module.exports = router;
