/**
 * Owner replies to reviews.
 *
 * The moderation model is Tripadvisor's, adopted deliberately:
 *
 *   PENDING   → submitted, waiting for a moderator
 *   PUBLISHED → visible beside the review
 *   REJECTED  → a moderator declined it; the owner may rewrite
 *   REMOVED   → deleted, including a previously published reply
 *
 * A published reply is never edited in place. Correcting it means deleting it
 * (status REMOVED) and submitting a new one, so the diner never sees a reply
 * change under them and the audit trail keeps both versions.
 *
 * Two things are refused server-side rather than merely discouraged in copy:
 * links and email addresses. A public reply is not a marketing channel, and an
 * owner pasting `wa.me/...` into one is the commonest way that goes wrong.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const logger = require('./logger');
const { enqueueEvent, enqueueNotification } = require('./queue');
const { logActivity } = require('./auditLogger');
const { notifyAdmin } = require('./adminNotificationService');
const { decodeReviewCursor, encodeCursor } = require('./restaurantVenueService');
const { assertPermission } = require('./restaurantVenueAccess');

const MIN_BODY = 20;
const MAX_BODY = 2000;
const LIVE_RESPONSE_STATUSES = ['PENDING', 'PUBLISHED'];
const VISIBLE_RESPONSE_STATUSES = ['PENDING', 'PUBLISHED', 'REJECTED'];

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;

function toResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    reviewId: row.reviewId,
    body: row.body,
    status: row.status,
    authorRole: row.authorRole,
    authorName: row.author ? row.author.name : null,
    authorPhoto: row.author ? row.author.photoURL || null : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    moderatedAt: row.moderatedAt ?? null,
    flagReason: row.flagReason ?? null,
  };
}

function toOwnerReview(row) {
  const response = (row.responses || [])[0] || null;
  return {
    id: row.id,
    rating: row.rating,
    foodRating: row.foodRating ?? null,
    serviceRating: row.serviceRating ?? null,
    atmosphereRating: row.atmosphereRating ?? null,
    valueRating: row.valueRating ?? null,
    title: row.title,
    body: row.body,
    photos: row.photos || [],
    companions: row.companions || [],
    visitedAt: row.visitedAt,
    createdAt: row.createdAt,
    verified: row.source === 'TRAVIO_VERIFIED',
    source: row.source,
    author: row.author
      ? { name: row.author.name, photo: row.author.photoURL || null }
      : null,
    response: toResponse(response),
    // Whether the diner has a reply at all. The UI uses this for the
    // "Needs a reply" queue; it is not derived from `response` because a
    // rejected reply still leaves the review unanswered.
    answered: Boolean(response && LIVE_RESPONSE_STATUSES.includes(response.status)),
  };
}

function reviewInclude() {
  return {
    author: { select: { name: true, photoURL: true } },
    responses: {
      where: { status: { in: VISIBLE_RESPONSE_STATUSES } },
      orderBy: { createdAt: 'desc' },
      take: 1,
      include: { author: { select: { name: true, photoURL: true } } },
    },
  };
}

function assertReplyBody(value) {
  const body = String(value || '').trim();
  if (body.length < MIN_BODY) {
    throw new AppError(`A reply needs at least ${MIN_BODY} characters`, 400, {
      code: 'REPLY_TOO_SHORT',
      details: { min: MIN_BODY },
    });
  }
  if (body.length > MAX_BODY) {
    throw new AppError(`A reply can be at most ${MAX_BODY} characters`, 400, {
      code: 'REPLY_TOO_LONG',
      details: { max: MAX_BODY },
    });
  }
  if (URL_PATTERN.test(body)) {
    throw new AppError('Remove the link from your reply', 400, {
      code: 'REPLY_CONTAINS_URL',
    });
  }
  if (EMAIL_PATTERN.test(body)) {
    throw new AppError('Remove the email address from your reply', 400, {
      code: 'REPLY_CONTAINS_EMAIL',
    });
  }
  return body;
}

/**
 * Owner-facing review list. Only approved reviews are visible: an owner cannot
 * see (or reply to) a review that is still in moderation, which keeps the
 * moderation queue out of the business's influence.
 */
