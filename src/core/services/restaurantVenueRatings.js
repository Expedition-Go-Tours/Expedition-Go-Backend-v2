/**
 * Aggregate maintenance for restaurant reviews.
 *
 * Every change to an approved review goes through here, inside the same
 * transaction as the review row. The venue columns are updated incrementally
 * from the stored count and sum, so approval never scans the review table.
 * The read path only ever selects stored numbers.
 *
 * `recomputeVenueStats()` then derives the external headline and internal
 * ranking score from those numbers. It runs in the same transaction, which is
 * why a half-approved review cannot leave a half-updated rating behind.
 */

const { recomputeRecentStats, recomputeVenueStats, round4 } = require('./restaurantVenueStats');

const RATINGS = [1, 2, 3, 4, 5];

const VENUE_AGGREGATE_SELECT = {
  reviewCount: true,
  ratingSum: true,
  averageRating: true,
  verifiedReviewCount: true,
  distribution: true,
  lastReviewAt: true,
};

function storedSum(venue) {
  // Older curated rows can carry an average without a sum. Recover it once so
  // a later removal subtracts from the right total instead of going negative.
  if (venue.ratingSum > 0) return venue.ratingSum;
  return Math.round(Number(venue.averageRating || 0) * Number(venue.reviewCount || 0));
}

function distributionWith(distribution, rating, delta) {
  const next = {};
  for (const value of RATINGS) {
    const key = String(value);
    const current = distribution && distribution[key] != null ? Number(distribution[key]) : 0;
    next[key] = Math.max(0, (Number.isFinite(current) ? current : 0) + (value === rating ? delta : 0));
  }
  return next;
}

/** Persist the aggregate row first: the ranking recompute reads it back. */
async function refreshDerived(tx, venueId) {
  await recomputeRecentStats([venueId], tx);
  await recomputeVenueStats([venueId], tx);
}

async function addApprovedRating(tx, venueId, { rating, verified = false }) {
  const venue = await tx.restaurantVenue.findUnique({
    where: { id: venueId },
    select: VENUE_AGGREGATE_SELECT,
  });
  if (!venue) return null;

  const count = Number(venue.reviewCount || 0) + 1;
  const sum = storedSum(venue) + rating;

  await tx.restaurantVenue.update({
    where: { id: venueId },
    data: {
      reviewCount: count,
      ratingSum: sum,
      averageRating: round4(sum / count),
      verifiedReviewCount: Number(venue.verifiedReviewCount || 0) + (verified ? 1 : 0),
      distribution: distributionWith(venue.distribution, rating, 1),
      lastReviewAt: new Date(),
    },
  });

  await refreshDerived(tx, venueId);
  return count;
}

async function removeApprovedRating(tx, venueId, { rating, verified = false }) {
  const venue = await tx.restaurantVenue.findUnique({
    where: { id: venueId },
    select: VENUE_AGGREGATE_SELECT,
  });
  if (!venue) return null;

  const count = Math.max(0, Number(venue.reviewCount || 0) - 1);
  const sum = Math.max(0, storedSum(venue) - rating);

  await tx.restaurantVenue.update({
    where: { id: venueId },
    data: {
      reviewCount: count,
      ratingSum: sum,
      averageRating: count > 0 ? round4(sum / count) : null,
      verifiedReviewCount: Math.max(
        0,
        Number(venue.verifiedReviewCount || 0) - (verified ? 1 : 0),
      ),
      distribution: distributionWith(venue.distribution, rating, -1),
    },
  });

  await refreshDerived(tx, venueId);
  return count;
}

/**
 * Full rebuild from the review rows after a repair or a duplicate merge. Not
 * used on normal writes; that would turn one review submission into a scan.
 */
async function rebuildVenueRating(tx, venueId) {
  const groups = await tx.restaurantVenueReview.groupBy({
    by: ['rating'],
    where: { venueId, status: 'APPROVED' },
    _count: { _all: true },
  });
  const [verifiedCount, last] = await Promise.all([
    tx.restaurantVenueReview.count({
      where: { venueId, status: 'APPROVED', source: 'TRAVIO_VERIFIED' },
    }),
    tx.restaurantVenueReview.findFirst({
      where: { venueId, status: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  let count = 0;
  let sum = 0;
  const distribution = {};
  for (const value of RATINGS) distribution[String(value)] = 0;
  for (const group of groups) {
    const n = group._count ? group._count._all : 0;
    distribution[String(group.rating)] = n;
    count += n;
    sum += group.rating * n;
  }

  await tx.restaurantVenue.update({
    where: { id: venueId },
    data: {
      reviewCount: count,
      ratingSum: sum,
      averageRating: count > 0 ? round4(sum / count) : null,
      verifiedReviewCount: verifiedCount,
      distribution,
      lastReviewAt: last ? last.createdAt : null,
    },
  });

  await refreshDerived(tx, venueId);
  return count;
}

module.exports = {
  RATINGS,
  VENUE_AGGREGATE_SELECT,
  storedSum,
  distributionWith,
  addApprovedRating,
  removeApprovedRating,
  rebuildVenueRating,
};
