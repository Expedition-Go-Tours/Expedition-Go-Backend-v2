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
const { isValidCloudinaryUrl } = require('../services/cloudinaryHelper');
const service = require('../services/restaurantVenueService');
const writeService = require('../services/restaurantVenueWriteService');
const claimService = require('../services/restaurantVenueClaimService');
const offerService = require('../services/restaurantVenueOfferService');
const homeRanking = require('../services/restaurantHomepageRanking');

/**
 * GET /api/restaurant-venues
 * Brand-scoped list with facet filters and keyset pagination.
 */
exports.listVenues = catchAsync(async (req, res) => {
  const data = await service.listVenues(req.query);
  res.status(200).json({ status: 'success', data });
});

/**
 * GET /api/restaurant-venues/suggest
 * Restaurant + place typeahead for the storefront search bar.
 */
exports.suggestVenues = catchAsync(async (req, res) => {
  const data = await service.suggestVenues(req.query);
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

/**
 * GET /api/restaurant-venues/reviews
 * Cross-venue approved review feed for the storefront homepage.
 */
exports.listReviewFeed = catchAsync(async (req, res) => {
  const data = await service.listReviewFeed(req.query);
  res.status(200).json({ status: 'success', data });
});

/* ── homepage rails ─────────────────────────────────────────────────────── */

/**
 * Shared query parsing for the public rails. The route schema coerces numbers,
 * but the controller also accepts direct calls from tests/other services, so
 * strings and out-of-range limits are normalized here as well.
 */
function homeQuery(req) {
  const query = req.query || {};
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  return {
    brand: query.brand || 'ghana',
    limit: Math.min(Math.max(Number.parseInt(query.limit, 10) || 8, 1), 20),
    city: query.city || null,
    lat: query.lat != null && query.lat !== '' && Number.isFinite(lat) ? lat : null,
    lng: query.lng != null && query.lng !== '' && Number.isFinite(lng) ? lng : null,
  };
}

/** GET /api/restaurant-venues/homepage/recommended */
exports.getRecommended = catchAsync(async (req, res) => {
  const { userId } = req.user || {};
  const venues = await homeRanking.getRecommended({ ...homeQuery(req), userId: userId || null });
  res.status(200).json({ status: 'success', data: { venues } });
});

/** GET /api/restaurant-venues/homepage/likely-to-book-out */
exports.getLikelyToBookOut = catchAsync(async (req, res) => {
  const venues = await homeRanking.getLikelyToBookOut(homeQuery(req));
  res.status(200).json({ status: 'success', data: { venues } });
});

/** GET /api/restaurant-venues/homepage/offers */
exports.getSpecialOffers = catchAsync(async (req, res) => {
  const venues = await homeRanking.getSpecialOffers(homeQuery(req));
  res.status(200).json({ status: 'success', data: { venues } });
});

/** GET /api/restaurant-venues/homepage/section-venue-ids */
exports.getSectionVenueIds = catchAsync(async (req, res) => {
  const venueIds = await homeRanking.getSectionVenueIds({
    ...homeQuery(req),
    section: (req.query || {}).section,
    userId: req.user?.id || null,
  });
  res.status(200).json({ status: 'success', data: { venueIds } });
});

/* ── review writes ──────────────────────────────────────────────────────── */

/**
 * POST /api/restaurant-venues/:slugOrId/review-photos
 * Upload images before submitting a review. The review contract accepts only
 * Cloudinary URLs, so the browser never invents a photo reference.
 */
exports.uploadReviewPhotos = catchAsync(async (req, res) => {
  const venueId = await service.resolveVenueId(req.params.slugOrId, req.query.brand);
  if (!venueId) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });

  const photos = (req.files || [])
    .map((file) => file.path || file.secure_url || file.url)
    .filter(isValidCloudinaryUrl);
  if (!photos.length) {
    throw new AppError('Upload at least one photo', 400, { code: 'NO_PHOTOS_UPLOADED' });
  }

  res.status(201).json({ status: 'success', data: { photos } });
});

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
 * GET /api/restaurant-venues/:slugOrId/reviews/:reviewId
 * The signed-in author's own review, for the correction form.
 */
