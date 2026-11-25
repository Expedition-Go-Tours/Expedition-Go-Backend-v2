/**
 * Restaurant venue aggregates.
 *
 * Kept separate from `externalReviewCombine.js` on purpose. Tours count
 * TripAdvisor + GetYourGuide and treat Google as display-only, because Google
 * has no tour products to match. For restaurants Google *is* the dominant
 * source, so it counts. Two policies in two modules means changing one cannot
 * silently re-rank the other.
 *
 * Three numbers, three jobs — this separation is the whole design:
 *
 *   averageRating   honest lifetime mean of our own approved reviews. The only
 *                   rating the API returns as stars.
 *   externalRating  one external source's official aggregate, returned with
 *                   its name so it is never mistaken for ours. Never blended.
 *   rankingScore    recency-blended Bayesian score. Orders lists. Never
 *                   displayed, because a ranking is not a rating.
 *   demandScore     internal booking-demand signal. Drives the "likely to book
 *                   out" rail; only its boolean top-quartile flag is public.
 *
 * Nothing here calls AVG() over the review table on a read path.
 */

const prisma = require('./prismaClient');

/** Sources whose official totals count toward the venue ranking number. */
const VENUE_COUNTED_SOURCES = ['GOOGLE', 'TRIPADVISOR'];

/**
 * Bayesian prior. A 5.0 from one reviewer must not outrank a 4.6 from four
 * hundred. m=3.9 is roughly the long-run mean of venue ratings; C=20 is the
 * review count at which the observed mean starts to outweigh the prior.
 * Tripadvisor's own guidance ("enough reviews for statistical significance")
 * implies a larger C for restaurants than for tours.
 */
const BAYES_PRIOR_MEAN = 3.9;
const BAYES_PRIOR_WEIGHT = 20;

/** How much of the ranking signal comes from the last 12 months. */
const RECENT_WEIGHT = 0.7;
const RECENT_WINDOW_DAYS = 365;

/**
 * Demand policy. Recent activity is the strongest signal, verified reviews and
 * the ranking score are supporting evidence, and total review volume gets only
 * a small square-root weight so an old, huge listing cannot dominate forever.
 * A venue needs at least three recent reviews before it can be flagged: one
 * five-star outlier must never put a quiet venue on the "booking out" rail.
 */
const DEMAND_MIN_RECENT_REVIEWS = 3;
const DEMAND_TOP_QUARTILE = 0.25;
const DEMAND_WEIGHTS = { recent: 1.5, verified: 0.5, combined: 0.25, ranking: 1 };

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Display rounding. Storage keeps four decimals so ranking keeps resolution. */
function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Weighted aggregate of a venue's per-platform official totals.
 *
 * Unlike the tour combiner this does not strip a 1★ bucket: that adjustment
 * existed because a scraped product page reported a 1★ slice inconsistently.
 * These are API aggregates, so the distribution is taken as given.
 */
function combineExternalStats(rows = []) {
  let count = 0;
  let sum = 0;

  for (const row of rows) {
    if (!row || !VENUE_COUNTED_SOURCES.includes(row.source)) continue;
    const reviewCount = Math.max(0, toNumber(row.reviewCount));
    const rating = toNumber(row.rating);
    if (reviewCount <= 0 || rating <= 0) continue;

    count += reviewCount;
    sum += rating * reviewCount;
  }

  if (count === 0) return { rating: 0, reviewCount: 0 };
  return { rating: round4(sum / count), reviewCount: count };
}

/**
 * The source shown on a card. Google will normally win on volume, which is the
 * right default: it is the aggregate a traveller can go and check.
 */
function primaryExternal(rows = []) {
  let best = null;
  for (const row of rows) {
    if (!row || !VENUE_COUNTED_SOURCES.includes(row.source)) continue;
    const reviewCount = Math.max(0, toNumber(row.reviewCount));
    const rating = toNumber(row.rating);
    if (reviewCount <= 0 || rating <= 0) continue;
    if (
      !best ||
      reviewCount > best.reviewCount ||
      (reviewCount === best.reviewCount && row.source < best.source)
    ) {
      best = { source: row.source, rating: round4(rating), reviewCount };
    }
  }
  return best;
}

