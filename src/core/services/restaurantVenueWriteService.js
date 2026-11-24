/**
 * Restaurant venue write path.
 *
 * The rules that matter here are the ones a storefront cannot enforce:
 *
 *   - provenance is computed by the server. A request may supply a signed
 *     invite, never a `source`, `verified` flag or moderation status;
 *   - one review per visit, with a 30-day restaurant cooldown and a 12-month
 *     submission window;
 *   - a correction is a delete followed by a new review, not a silent edit;
 *   - a report is classified before it can remove anything. Only an upheld
 *     FAKE report takes a review down.
 *
 * Every state change writes the review row and the venue aggregate in one
 * transaction, then invalidates the storefront caches once the commit lands.
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const AppError = require('./appError');
const cache = require('./cacheHelper');
const logger = require('./logger');
const { enqueueEvent, enqueueNotification, enqueueAggregation } = require('./queue');
const { logActivity } = require('./auditLogger');
const { notifyAdmin } = require('./adminNotificationService');
const { isValidCloudinaryUrl } = require('./cloudinaryHelper');
const {
  BRANDS,
  decodeReviewCursor,
  encodeCursor,
} = require('./restaurantVenueService');
const { mintReviewProof, verifyReviewProof, normalizeDateOnly } = require('./restaurantReviewProof');
const { addApprovedRating, removeApprovedRating } = require('./restaurantVenueRatings');

const COOLDOWN_DAYS = 30;
const SUBMISSION_WINDOW_DAYS = 365;
const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const WINDOW_MS = SUBMISSION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const MAX_PHOTOS = 5;
const LIVE_STATUSES = ['APPROVED', 'PENDING', 'FLAGGED'];

function hashFingerprint(value) {
  if (!value) return null;
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'insecure-dev-review-proof')
    .update(String(value))
    .digest('hex');
}

function requestFingerprints(req) {
  const forwarded = req && req.headers ? req.headers['x-forwarded-for'] : null;
  const ip = (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) ||
    (req && req.ip) ||
    (req && req.socket && req.socket.remoteAddress) ||
    null;
  const agent = req && req.headers ? req.headers['user-agent'] : null;
  return { ipHash: hashFingerprint(ip), userAgentHash: hashFingerprint(agent) };
}

function uniqueTarget(error) {
  const target = error && error.meta && error.meta.target;
  return Array.isArray(target) ? target.join(',') : String(target || '');
}

function translateConstraint(error, { proof = false } = {}) {
  if (!error || error.code !== 'P2002') return error;
  const target = uniqueTarget(error);
  if (target.includes('proofRef')) {
    return new AppError('This review invite has already been used', 409, {
      code: 'PROOF_ALREADY_USED',
    });
  }
  if (target.includes('visitKey')) {
    return new AppError(proof
      ? 'You have already reviewed this visit'
      : 'You have already reviewed this venue for that visit', 409, {
      code: 'REVIEW_ALREADY_EXISTS',
    });
  }
  return error;
}

function parseVisitDate(value) {
  if (value === undefined || value === null || value === '') return new Date();
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    // Throws a readable 400 for impossible dates like 2026-02-30.
    normalizeDateOnly(text);
    return new Date(`${text}T00:00:00.000Z`);
  }
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) {
    throw new AppError('Visit date must be a valid date', 400, { code: 'INVALID_VISIT_DATE' });
  }
  return at;
}

function validateVisitDate(at) {
  const now = Date.now();
  if (at.getTime() > now) {
    throw new AppError('A visit cannot be in the future', 400, { code: 'VISIT_IN_FUTURE' });
  }
  if (at.getTime() < now - WINDOW_MS) {
    throw new AppError('Reviews can only be submitted within a year of the visit', 400, {
      code: 'VISIT_TOO_OLD',
    });
  }
  return at;
}

function visitKeyFor(at) {
  return at.toISOString().slice(0, 7);
}

function cleanPhotos(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppError('Photos must be an array', 400, { code: 'INVALID_PHOTOS' });
  }
  const photos = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (photos.length > MAX_PHOTOS) {
    throw new AppError(`A review can include at most ${MAX_PHOTOS} photos`, 400, {
      code: 'TOO_MANY_PHOTOS',
    });
  }
  if (photos.some((url) => !isValidCloudinaryUrl(url))) {
    throw new AppError('Photos must be uploaded before the review is submitted', 400, {
      code: 'INVALID_PHOTOS',
    });
  }
  return photos;
}

function invalidate(venue) {
  cache
    .invalidateRestaurantVenueCaches(venue.id, venue.slug)
    .catch((err) => logger.warn('[cache] restaurant venue invalidation failed:', err?.message));
}

function queueRankRefresh(venue) {
  // The ordinal moves when other venues change too, so it is a batch concern.
  // The worker owns the recompute; this only marks the city as dirty.
  enqueueAggregation('restaurant-venue-ranks', { venueId: venue.id, city: venue.city });
}

async function resolveVenue(slugOrId, brand) {
  if (!BRANDS.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }
  const needle = String(slugOrId || '').trim();
  if (!needle) return null;

  return prisma.restaurantVenue.findFirst({
    where: {
      status: 'ACTIVE',
      listings: { some: { brand, isActive: true } },
      OR: [{ slug: needle }, { id: needle }],
    },
    select: { id: true, slug: true, name: true, city: true },
  });
}

function toAuthorReview(review) {
  return {
    id: review.id,
    venueId: review.venueId,
    status: review.status,
    rating: review.rating,
    title: review.title,
    body: review.body,
    photos: review.photos || [],
    visitedAt: review.visitedAt,
    source: review.source,
    proofMethod: review.proofMethod,
    verified: review.source === 'TRAVIO_VERIFIED',
    createdAt: review.createdAt,
  };
}

function toReport(report) {
  return {
    id: report.id,
    reviewId: report.reviewId,
    reason: report.reason,
    status: report.status,
    classification: report.classification ?? null,
    reporterRole: report.reporterRole,
    createdAt: report.createdAt,
  };
}

/** A customer or invited guest submits a review. */
async function createReview({ slugOrId, brand, author, input, req }) {
  const venue = await resolveVenue(slugOrId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });

  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError('Rating must be between 1 and 5', 400, { code: 'INVALID_RATING' });
  }

  // A token decides both the visit date and the provenance. The request body's
  // own date is ignored when a token is present, so a guest cannot move an
  // invited visit outside the 12-month window.
  const proof = input.proofToken
    ? verifyReviewProof(input.proofToken, { venueId: venue.id, email: author.email })
    : null;
  const visitedAt = validateVisitDate(
    parseVisitDate(proof && proof.visitDate ? proof.visitDate : input.visitedAt),
  );
  const visitKey = visitKeyFor(visitedAt);
  const photos = cleanPhotos(input.photos);
  const fingerprints = requestFingerprints(req);

  const data = {
    venueId: venue.id,
    authorId: author.id,
    rating,
    foodRating: input.foodRating ?? null,
    serviceRating: input.serviceRating ?? null,
    atmosphereRating: input.atmosphereRating ?? null,
    valueRating: input.valueRating ?? null,
    title: input.title ? String(input.title).trim() : null,
    body: input.body ? String(input.body).trim() : null,
    photos,
    source: proof ? 'TRAVIO_VERIFIED' : 'TRAVIO_COMMUNITY',
    proofMethod: proof ? proof.proofMethod : null,
    proofRef: proof ? proof.proofRef : null,
    visitedAt,
    visitKey,
    status: proof ? 'APPROVED' : 'PENDING',
    ...fingerprints,
  };

  let review;
  try {
    review = await prisma.$transaction(async (tx) => {
      const last = await tx.restaurantVenueReview.findFirst({
        where: { venueId: venue.id, authorId: author.id, status: { in: LIVE_STATUSES } },
        orderBy: { createdAt: 'desc' },
        select: { visitedAt: true, createdAt: true },
      });
      // The gap is measured from the last review, not from the meal. Someone
      // who reviewed a three-month-old visit yesterday is still inside the
      // cooldown today; otherwise they could post one old visit per day.
      const anchor = last
        ? new Date(
            Math.max(
              last.visitedAt ? last.visitedAt.getTime() : 0,
              last.createdAt ? last.createdAt.getTime() : 0,
            ),
          )
        : null;
      if (anchor && Date.now() - anchor.getTime() < COOLDOWN_MS) {
        throw new AppError('You can review this restaurant again after 30 days', 409, {
          code: 'REVIEW_COOLDOWN',
          details: { retryAfter: new Date(anchor.getTime() + COOLDOWN_MS).toISOString() },
        });
      }

      const created = await tx.restaurantVenueReview.create({
        data,
        include: { author: { select: { name: true, photoURL: true } } },
      });
      if (proof) {
        await addApprovedRating(tx, venue.id, { rating, verified: true });
      }
      return created;
    });
  } catch (error) {
    throw translateConstraint(error, { proof: Boolean(proof) });
  }

  invalidate(venue);
  queueRankRefresh(venue);

  await logActivity({
    userId: author.id,
    action: 'restaurantReview.created',
    resource: 'RestaurantVenueReview',
    resourceId: review.id,
    metadata: { venueId: venue.id, rating, source: data.source, proofMethod: data.proofMethod },
  });
  enqueueEvent({
    name: 'restaurant_review.submitted',
    userId: author.id,
    req,
    resource: 'RestaurantVenueReview',
    resourceId: review.id,
    properties: { venueId: venue.id, rating, source: data.source, verified: Boolean(proof) },
  });

  if (!proof) {
    notifyAdmin({
      type: 'RESTAURANT_REVIEW_NEEDS_MODERATION',
      title: 'Restaurant review needs moderation',
      message: `A ${rating}-star review for ${venue.name} is waiting for approval.`,
      data: { reviewId: review.id, venueId: venue.id },
    }).catch((err) => logger.warn('[admin] review notification failed:', err?.message));
  }

  return toAuthorReview(review);
}