exports.getOwnReview = catchAsync(async (req, res) => {
  const review = await writeService.getOwnReview({
    slugOrId: req.params.slugOrId,
    brand: req.query.brand,
    reviewId: req.params.reviewId,
    author: req.user,
  });
  res.status(200).json({ status: 'success', data: { review } });
});

/**
 * PATCH /api/restaurant-venues/:slugOrId/reviews/:reviewId
 * Archive the old review and create a pending replacement in one transaction.
 */
exports.replaceOwnReview = catchAsync(async (req, res) => {
  const review = await writeService.replaceOwnReview({
    slugOrId: req.params.slugOrId,
    brand: req.query.brand,
    reviewId: req.params.reviewId,
    author: req.user,
    input: req.body,
    req,
  });
  res.status(200).json({ status: 'success', data: { review } });
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

/* ── admin offer management ─────────────────────────────────────────────── */

exports.listVenueOffers = catchAsync(async (req, res, next) => {
  const offers = await offerService.listOffers({
    venueId: req.params.venueId,
    brand: req.query.brand,
  });
  if (!offers) {
    return next(new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' }));
  }
  res.status(200).json({ status: 'success', data: { offers } });
});

exports.createVenueOffer = catchAsync(async (req, res) => {
  const offer = await offerService.createOffer({
    venueId: req.params.venueId,
    brand: req.query.brand,
    input: req.body,
  });
  res.status(201).json({ status: 'success', data: { offer } });
});

exports.updateVenueOffer = catchAsync(async (req, res) => {
  const offer = await offerService.updateOffer({
    venueId: req.params.venueId,
    brand: req.query.brand,
    offerId: req.params.offerId,
    input: req.body,
  });
  res.status(200).json({ status: 'success', data: { offer } });
});

exports.deleteVenueOffer = catchAsync(async (req, res) => {
  const result = await offerService.deleteOffer({
    venueId: req.params.venueId,
    brand: req.query.brand,
    offerId: req.params.offerId,
  });
  res.status(200).json({ status: 'success', data: result });
});

/* ── claims and owner surface ────────────────────────────────────────────── */

exports.submitClaim = catchAsync(async (req, res) => {
  const claim = await claimService.submitClaim({
    slugOrId: req.params.slugOrId,
    brand: req.query.brand,
    claimant: req.user,
    input: req.body,
    req,
  });
  res.status(201).json({ status: 'success', data: { claim } });
});

exports.getMyClaim = catchAsync(async (req, res) => {
  const data = await claimService.getMyClaim({
    slugOrId: req.params.slugOrId,
    brand: req.query.brand,
    claimant: req.user,
  });
  res.status(200).json({ status: 'success', data });
});

exports.listMyVenues = catchAsync(async (req, res) => {
  const data = await claimService.listMyVenues({ claimant: req.user });
  res.status(200).json({ status: 'success', data });
});

exports.updateOwnVenue = catchAsync(async (req, res) => {
  const data = await claimService.updateOwnVenue({
    slugOrId: req.params.slugOrId,
    brand: req.query.brand,
    editor: req.user,
    input: req.body,
    req,
  });
  res.status(200).json({ status: 'success', data });
});

exports.listPendingClaims = catchAsync(async (req, res) => {
  const data = await claimService.listPendingClaims(req.query);
  res.status(200).json({ status: 'success', data });
});

exports.resolveClaim = catchAsync(async (req, res) => {
  const claim = await claimService.resolveClaim({
    claimId: req.params.claimId,
    adminId: req.user.id,
    action: req.body.action,
    note: req.body.note,
    req,
  });
  res.status(200).json({ status: 'success', data: { claim } });
});
