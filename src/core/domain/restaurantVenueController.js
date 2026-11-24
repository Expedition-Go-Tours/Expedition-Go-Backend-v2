/**
 * Restaurant venue endpoints: public reads and review writes.
 *
 * The read DTOs stay unchanged by the write path: a submission can move a
 * rating or add a review, but it cannot change the shape of a storefront
 * response. Provenance and moderation are decided in the write service, never
 * here from request data.
 */

const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const service = require('../services/restaurantVenueService');
const writeService = require('../services/restaurantVenueWriteService');

/**
 * GET /api/restaurant-venues
 * Brand-scoped list with facet filters and keyset pagination.
 */
exports.listVenues = catchAsync(async (req, res) => {
  const data = await service.listVenues(req.query);
  res.status(200).json({ status: 'success', data });
});

/**
 * GET /api/restaurant-venues/:slugOrId
 * One venue, accepted by slug or id so a renamed slug never breaks an old link.
 */
exports.getVenue = catchAsync(async (req, res, next) => {
  const venue = await service.getVenue(req.params.slugOrId, req.query.brand);
  if (!venue) {
    return next(new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' }));
  }
  res.status(200).json({ status: 'success', data: { venue } });
});

/**
 * GET /api/restaurant-venues/:slugOrId/reviews
 * Approved reviews only, newest first, keyset paginated.
 */
exports.listReviews = catchAsync(async (req, res, next) => {
  const venueId = await service.resolveVenueId(req.params.slugOrId, req.query.brand);
  if (!venueId) {
    return next(new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' }));
  }

  const { limit, cursor, rating, verified } = req.query;
  const data = await service.listReviews(venueId, { limit, cursor, rating, verified });

  // A venue deleted between the two reads is a 404, not an empty list.
  if (!data) {
    return next(new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' }));
  }

  res.status(200).json({ status: 'success', data: { venueId, ...data } });
});

/* ── review writes ──────────────────────────────────────────────────────── */

/**
 * POST /api/restaurant-venues/:slugOrId/reviews
 * A signed invite yields an approved, verified review; without one the review
 * waits in the moderation queue.
 */
exports.createReview = catchAsync(async (req, res) => {
  const review = await writeService.createReview({
    slugOrId: req.params.slugOrId,
    brand: req.query.brand,
    author: req.user,
    input: req.body,
    req,
  });

  res.status(201).json({ status: 'success', data: { review } });
});

/**
 * DELETE /api/restaurant-venues/:slugOrId/reviews/:reviewId
 * Archive the author's own review and release its visit slot.
 */
exports.deleteReview = catchAsync(async (req, res) => {
  const result = await writeService.deleteOwnReview({
    slugOrId: req.params.slugOrId,
    brand: req.query.brand,
    reviewId: req.params.reviewId,
    author: req.user,
    req,
  });

  res.status(200).json({ status: 'success', data: result });
});

/**
 * POST /api/restaurant-venues/:slugOrId/reviews/:reviewId/report
 */
exports.submitReport = catchAsync(async (req, res) => {
  const report = await writeService.submitReport({
    slugOrId: req.params.slugOrId,
    brand: req.query.brand,
    reviewId: req.params.reviewId,
    reporter: req.user,
    input: req.body,
    req,
  });

  res.status(201).json({ status: 'success', data: { report } });
});

/* ── admin review management ────────────────────────────────────────────── */

exports.listPendingReviews = catchAsync(async (req, res) => {
  const data = await writeService.listPendingReviews(req.query);
  res.status(200).json({ status: 'success', data });
});

exports.moderateReview = catchAsync(async (req, res) => {
  const review = await writeService.moderateReview({
    reviewId: req.params.reviewId,
    adminId: req.user.id,
    action: req.body.action,
    reason: req.body.reason,
    req,
  });

  res.status(200).json({ status: 'success', data: { review } });
});

exports.resolveReport = catchAsync(async (req, res) => {
  const report = await writeService.resolveReport({
    reportId: req.params.reportId,
    adminId: req.user.id,
    classification: req.body.classification,
    outcome: req.body.outcome,
    req,
  });

  res.status(200).json({ status: 'success', data: { report } });
});

exports.createInvite = catchAsync(async (req, res) => {
  const invite = await writeService.createInvite({
    slugOrId: req.params.slugOrId,
    brand: req.query.brand,
    adminId: req.user.id,
    input: req.body,
    req,
  });

  res.status(201).json({ status: 'success', data: { invite } });
});