/**
 * Recency-blended own rating. Falls back to the lifetime mean when there is no
 * recent window to speak of, so a venue with 3 reviews from 2019 is not
 * treated as if those 3 reviews happened last month.
 */
function blendedOwnRating({ averageRating, reviewCount, recentRating, recentReviewCount }) {
  const count = Math.max(0, toNumber(reviewCount));
  if (count === 0) return 0;

  const lifetime = toNumber(averageRating);
  const recentCount = Math.max(0, toNumber(recentReviewCount));
  const recent = toNumber(recentRating);

  if (recentCount === 0 || recent <= 0) return lifetime;
  return round4(RECENT_WEIGHT * recent + (1 - RECENT_WEIGHT) * lifetime);
}

/** Merge the venue's own reviews with its external aggregate. */
function combineVenueStats(inAppRating, inAppCount, external) {
  let count = 0;
  let sum = 0;

  const ownRating = toNumber(inAppRating);
  const ownCount = Math.max(0, toNumber(inAppCount));
  if (ownCount > 0 && ownRating > 0) {
    sum += ownRating * ownCount;
    count += ownCount;
  }

  if (external && external.reviewCount > 0 && external.rating > 0) {
    sum += external.rating * external.reviewCount;
    count += external.reviewCount;
  }

  if (count === 0) return { rating: 0, reviewCount: 0 };
  return { rating: Math.min(5, round4(sum / count)), reviewCount: count };
}

/**
 * Bayesian shrinkage of a combined rating. Returns null when there is nothing
 * to shrink — an unrated venue must sort last, not inherit a flattering 3.9.
 */
function bayesianRating(rating, reviewCount) {
  const count = Math.max(0, toNumber(reviewCount));
  const value = toNumber(rating);
  if (count === 0 || value <= 0) return null;
  return round4(
    (BAYES_PRIOR_WEIGHT * BAYES_PRIOR_MEAN + value * count) / (BAYES_PRIOR_WEIGHT + count),
  );
}

/**
 * Raw demand score from the stored columns only. Square roots damp the volume
 * terms: three recent reviews are meaningful, three thousand are not three
 * thousand times more meaningful. The score stays internal — the API exposes
 * `highDemand`, never this number.
 */
function computeDemandScore(venue = {}) {
  const recent = Math.max(0, toNumber(venue.recentReviewCount));
  const verified = Math.max(0, toNumber(venue.verifiedReviewCount));
  const combined = Math.max(0, toNumber(venue.combinedReviewCount));
  const ranking = Math.max(0, toNumber(venue.rankingScore));
  return round4(
    DEMAND_WEIGHTS.recent * Math.sqrt(recent) +
      DEMAND_WEIGHTS.verified * Math.sqrt(verified) +
      DEMAND_WEIGHTS.combined * Math.sqrt(combined) +
      DEMAND_WEIGHTS.ranking * ranking,
  );
}

/**
 * Which venues in one city are "likely to book out". Computed over the whole
 * city, never from one venue in isolation: the quartile moves when other
 * venues get reviews. Ties break on id so a re-run cannot shuffle the flag.
 *
 * @param {Array<{id: string, demandScore?: number, recentReviewCount?: number}>} rows
 * @returns {Set<string>} ids to flag
 */
function selectHighDemandVenueIds(rows = []) {
  const slots = Math.ceil(rows.length * DEMAND_TOP_QUARTILE);
  if (slots === 0) return new Set();

  const eligible = rows.filter(
    (row) =>
      row &&
      row.id &&
      toNumber(row.recentReviewCount) >= DEMAND_MIN_RECENT_REVIEWS &&
      toNumber(row.demandScore) > 0,
  );
  eligible.sort(
    (a, b) => toNumber(b.demandScore) - toNumber(a.demandScore) || String(a.id).localeCompare(String(b.id)),
  );
  return new Set(eligible.slice(0, slots).map((row) => row.id));
}

