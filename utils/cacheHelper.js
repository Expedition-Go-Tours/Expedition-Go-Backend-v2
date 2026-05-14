const redis = require('./redisClient');

let initPromise = null;
function ensureConnected() {
  if (!initPromise) {
    initPromise = redis.connect();
  }
  return initPromise;
}

async function getOrSet(key, fetchFn, ttlSeconds = 300) {
  await ensureConnected();

  const cached = await redis.get(key);
  if (cached !== null) return cached;

  try {
    const data = await fetchFn();
    await redis.set(key, data, ttlSeconds);
    return data;
  } catch (err) {
    throw err;
  }
}

async function invalidateKeys(patterns) {
  await ensureConnected();
  const jobs = patterns.map((p) => redis.delPattern(p));
  await Promise.allSettled(jobs);
}

const TOUR_LIST_PREFIX = 'tours:list:*';
const TOUR_DETAIL_PREFIX = (id) => `tours:detail:${id}`;
const TOUR_FILTERS_KEY = 'tours:filters:options';
const TOUR_POPULAR_KEY = 'tours:popular:by-category';
const REVIEWS_TOUR_PREFIX = (tourId) => `reviews:tour:${tourId}:*`;

async function invalidateTourCaches(tourId) {
  await invalidateKeys([
    TOUR_LIST_PREFIX,
    TOUR_FILTERS_KEY,
    TOUR_POPULAR_KEY
  ]);
  if (tourId) {
    await redis.del(TOUR_DETAIL_PREFIX(tourId));
  }
}

async function invalidateReviewCaches(tourId) {
  if (tourId) {
    await invalidateKeys([REVIEWS_TOUR_PREFIX(tourId)]);
  }
  await invalidateKeys([TOUR_LIST_PREFIX, TOUR_FILTERS_KEY]);
}

module.exports = {
  getOrSet,
  invalidateKeys,
  invalidateTourCaches,
  invalidateReviewCaches,
  TOUR_LIST_PREFIX,
  TOUR_DETAIL_PREFIX,
  TOUR_FILTERS_KEY,
  TOUR_POPULAR_KEY,
  REVIEWS_TOUR_PREFIX
};