async function listVenueReviews(context, { filter = 'all', rating, sort = 'newest', limit = 20, cursor } = {}) {
  assertPermission(context, 'reviews.reply');
  const venueId = context.venue.id;

  const where = { venueId, status: 'APPROVED' };
  if (rating) where.rating = rating;

  if (filter === 'unanswered') {
    where.responses = { none: { status: { in: LIVE_RESPONSE_STATUSES } } };
  } else if (filter === 'pending') {
    where.responses = { some: { status: 'PENDING' } };
  } else if (filter === 'replied') {
    where.responses = { some: { status: 'PUBLISHED' } };
  } else if (filter === 'negative') {
    where.rating = { lte: 3 };
  }

  const orderBy =
    sort === 'oldest'
      ? [{ createdAt: 'asc' }, { id: 'asc' }]
      : sort === 'lowest'
        ? [{ rating: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: 'desc' }, { id: 'desc' }];

  // The cursor only applies to the newest-first ordering; a rating sort has no
  // stable (createdAt, id) keyset and is capped instead.
  const decoded = cursor && sort === 'newest' ? decodeReviewCursor(cursor) : null;
  if (decoded) {
    where.OR = [
      { createdAt: { lt: decoded.at } },
      { AND: [{ createdAt: decoded.at }, { id: { lt: decoded.id } }] },
    ];
  }

  const rows = await prisma.restaurantVenueReview.findMany({
    where,
    orderBy,
    take: limit + 1,
    include: reviewInclude(),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const [total, unanswered, negative, pending] = await Promise.all([
    prisma.restaurantVenueReview.count({ where: { venueId, status: 'APPROVED' } }),
    prisma.restaurantVenueReview.count({
      where: {
        venueId,
        status: 'APPROVED',
        responses: { none: { status: { in: LIVE_RESPONSE_STATUSES } } },
      },
    }),
    prisma.restaurantVenueReview.count({
      where: { venueId, status: 'APPROVED', rating: { lte: 3 } },
    }),
    prisma.restaurantVenueReview.count({
      where: { venueId, status: 'APPROVED', responses: { some: { status: 'PENDING' } } },
    }),
  ]);

  return {
    reviews: page.map(toOwnerReview),
    counts: { total, unanswered, negative, pending },
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last && sort === 'newest'
          ? encodeCursor({ c: last.createdAt.toISOString(), id: last.id })
          : null,
    },
  };
}

async function getReview(context, reviewId) {
  assertPermission(context, 'reviews.reply');
  const review = await prisma.restaurantVenueReview.findFirst({
    where: { id: reviewId, venueId: context.venue.id, status: 'APPROVED' },
    include: reviewInclude(),
  });
  if (!review) throw new AppError('Review not found', 404, { code: 'REVIEW_NOT_FOUND' });
  return toOwnerReview(review);
}

async function createResponse(context, { reviewId, body }, req) {
  assertPermission(context, 'reviews.reply');
  const venueId = context.venue.id;
  const clean = assertReplyBody(body);

  const review = await prisma.restaurantVenueReview.findFirst({
    where: { id: reviewId, venueId, status: 'APPROVED' },
    select: { id: true, authorId: true, rating: true },
  });
  if (!review) throw new AppError('Review not found', 404, { code: 'REVIEW_NOT_FOUND' });
  if (review.authorId === context.membership.userId) {
    throw new AppError('You cannot reply to your own review', 400, {
      code: 'CANNOT_REPLY_TO_OWN_REVIEW',
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    // Re-checked inside the transaction: two tabs posting at once must not
    // produce two live replies, and there is no partial unique index for it.
    const live = await tx.restaurantVenueReviewResponse.findFirst({
      where: { reviewId: review.id, status: { in: LIVE_RESPONSE_STATUSES } },
      select: { id: true },
    });
    if (live) {
      throw new AppError('This review already has a reply', 409, {
        code: 'RESPONSE_ALREADY_EXISTS',
      });
    }
    return tx.restaurantVenueReviewResponse.create({
      data: {
        reviewId: review.id,
        venueId,
        authorId: context.membership.userId,
        authorRole: context.membership.role,
        body: clean,
        status: 'PENDING',
      },
      include: { author: { select: { name: true, photoURL: true } } },
    });
  });

  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantReviewResponse.submitted',
    resource: 'RestaurantVenueReviewResponse',
    resourceId: created.id,
    metadata: { venueId, reviewId: review.id, role: context.membership.role },
  });
  enqueueEvent({
    name: 'restaurant_review_response.submitted',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantVenueReviewResponse',
    resourceId: created.id,
    properties: { venueId, reviewId: review.id },
  });
  notifyAdmin({
    type: 'RESTAURANT_REVIEW_RESPONSE_PENDING',
    title: 'Owner reply needs moderation',
    message: `A reply to a ${review.rating}-star review of ${context.venue.name} is waiting for approval.`,
    data: { responseId: created.id, venueId, reviewId: review.id },
  }).catch((err) => logger.warn('[admin] response notification failed:', err?.message));

  return toResponse(created);
}

