/**
 * Owner dashboard aggregates.
 *
 * Everything here is computed from rows that actually exist. There is no
 * placeholder view counter, no invented competitor set and no "estimated"
 * metric: a restaurant with three reviews gets a three-review dashboard, and a
 * chart with no points is returned as an empty series rather than a flat line
 * at zero.
 *
 * The activity feed reads AuditLog but never returns it raw. IP addresses, user
 * agents, endpoint metadata and the hash chain stay internal; an owner sees who
 * did what, to which field, and when.
 */

const prisma = require('./prismaClient');
const { assertPermission, toSession } = require('./restaurantVenueAccess');
const { toMenu } = require('./restaurantVenueMenuService');

const DAY_MS = 24 * 60 * 60 * 1000;
const INSIGHT_PERIODS = [7, 30, 90, 365];

const ACTIVITY_CATEGORIES = {
  reviews: ['restaurantReview.', 'restaurantReviewResponse.'],
  photos: ['restaurantVenuePhoto.'],
  menu: ['restaurantMenu.'],
  team: ['restaurantVenueInvite.', 'restaurantVenueMember.'],
  business: ['restaurantVenue.', 'restaurantVenueClaim.'],
};

const ALL_ACTIVITY_PREFIXES = [
  ...new Set(Object.values(ACTIVITY_CATEGORIES).flat()),
];

/**
 * Fields safe to show an owner. `endpoint`, `ipAddress`, `userAgent`, hashes
 * and anything unrecognised are dropped rather than filtered per call site.
 */
const SAFE_METADATA_KEYS = [
  'fields',
  'previousStatus',
  'status',
  'rating',
  'reason',
  'photoId',
  'photoIds',
  'count',
  'menuId',
  'sections',
  'items',
  'currency',
  'role',
  'previousRole',
  'memberId',
  'inviteId',
  'reviewId',
  'toMemberId',
];

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const out = {};
  for (const key of SAFE_METADATA_KEYS) {
    if (metadata[key] !== undefined) out[key] = metadata[key];
  }
  return out;
}

function categoryFor(action) {
  for (const [category, prefixes] of Object.entries(ACTIVITY_CATEGORIES)) {
    if (prefixes.some((prefix) => action.startsWith(prefix))) return category;
  }
  return 'other';
}

function roundOne(value) {
  return value == null ? null : Math.round(Number(value) * 10) / 10;
}

function percent(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 100);
}

function hoursConfigured(hours) {
  if (!hours || typeof hours !== 'object') return false;
  return Object.values(hours).some((value) => {
    if (!value) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') {
      if (value.closed === true) return false;
      if (value.open && value.close) return true;
      if (Array.isArray(value.ranges)) return value.ranges.length > 0;
    }
    return false;
  });
}

function listingChecks(venue, { publishedPhotos, publishedMenus }) {
  return [
    {
      key: 'cover-photo',
      label: 'Add a cover photo',
      done: Boolean(venue.coverPhoto),
    },
    {
      key: 'photos',
      label: 'Add at least 3 photos',
      done: publishedPhotos >= 3,
    },
    {
      key: 'hours',
      label: 'Set your opening hours',
      done: hoursConfigured(venue.hours),
    },
    {
      key: 'menu',
      label: 'Publish a menu',
      done: publishedMenus > 0 || Boolean(venue.menuUrl),
    },
    {
      key: 'description',
      label: 'Write a description',
      done: Boolean(venue.description && venue.description.trim().length >= 120),
    },
    {
      key: 'phone',
      label: 'Add a phone number',
      done: Boolean(venue.phone),
    },
    {
      key: 'cuisines',
      label: 'Choose your cuisines',
      done: Array.isArray(venue.cuisines) && venue.cuisines.length > 0,
    },
  ];
}

const REVIEW_INCLUDE = {
  author: { select: { name: true, photoURL: true } },
  responses: {
    where: { status: { in: ['PENDING', 'PUBLISHED', 'REJECTED'] } },
    orderBy: { createdAt: 'desc' },
    take: 1,
    include: { author: { select: { name: true, photoURL: true } } },
  },
};

function toOverviewReview(row) {
  const response = (row.responses || [])[0] || null;
  return {
    id: row.id,
    rating: row.rating,
    title: row.title,
    body: row.body,
    photos: row.photos || [],
    createdAt: row.createdAt,
    verified: row.source === 'TRAVIO_VERIFIED',
    author: row.author ? { name: row.author.name, photo: row.author.photoURL || null } : null,
    response: response
      ? {
          id: response.id,
          body: response.body,
          status: response.status,
          authorRole: response.authorRole,
          authorName: response.author ? response.author.name : null,
          createdAt: response.createdAt,
          flagReason: response.flagReason ?? null,
        }
      : null,
    answered: Boolean(
      response && ['PENDING', 'PUBLISHED'].includes(response.status),
    ),
  };
}

