const redis = require('./redisClient');

const MEMORY_MAX = 100;
const MEMORY_TTL = 30;

const memCache = new Map();
const memTimestamps = new Map();

function memGet(key) {
  const ts = memTimestamps.get(key);
  if (!ts) return null;
  if (Date.now() - ts > MEMORY_TTL * 1000) {
    memCache.delete(key);
    memTimestamps.delete(key);
    return null;
  }
  return memCache.get(key) ?? null;
}

function memSet(key, data) {
  if (memCache.size >= MEMORY_MAX) {
    const oldest = memTimestamps.entries().next().value;
    if (oldest) {
      memCache.delete(oldest[0]);
      memTimestamps.delete(oldest[0]);
    }
  }
  memCache.set(key, data);
  memTimestamps.set(key, Date.now());
}

function memDel(pattern) {
  const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  for (const key of memCache.keys()) {
    if (re.test(key)) {
      memCache.delete(key);
      memTimestamps.delete(key);
    }
  }
}

function memDelKey(key) {
  memCache.delete(key);
  memTimestamps.delete(key);
}

function memClear() {
  memCache.clear();
  memTimestamps.clear();
}

let initPromise = null;
function ensureConnected() {
  if (!initPromise) {
    initPromise = redis.connect();
  }
  return initPromise;
}

async function getOrSet(key, fetchFn, ttlSeconds = 300) {
  const fromMem = memGet(key);
  if (fromMem !== null) return fromMem;

  await ensureConnected();

  const fromRedis = await redis.get(key);
  if (fromRedis !== null) {
    memSet(key, fromRedis);
    return fromRedis;
  }

  try {
    const data = await fetchFn();
    await redis.set(key, data, ttlSeconds);
    memSet(key, data);
    return data;
  } catch (err) {
    throw err;
  }
}

async function invalidateKeys(patterns) {
  for (const p of patterns) memDel(p);
  await ensureConnected();
  const jobs = patterns.map((p) => redis.delPattern(p));
  await Promise.allSettled(jobs);
}

async function invalidateKey(key) {
  memDelKey(key);
  await ensureConnected();
  await redis.del(key);
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
    await invalidateKey(TOUR_DETAIL_PREFIX(tourId));
  }
}

async function invalidateReviewCaches(tourId) {
  if (tourId) {
    await invalidateKeys([REVIEWS_TOUR_PREFIX(tourId)]);
  }
  await invalidateKeys([TOUR_LIST_PREFIX, TOUR_FILTERS_KEY]);
}

function _clearMemory() {
  memClear();
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
  REVIEWS_TOUR_PREFIX,
  _clearMemory
};