async function deleteResponse(context, { responseId }, req) {
  assertPermission(context, 'reviews.reply');
  const venueId = context.venue.id;

  const response = await prisma.restaurantVenueReviewResponse.findFirst({
    where: { id: responseId, venueId },
  });
  if (!response) throw new AppError('Reply not found', 404, { code: 'RESPONSE_NOT_FOUND' });
  if (response.status === 'REMOVED') {
    throw new AppError('This reply was already deleted', 409, {
      code: 'RESPONSE_ALREADY_REMOVED',
    });
  }

  const updated = await prisma.restaurantVenueReviewResponse.update({
    where: { id: response.id },
    data: {
      status: 'REMOVED',
      flagReason: 'deleted_by_venue',
      moderatedBy: context.membership.userId,
      moderatedAt: new Date(),
    },
    include: { author: { select: { name: true, photoURL: true } } },
  });

  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantReviewResponse.removed',
    resource: 'RestaurantVenueReviewResponse',
    resourceId: response.id,
    metadata: {
      venueId,
      reviewId: response.reviewId,
      previousStatus: response.status,
    },
  });
  enqueueEvent({
    name: 'restaurant_review_response.removed',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantVenueReviewResponse',
    resourceId: response.id,
    properties: { venueId, reviewId: response.reviewId },
  });

  return toResponse(updated);
}

/** Admin moderation. Publishing is the only transition that makes it public. */
async function moderateResponse({ responseId, adminId, action, reason, req }) {
  const statuses = { publish: 'PUBLISHED', reject: 'REJECTED' };
  const nextStatus = statuses[action];
  if (!nextStatus) {
    throw new AppError('Invalid moderation action', 400, {
      code: 'INVALID_MODERATION_ACTION',
    });
  }

  const response = await prisma.restaurantVenueReviewResponse.findUnique({
    where: { id: responseId },
    include: {
      venue: { select: { id: true, slug: true, name: true } },
      review: { select: { id: true, rating: true } },
    },
  });
  if (!response) throw new AppError('Reply not found', 404, { code: 'RESPONSE_NOT_FOUND' });
  if (response.status !== 'PENDING') {
    throw new AppError('This reply has already been moderated', 409, {
      code: 'RESPONSE_ALREADY_MODERATED',
    });
  }

  const updated = await prisma.restaurantVenueReviewResponse.update({
    where: { id: response.id },
    data: {
      status: nextStatus,
      moderatedBy: adminId,
      moderatedAt: new Date(),
      flagReason: action === 'reject' ? reason || 'rejected' : null,
    },
    include: { author: { select: { name: true, photoURL: true } } },
  });

  await logActivity({
    userId: adminId,
    action: `restaurantReviewResponse.${action}`,
    resource: 'RestaurantVenueReviewResponse',
    resourceId: response.id,
    metadata: {
      venueId: response.venueId,
      reviewId: response.reviewId,
      reason: reason || null,
    },
  });
  enqueueEvent({
    name: `restaurant_review_response.${action}`,
    userId: adminId,
    req,
    resource: 'RestaurantVenueReviewResponse',
    resourceId: response.id,
    properties: { venueId: response.venueId, reviewId: response.reviewId },
  });
  enqueueNotification({
    userId: response.authorId,
    type: 'RESTAURANT_REVIEW_RESPONSE_UPDATE',
    title: action === 'publish' ? 'Your reply is live' : 'Your reply was not published',
    message:
      action === 'publish'
        ? `Your reply to a review of ${response.venue.name} is now visible.`
        : `A moderator did not publish your reply to a review of ${response.venue.name}.`,
    data: { responseId: response.id, venueId: response.venueId },
  }).catch((err) => logger.warn('[notification] response update failed:', err?.message));

  return toResponse(updated);
}

async function listPendingResponses({ limit = 20, cursor } = {}) {
  const decoded = cursor ? decodeReviewCursor(cursor) : null;
  const where = { status: 'PENDING' };
  if (decoded) {
    where.OR = [
      { createdAt: { lt: decoded.at } },
      { AND: [{ createdAt: decoded.at }, { id: { lt: decoded.id } }] },
    ];
  }

  const rows = await prisma.restaurantVenueReviewResponse.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: {
      venue: { select: { name: true, slug: true } },
      review: { select: { id: true, rating: true, title: true, body: true } },
      author: { select: { name: true, email: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    responses: page.map((row) => ({
      ...toResponse(row),
      venueName: row.venue ? row.venue.name : null,
      venueSlug: row.venue ? row.venue.slug : null,
      review: row.review
        ? {
            id: row.review.id,
            rating: row.review.rating,
            title: row.review.title,
            body: row.review.body,
          }
        : null,
      authorEmail: row.author ? row.author.email : null,
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

module.exports = {
  MIN_BODY,
  MAX_BODY,
  listVenueReviews,
  getReview,
  createResponse,
  deleteResponse,
  moderateResponse,
  listPendingResponses,
};