/**
 * The overview answers three questions: which listing, what needs attention,
 * and what does the public see. It is one round trip so the page has no
 * staggered loading states.
 */
async function getOverview(context) {
  assertPermission(context, 'venue.edit');
  const venue = context.venue;
  const venueId = venue.id;

  const [
    totalReviews,
    unansweredReviews,
    negativeUnanswered,
    pendingReplies,
    reviewsWithPublishedReply,
    pendingPhotos,
    publishedPhotos,
    totalPhotos,
    publishedMenus,
    allMenus,
    activeMembers,
    pendingInvites,
    recentReviews,
  ] = await Promise.all([
    prisma.restaurantVenueReview.count({ where: { venueId, status: 'APPROVED' } }),
    prisma.restaurantVenueReview.count({
      where: {
        venueId,
        status: 'APPROVED',
        responses: { none: { status: { in: ['PENDING', 'PUBLISHED'] } } },
      },
    }),
    prisma.restaurantVenueReview.count({
      where: {
        venueId,
        status: 'APPROVED',
        rating: { lte: 3 },
        responses: { none: { status: { in: ['PENDING', 'PUBLISHED'] } } },
      },
    }),
    prisma.restaurantVenueReviewResponse.count({ where: { venueId, status: 'PENDING' } }),
    prisma.restaurantVenueReview.count({
      where: {
        venueId,
        status: 'APPROVED',
        responses: { some: { status: 'PUBLISHED' } },
      },
    }),
    prisma.restaurantVenuePhoto.count({ where: { venueId, status: 'PENDING' } }),
    prisma.restaurantVenuePhoto.count({ where: { venueId, status: 'PUBLISHED' } }),
    prisma.restaurantVenuePhoto.count({ where: { venueId } }),
    prisma.restaurantMenu.count({ where: { venueId, status: 'PUBLISHED' } }),
    prisma.restaurantMenu.findMany({
      where: { venueId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        sections: {
          orderBy: { position: 'asc' },
          include: { items: { orderBy: { position: 'asc' } } },
        },
      },
    }),
    prisma.restaurantVenueMember.count({ where: { venueId, status: 'ACTIVE' } }),
    prisma.restaurantVenueInvite.count({ where: { venueId, status: 'PENDING' } }),
    prisma.restaurantVenueReview.findMany({
      where: { venueId, status: 'APPROVED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      include: REVIEW_INCLUDE,
    }),
  ]);

  const checks = listingChecks(venue, { publishedPhotos, publishedMenus });
  const completed = checks.filter((check) => check.done).length;

  const attention = [];
  if (unansweredReviews > 0) {
    attention.push({
      key: 'unanswered-reviews',
      tone: 'warn',
      title: `${unansweredReviews} review${unansweredReviews === 1 ? '' : 's'} waiting for a reply`,
      detail:
        negativeUnanswered > 0
          ? `${negativeUnanswered} of them rated you 3 stars or lower.`
          : 'Replying is the fastest way to show diners you are listening.',
      action: { label: 'Reply to reviews', to: 'reviews', filter: 'unanswered' },
    });
  }
  if (pendingReplies > 0) {
    attention.push({
      key: 'pending-replies',
      tone: 'info',
      title: `${pendingReplies} repl${pendingReplies === 1 ? 'y is' : 'ies are'} in moderation`,
      detail: 'They appear beside the review once a moderator publishes them.',
      action: { label: 'View replies', to: 'reviews', filter: 'pending' },
    });
  }
  if (pendingPhotos > 0) {
    attention.push({
      key: 'pending-photos',
      tone: 'info',
      title: `${pendingPhotos} photo${pendingPhotos === 1 ? '' : 's'} in moderation`,
      detail: 'Photos go live after review. You can caption or reorder them now.',
      action: { label: 'Open photos', to: 'photos' },
    });
  }
  if (publishedMenus === 0 && !venue.menuUrl) {
    attention.push({
      key: 'no-menu',
      tone: 'warn',
      title: 'No menu published',
      detail: 'Diners check the menu before they book. Add yours section by section.',
      action: { label: 'Add a menu', to: 'menu' },
    });
  }
  if (!venue.coverPhoto) {
    attention.push({
      key: 'no-cover',
      tone: 'warn',
      title: 'No cover photo',
      detail: 'The cover is the first thing a diner sees in search results.',
      action: { label: 'Add photos', to: 'photos' },
    });
  }
  if (!hoursConfigured(venue.hours)) {
    attention.push({
      key: 'no-hours',
      tone: 'warn',
      title: 'Opening hours are missing',
      detail: 'Listings without hours show as unknown and lose the “Open now” signal.',
      action: { label: 'Set hours', to: 'hours' },
    });
  }

  const recentActivity = await getActivity(context, { limit: 5 });

  return {
    session: toSession(context),
    overview: {
      attention,
      stats: {
        rating: roundOne(venue.averageRating),
        reviewCount: venue.reviewCount || 0,
        verifiedReviewCount: venue.verifiedReviewCount || 0,
        rank:
          venue.rankInCity != null
            ? { position: venue.rankInCity, of: venue.cityVenueCount || null }
            : null,
        responseRate: percent(reviewsWithPublishedReply, totalReviews),
        unansweredReviews,
        pendingReplies,
        totalReviews,
        lastReviewAt: venue.lastReviewAt || null,
        publishedPhotos,
        pendingPhotos,
        totalPhotos,
        publishedMenus,
        teamMembers: activeMembers,
        pendingInvites,
      },
      completeness: {
        score: Math.round((completed / checks.length) * 100),
        completed,
        total: checks.length,
        checks,
      },
      recentReviews: recentReviews.map(toOverviewReview),
      recentActivity: recentActivity.activity,
      menus: allMenus.map(toMenu),
    },
  };
}

/** Lightweight shell payload: venue, role, permissions and badge counts. */
async function getSession(context) {
  const venueId = context.venue.id;
  const [unansweredReviews, pendingPhotos, pendingReplies] = await Promise.all([
    prisma.restaurantVenueReview.count({
      where: {
        venueId,
        status: 'APPROVED',
        responses: { none: { status: { in: ['PENDING', 'PUBLISHED'] } } },
      },
    }),
    prisma.restaurantVenuePhoto.count({ where: { venueId, status: 'PENDING' } }),
    prisma.restaurantVenueReviewResponse.count({ where: { venueId, status: 'PENDING' } }),
  ]);

  return {
    ...toSession(context),
    badges: { reviews: unansweredReviews, photos: pendingPhotos, pendingReplies },
  };
}

/**
 * Sanitized activity feed. Scoped to the venue by resource id or by the
 * `venueId` carried in the audit metadata, so one restaurant never sees another
 * restaurant's edits.
 */
async function getActivity(context, { limit = 20, cursor, type } = {}) {
  assertPermission(context, 'venue.edit');
  const venueId = context.venue.id;

  const prefixes = type && ACTIVITY_CATEGORIES[type]
    ? ACTIVITY_CATEGORIES[type]
    : ALL_ACTIVITY_PREFIXES;

  const where = {
    AND: [
      {
        OR: [
          { resource: 'RestaurantVenue', resourceId: venueId },
          { metadata: { path: ['venueId'], equals: venueId } },
        ],
      },
      { OR: prefixes.map((prefix) => ({ action: { startsWith: prefix } })) },
    ],
  };

  if (type === 'hours') {
    // Hours are written through the venue update, so narrow by the changed
    // fields rather than inventing a separate audit action.
    where.AND.push({
      metadata: { path: ['fields'], array_contains: ['hours'] },
    });
  }

  if (cursor) {
    const at = new Date(cursor);
    if (!Number.isNaN(at.getTime())) {
      where.AND.push({ createdAt: { lt: at } });
    }
  }

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      userId: true,
      action: true,
      resource: true,
      resourceId: true,
      metadata: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const userIds = [...new Set(page.map((row) => row.userId).filter(Boolean))];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((user) => [user.id, user.name]));

  return {
    activity: page.map((row) => ({
      id: row.id,
      action: row.action,
      category: categoryFor(row.action),
      actor: row.userId
        ? { id: row.userId, name: nameById.get(row.userId) || null }
        : null,
      target: row.resourceId,
      details: safeMetadata(row.metadata),
      createdAt: row.createdAt,
    })),
    pagination: {
      limit,
      hasMore,
      nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
    },
  };
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Insights over a real window, with the preceding window as the comparison.
 *
 * No impressions, views or competitor data: we do not collect them, so we do
 * not show them. Every number below has a matching query.
 */
async function getInsights(context, { days = 30 } = {}) {
  assertPermission(context, 'venue.edit');
  const venueId = context.venue.id;

  const windowDays = INSIGHT_PERIODS.includes(Number(days)) ? Number(days) : 30;
  const now = new Date();
  const start = new Date(now.getTime() - windowDays * DAY_MS);
  const previousStart = new Date(start.getTime() - windowDays * DAY_MS);

  const select = {
    rating: true,
    createdAt: true,
    source: true,
  };

  const [current, previous, responsesCurrent, responsesPrevious, photosCurrent, menus] =
    await Promise.all([
      prisma.restaurantVenueReview.findMany({
        where: { venueId, status: 'APPROVED', createdAt: { gte: start } },
        select,
        orderBy: { createdAt: 'asc' },
      }),
      prisma.restaurantVenueReview.findMany({
        where: {
          venueId,
          status: 'APPROVED',
          createdAt: { gte: previousStart, lt: start },
        },
        select,
      }),
      prisma.restaurantVenueReviewResponse.findMany({
        where: { venueId, status: 'PUBLISHED', createdAt: { gte: start } },
        select: { createdAt: true, reviewId: true },
      }),
      prisma.restaurantVenueReviewResponse.count({
        where: {
          venueId,
          status: 'PUBLISHED',
          createdAt: { gte: previousStart, lt: start },
        },
      }),
      prisma.restaurantVenuePhoto.count({
        where: { venueId, status: 'PUBLISHED', moderatedAt: { gte: start } },
      }),
      prisma.restaurantMenu.count({ where: { venueId, status: 'PUBLISHED' } }),
    ]);

  function summarise(rows) {
    if (!rows.length) {
      return { count: 0, averageRating: null, negative: 0, verified: 0, distribution: {} };
    }
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    let negative = 0;
    let verified = 0;
    for (const row of rows) {
      sum += row.rating;
      distribution[row.rating] = (distribution[row.rating] || 0) + 1;
      if (row.rating <= 3) negative += 1;
      if (row.source === 'TRAVIO_VERIFIED') verified += 1;
    }
    return {
      count: rows.length,
      averageRating: Math.round((sum / rows.length) * 10) / 10,
      negative,
      verified,
      distribution,
    };
  }

  const currentSummary = summarise(current);
  const previousSummary = summarise(previous);

  // Bucket by month across the whole window so the chart has a real x-axis even
  // when a month has no reviews (that month is a zero, not a missing point).
  const buckets = new Map();
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= now) {
    buckets.set(monthKey(cursor), { key: monthKey(cursor), reviews: 0, ratingSum: 0, negative: 0 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  for (const row of current) {
    const key = monthKey(row.createdAt);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.reviews += 1;
    bucket.ratingSum += row.rating;
    if (row.rating <= 3) bucket.negative += 1;
  }

  const series = [...buckets.values()].map((bucket) => ({
    key: bucket.key,
    label: monthLabel(bucket.key),
    reviews: bucket.reviews,
    averageRating: bucket.reviews
      ? Math.round((bucket.ratingSum / bucket.reviews) * 10) / 10
      : null,
    negative: bucket.negative,
  }));

  const repliesCurrent = responsesCurrent.length;
  const currentResponseRate = percent(
    new Set(responsesCurrent.map((row) => row.reviewId)).size,
    currentSummary.count,
  );
  const previousResponseRate = percent(responsesPrevious, previousSummary.count);

  function delta(currentValue, previousValue) {
    if (currentValue == null || previousValue == null) return null;
    return Math.round((currentValue - previousValue) * 10) / 10;
  }

  return {
    period: {
      days: windowDays,
      start,
      end: now,
      comparisonStart: previousStart,
      comparisonEnd: start,
    },
    current: {
      ...currentSummary,
      replies: repliesCurrent,
      responseRate: currentResponseRate,
      publishedPhotos: photosCurrent,
    },
    previous: {
      ...previousSummary,
      replies: responsesPrevious,
      responseRate: previousResponseRate,
    },
    deltas: {
      reviews: currentSummary.count - previousSummary.count,
      rating: delta(currentSummary.averageRating, previousSummary.averageRating),
      responseRate:
        currentResponseRate == null || previousResponseRate == null
          ? null
          : currentResponseRate - previousResponseRate,
    },
    series,
    publishedMenus: menus,
    // Explicit so the UI can say "not enough data yet" instead of drawing an
    // empty chart.
    hasData: currentSummary.count > 0,
  };
}

module.exports = {
  INSIGHT_PERIODS,
  ACTIVITY_CATEGORIES,
  getOverview,
  getSession,
  getActivity,
  getInsights,
};