/**
 * Recompute and persist the derived columns for a set of venues.
 *
 * Single writer of combinedRating / combinedReviewCount / external* /
 * rankingScore / demandScore. Reads the stored in-app aggregate rather than
 * recounting rows: the write path owns that number, and a recount here would
 * turn every review approval into a table scan.
 *
 * Accepts a transaction client so a review-status change can keep the review
 * row and the venue aggregate in one atomic write.
 */
async function recomputeVenueStats(venueIds, client = prisma) {
  const ids = [...new Set((Array.isArray(venueIds) ? venueIds : []).filter(Boolean))];
  if (ids.length === 0) return 0;

  const [venues, statRows] = await Promise.all([
    client.restaurantVenue.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        averageRating: true,
        reviewCount: true,
        recentRating: true,
        recentReviewCount: true,
        verifiedReviewCount: true,
      },
    }),
    client.restaurantVenueExternalStat.findMany({
      where: { venueId: { in: ids }, source: { in: VENUE_COUNTED_SOURCES } },
      select: { venueId: true, source: true, rating: true, reviewCount: true },
    }),
  ]);

  const byVenue = new Map();
  for (const row of statRows) {
    if (!byVenue.has(row.venueId)) byVenue.set(row.venueId, []);
    byVenue.get(row.venueId).push(row);
  }

  let updated = 0;
  for (const venue of venues) {
    const rows = byVenue.get(venue.id) || [];
    const external = combineExternalStats(rows);
    const primary = primaryExternal(rows);
    const own = blendedOwnRating(venue);
    const combined = combineVenueStats(own, venue.reviewCount, external);
    const ranking = bayesianRating(combined.rating, combined.reviewCount);
    const demandScore = computeDemandScore({
      recentReviewCount: venue.recentReviewCount,
      verifiedReviewCount: venue.verifiedReviewCount,
      combinedReviewCount: combined.reviewCount,
      rankingScore: ranking,
    });

    await client.restaurantVenue.update({
      where: { id: venue.id },
      data: {
        combinedRating: combined.reviewCount > 0 ? combined.rating : null,
        combinedReviewCount: combined.reviewCount,
        externalSource: primary ? primary.source : null,
        externalRating: primary ? primary.rating : null,
        externalReviewCount: primary ? primary.reviewCount : 0,
        rankingScore: ranking,
        demandScore,
      },
    });
    updated += 1;
  }
  return updated;
}

/**
 * Recompute the 12-month window for a set of venues.
 *
 * This is the only place that aggregates review rows, and it runs in a batch
 * job rather than a request. Call it before recomputeVenueStats so the ranking
 * sees the new recent signal.
 */
async function recomputeRecentStats(venueIds, client = prisma) {
  const ids = [...new Set((Array.isArray(venueIds) ? venueIds : []).filter(Boolean))];
  if (ids.length === 0) return 0;

  const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const groups = await client.restaurantVenueReview.groupBy({
    by: ['venueId'],
    where: {
      venueId: { in: ids },
      status: 'APPROVED',
      createdAt: { gte: cutoff },
    },
    _avg: { rating: true },
    _count: { _all: true },
  });

  const byVenue = new Map(
    groups.map((row) => [
      row.venueId,
      {
        rating: row._avg && row._avg.rating != null ? round4(row._avg.rating) : null,
        count: row._count ? row._count._all : 0,
      },
    ]),
  );

  let updated = 0;
  for (const id of ids) {
    const recent = byVenue.get(id) || { rating: null, count: 0 };
    await client.restaurantVenue.update({
      where: { id },
      data: {
        recentRating: recent.count > 0 ? recent.rating : null,
        recentReviewCount: recent.count,
      },
    });
    updated += 1;
  }
  return updated;
}

/**
 * Recompute the ordinal position of every active venue in one city.
 *
 * Tripadvisor shows "#8 of 143 in Osu" rather than a raw score; the ordinal
 * moves when *other* venues in the city get reviews, which is why it is a
 * scheduled write rather than something computed per request.
 */