/** Delete and resubmit, never an in-place content edit. */
async function deleteOwnReview({ slugOrId, brand, reviewId, author, req }) {
  const venue = await resolveVenue(slugOrId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });

  const review = await prisma.restaurantVenueReview.findFirst({
    where: { id: reviewId, venueId: venue.id, authorId: author.id, status: { in: LIVE_STATUSES } },
  });
  if (!review) throw new AppError('Review not found', 404, { code: 'REVIEW_NOT_FOUND' });

  await prisma.$transaction(async (tx) => {
    if (review.status === 'APPROVED') {
      await removeApprovedRating(tx, venue.id, {
        rating: review.rating,
        verified: review.source === 'TRAVIO_VERIFIED',
      });
    }
    await tx.restaurantVenueReview.update({
      where: { id: review.id },
      data: {
        status: 'ARCHIVED',
        // Prisma has no partial unique indexes. Suffixing the key releases the
        // (venue, author, visit) slot while the audit row stays put.
        visitKey: `${review.visitKey}:a:${review.id}`,
        flagReason: 'author_deleted',
      },
    });
  });

  invalidate(venue);
  queueRankRefresh(venue);

  await logActivity({
    userId: author.id,
    action: 'restaurantReview.deleted',
    resource: 'RestaurantVenueReview',
    resourceId: review.id,
    metadata: { venueId: venue.id },
  });
  enqueueEvent({
    name: 'restaurant_review.deleted',
    userId: author.id,
    req,
    resource: 'RestaurantVenueReview',
    resourceId: review.id,
    properties: { venueId: venue.id, rating: review.rating },
  });

  return { id: review.id, status: 'ARCHIVED' };
}