async function recomputeCityRanks(city, client = prisma) {
  if (!city) return 0;

  const venues = await client.restaurantVenue.findMany({
    where: { status: 'ACTIVE', city: { equals: city, mode: 'insensitive' } },
    select: { id: true, rankingScore: true },
    orderBy: [{ rankingScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
  });

  const total = venues.length;
  const computedAt = new Date();

  let position = 0;
  for (const venue of venues) {
    position += 1;
    await client.restaurantVenue.update({
      where: { id: venue.id },
      data: { rankInCity: position, cityVenueCount: total, rankComputedAt: computedAt },
    });
  }
  return total;
}

/** Every city that has at least one active venue. */
async function recomputeAllCityRanks(client = prisma) {
  const groups = await client.restaurantVenue.groupBy({
    by: ['city'],
    where: { status: 'ACTIVE', city: { not: null } },
    _count: { _all: true },
  });

  let cities = 0;
  for (const group of groups) {
    if (!group.city) continue;
    await recomputeCityRanks(group.city, client);
    cities += 1;
  }
  return cities;
}

/**
 * Flag the top quartile of one city as high demand. Runs after
 * recomputeVenueStats, so the scores it reads are the ones just stored. Like
 * the ordinal rank, this is a batch concern: a venue's flag depends on every
 * other venue in the city.
 *
 * Returns the number of venues written (including those cleared to false),
 * so a caller can tell the pass actually ran.
 */
async function recomputeCityDemand(city, client = prisma) {
  if (!city) return 0;

  const venues = await client.restaurantVenue.findMany({
    where: { status: 'ACTIVE', city: { equals: city, mode: 'insensitive' } },
    select: { id: true, demandScore: true, recentReviewCount: true },
  });

  const flagged = selectHighDemandVenueIds(venues);
  for (const venue of venues) {
    await client.restaurantVenue.update({
      where: { id: venue.id },
      data: { highDemand: flagged.has(venue.id) },
    });
  }
  return venues.length;
}

/** Demand pass for every city that has at least one active venue. */
async function recomputeAllCityDemand(client = prisma) {
  const groups = await client.restaurantVenue.groupBy({
    by: ['city'],
    where: { status: 'ACTIVE', city: { not: null } },
    _count: { _all: true },
  });

  let cities = 0;
  for (const group of groups) {
    if (!group.city) continue;
    await recomputeCityDemand(group.city, client);
    cities += 1;
  }
  return cities;
}

/**
 * Full batch pass used by both the nightly queue job and the maintenance
 * script. Keeping the order here means a manual run and a scheduled run cannot
 * disagree: recency and scores are stored first, then the city-wide demand
 * flags and ordinal ranks read those fresh scores.
 */
async function recomputeAllRestaurantRankings(client = prisma) {
  const venues = await client.restaurantVenue.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  });
  const ids = venues.map((venue) => venue.id);
  if (ids.length === 0) {
    return { venues: 0, recency: 0, aggregates: 0, demandCities: 0, rankCities: 0 };
  }

  const recency = await recomputeRecentStats(ids, client);
  const aggregates = await recomputeVenueStats(ids, client);
  const demandCities = await recomputeAllCityDemand(client);
  const rankCities = await recomputeAllCityRanks(client);
  return {
    venues: ids.length,
    recency,
    aggregates,
    demandCities,
    rankCities,
  };
}

module.exports = {
  VENUE_COUNTED_SOURCES,
  BAYES_PRIOR_MEAN,
  BAYES_PRIOR_WEIGHT,
  RECENT_WEIGHT,
  RECENT_WINDOW_DAYS,
  DEMAND_MIN_RECENT_REVIEWS,
  DEMAND_TOP_QUARTILE,
  DEMAND_WEIGHTS,
  computeDemandScore,
  selectHighDemandVenueIds,
  combineExternalStats,
  primaryExternal,
  blendedOwnRating,
  combineVenueStats,
  bayesianRating,
  recomputeVenueStats,
  recomputeRecentStats,
  recomputeCityRanks,
  recomputeAllCityRanks,
  recomputeCityDemand,
  recomputeAllCityDemand,
  recomputeAllRestaurantRankings,
  roundOne,
  round4,
  toNumber,
};