/** Admin approve / reject / flag. Aggregate moves only on an APPROVED crossing. */
async function moderateReview({ reviewId, adminId, action, reason, req }) {
  const statuses = { approve: 'APPROVED', reject: 'REJECTED', flag: 'FLAGGED' };
  if (!statuses[action]) {
    throw new AppError('Invalid moderation action', 400, { code: 'INVALID_MODERATION_ACTION' });
  }

  const review = await prisma.restaurantVenueReview.findUnique({
    where: { id: reviewId },
    include: { venue: { select: { id: true, slug: true, name: true, city: true } } },
  });
  if (!review) throw new AppError('Review not found', 404, { code: 'REVIEW_NOT_FOUND' });
  if (['ARCHIVED', 'REMOVED'].includes(review.status)) {
    throw new AppError('This review is no longer active', 409, { code: 'REVIEW_NOT_ACTIVE' });
  }

  const nextStatus = statuses[action];
  const wasApproved = review.status === 'APPROVED';
  const becomesApproved = nextStatus === 'APPROVED';

  const updated = await prisma.$transaction(async (tx) => {
    if (becomesApproved && !wasApproved) {
      await addApprovedRating(tx, review.venueId, {
        rating: review.rating,
        verified: review.source === 'TRAVIO_VERIFIED',
      });
    } else if (!becomesApproved && wasApproved) {
      await removeApprovedRating(tx, review.venueId, {
        rating: review.rating,
        verified: review.source === 'TRAVIO_VERIFIED',
      });
    }
    return tx.restaurantVenueReview.update({
      where: { id: review.id },
      data: {
        status: nextStatus,
        moderatedBy: adminId,
        moderatedAt: new Date(),
        flagReason: action === 'approve' ? null : (reason || action),
      },
    });
  });

  invalidate(review.venue);
  queueRankRefresh(review.venue);

  await logActivity({
    userId: adminId,
    action: `restaurantReview.${action}`,
    resource: 'RestaurantVenueReview',
    resourceId: review.id,
    metadata: { venueId: review.venueId, reason: reason || null, previousStatus: review.status },
  });
  enqueueEvent({
    name: `restaurant_review.${action}`,
    userId: adminId,
    req,
    resource: 'RestaurantVenueReview',
    resourceId: review.id,
    properties: { venueId: review.venueId, rating: review.rating },
  });
  enqueueNotification({
    userId: review.authorId,
    type: 'REVIEW_STATUS_UPDATE',
    title: 'Restaurant review update',
    message: action === 'approve'
      ? 'Your restaurant review is now visible.'
      : `Your restaurant review was ${action === 'flag' ? 'flagged for review' : 'not approved'}.`,
    data: { reviewId: review.id },
  }).catch((err) => logger.warn('[notification] review update failed:', err?.message));

  return toAuthorReview({ ...review, ...updated });
}

async function listPendingReviews({ limit = 20, cursor } = {}) {
  const decoded = cursor ? decodeReviewCursor(cursor) : null;
  const where = { status: 'PENDING' };
  if (decoded) {
    where.OR = [
      { createdAt: { lt: decoded.at } },
      { AND: [{ createdAt: decoded.at }, { id: { lt: decoded.id } }] },
    ];
  }

  const rows = await prisma.restaurantVenueReview.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      venueId: true,
      rating: true,
      title: true,
      body: true,
      createdAt: true,
      venue: { select: { name: true, slug: true } },
      author: { select: { name: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    reviews: page.map((row) => ({
      id: row.id,
      venueId: row.venueId,
      venueName: row.venue ? row.venue.name : null,
      venueSlug: row.venue ? row.venue.slug : null,
      authorName: row.author ? row.author.name : null,
      rating: row.rating,
      title: row.title,
      body: row.body,
      createdAt: row.createdAt,
    })),
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ c: last.createdAt.toISOString(), id: last.id })
          : null,
    },
  };
}

/** A customer, or a venue owner once that surface exists, reports a review. */
async function submitReport({ slugOrId, brand, reviewId, reporter, input, req }) {
  const venue = await resolveVenue(slugOrId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });

  const review = await prisma.restaurantVenueReview.findFirst({
    where: { id: reviewId, venueId: venue.id, status: 'APPROVED' },
    select: { id: true, authorId: true, source: true },
  });
  if (!review) throw new AppError('Review not found', 404, { code: 'REVIEW_NOT_FOUND' });
  if (review.authorId === reporter.id) {
    throw new AppError('You cannot report your own review', 400, { code: 'CANNOT_REPORT_OWN_REVIEW' });
  }

  let report;
  try {
    report = await prisma.$transaction(async (tx) => {
      const open = await tx.restaurantVenueReviewReport.findFirst({
        where: { reviewId: review.id, reporterUserId: reporter.id, status: 'OPEN' },
        select: { id: true },
      });
      if (open) {
        throw new AppError('You have already reported this review', 409, {
          code: 'REPORT_ALREADY_EXISTS',
        });
      }
      const created = await tx.restaurantVenueReviewReport.create({
        data: {
          reviewId: review.id,
          reporterUserId: reporter.id,
          reporterRole: 'CUSTOMER',
          reason: String(input.reason).trim(),
          detail: input.detail ? String(input.detail).trim() : null,
        },
      });
      await tx.restaurantVenueReview.update({
        where: { id: review.id },
        data: { reportCount: { increment: 1 } },
      });
      return created;
    });
  } catch (error) {
    throw translateConstraint(error);
  }

  await logActivity({
    userId: reporter.id,
    action: 'restaurantReview.reported',
    resource: 'RestaurantVenueReviewReport',
    resourceId: report.id,
    metadata: { reviewId: review.id, venueId: venue.id, reason: report.reason },
  });
  enqueueEvent({
    name: 'restaurant_review.reported',
    userId: reporter.id,
    req,
    resource: 'RestaurantVenueReviewReport',
    resourceId: report.id,
    properties: { reviewId: review.id, venueId: venue.id },
  });
  notifyAdmin({
    type: 'RESTAURANT_REVIEW_REPORTED',
    title: 'Restaurant review reported',
    message: `A review of ${venue.name} was reported: ${report.reason}`,
    data: { reportId: report.id, reviewId: review.id, venueId: venue.id },
  }).catch((err) => logger.warn('[admin] report notification failed:', err?.message));

  return toReport(report);
}

/**
 * Resolve a report. CONTESTED means the reviewer really ate there and the
 * business disputes the account. That never removes a review. FAKE plus
 * UPHELD is the only path to removal.
 */
async function resolveReport({ reportId, adminId, classification, outcome, req }) {
  const report = await prisma.restaurantVenueReviewReport.findUnique({
    where: { id: reportId },
    include: {
      review: {
        include: { venue: { select: { id: true, slug: true, name: true, city: true } } },
      },
    },
  });
  if (!report) throw new AppError('Report not found', 404, { code: 'REPORT_NOT_FOUND' });
  if (report.status !== 'OPEN') {
    throw new AppError('This report has already been resolved', 409, {
      code: 'REPORT_ALREADY_RESOLVED',
    });
  }

  const removeReview = classification === 'FAKE' && outcome === 'UPHELD';
  const review = report.review;
  let updatedReview = null;

  await prisma.$transaction(async (tx) => {
    if (removeReview && review.status !== 'REMOVED') {
      if (review.status === 'APPROVED') {
        await removeApprovedRating(tx, review.venueId, {
          rating: review.rating,
          verified: review.source === 'TRAVIO_VERIFIED',
        });
      }
      updatedReview = await tx.restaurantVenueReview.update({
        where: { id: review.id },
        data: {
          status: 'REMOVED',
          moderatedBy: adminId,
          moderatedAt: new Date(),
          flagReason: `upheld FAKE report: ${report.reason}`,
        },
      });
    }
    await tx.restaurantVenueReviewReport.update({
      where: { id: report.id },
      data: {
        status: outcome,
        classification,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });
  });

  if (updatedReview) {
    invalidate(review.venue);
    queueRankRefresh(review.venue);
    enqueueNotification({
      userId: review.authorId,
      type: 'REVIEW_REMOVED',
      title: 'Restaurant review removed',
      message: 'A moderator found that your review did not describe a first-hand visit, so it was removed.',
      data: { reviewId: review.id },
    }).catch((err) => logger.warn('[notification] review removal failed:', err?.message));
  }

  await logActivity({
    userId: adminId,
    action: 'restaurantReviewReport.resolved',
    resource: 'RestaurantVenueReviewReport',
    resourceId: report.id,
    metadata: {
      reviewId: review.id,
      classification,
      outcome,
      reviewRemoved: Boolean(updatedReview),
    },
  });
  enqueueEvent({
    name: 'restaurant_review_report.resolved',
    userId: adminId,
    req,
    resource: 'RestaurantVenueReviewReport',
    resourceId: report.id,
    properties: { reviewId: review.id, classification, outcome },
  });

  return {
    ...toReport(report),
    status: outcome,
    classification,
    reviewStatus: updatedReview ? updatedReview.status : review.status,
  };
}

/** Mint an invite for a QR card or an email that has not been sent yet. */
async function createInvite({ slugOrId, brand, adminId, input, req }) {
  const venue = await resolveVenue(slugOrId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });

  const invite = mintReviewProof({
    venueId: venue.id,
    proofMethod: input.proofMethod,
    email: input.email || null,
    visitDate: input.visitDate || null,
    expiresInDays: input.expiresInDays,
  });

  await logActivity({
    userId: adminId,
    action: 'restaurantVenue.reviewInviteCreated',
    resource: 'RestaurantVenue',
    resourceId: venue.id,
    metadata: {
      proofRef: invite.proofRef,
      proofMethod: invite.proofMethod,
      expiresAt: invite.expiresAt.toISOString(),
      // The token itself is a credential; it never enters the audit log.
    },
  });
  enqueueEvent({
    name: 'restaurant_review_invite.created',
    userId: adminId,
    req,
    resource: 'RestaurantVenue',
    resourceId: venue.id,
    properties: { proofMethod: invite.proofMethod },
  });

  return {
    token: invite.token,
    proofMethod: invite.proofMethod,
    visitDate: invite.visitDate,
    expiresAt: invite.expiresAt,
    venueId: venue.id,
  };
}

module.exports = {
  COOLDOWN_DAYS,
  SUBMISSION_WINDOW_DAYS,
  MAX_PHOTOS,
  createReview,
  deleteOwnReview,
  moderateReview,
  listPendingReviews,
  submitReport,
  resolveReport,
  createInvite,
};
