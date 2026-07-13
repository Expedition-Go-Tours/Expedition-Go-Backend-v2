const redis = require('./redisClient');

const MEMORY_MAX = 100;
const MEMORY_TTL = 60;

const memCache = new Map();
const memTimestamps = new Map();

// In-flight fetch coalescing (singleflight) — prevents cache stampede
const inflight = new Map();

// Sentinel for caching null/undefined results (negative cache)
const NULL_SENTINEL = '__CACHE_NULL__';

function memGet(key) {
  const ts = memTimestamps.get(key);
  if (!ts) return undefined;
  if (Date.now() - ts > MEMORY_TTL * 1000) {
    memCache.delete(key);
    memTimestamps.delete(key);
    return undefined;
  }
  const val = memCache.get(key);
  if (val === NULL_SENTINEL) return NULL_SENTINEL;
  return val ?? undefined;
}

function memSet(key, data) {
  if (memCache.size >= MEMORY_MAX) {
    const oldest = memTimestamps.entries().next().value;
    if (oldest) {
      memCache.delete(oldest[0]);
      memTimestamps.delete(oldest[0]);
    }
  }
  memCache.set(key, data === null || data === undefined ? NULL_SENTINEL : data);
  memTimestamps.set(key, Date.now());
}

function memDel(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
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
    initPromise = redis.connect().then(() => {
      const client = redis.getClient();
      if (client) {
        client.on('close', () => {
          initPromise = null;
        });
      }
    }).catch(() => {
      // Reset so next call can retry reconnecting
      initPromise = null;
    });
  }
  return initPromise;
}

async function getOrSet(key, fetchFn, ttlSeconds = 300) {
  // L1: memory cache
  const fromMem = memGet(key);
  if (fromMem !== undefined) {
    if (fromMem === NULL_SENTINEL) return null;
    return fromMem;
  }

  // Try to connect but don't fail if Redis is unavailable
  try {
    await ensureConnected();
  } catch {
    // Redis unavailable, proceed without cache
  }

  // L2: Redis
  let fromRedis = undefined;
  try {
    const raw = await redis.get(key);
    if (raw === NULL_SENTINEL) {
      // Negative cache hit — this key was previously cached as null
      memSet(key, null);
      return null;
    } else if (raw !== null) {
      // Positive cache hit
      memSet(key, raw);
      return raw;
    }
    // raw === null → key doesn't exist in Redis, fall through to fetch
  } catch {
    // Redis read failed, proceed without cache
  }

  // Cache miss — singleflight: coalesce concurrent fetches for the same key
  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const promise = (async () => {
    try {
      const data = await fetchFn();

      // Store null results as sentinel to prevent repeated fetches
      const storeVal = data === null || data === undefined ? NULL_SENTINEL : data;
      try {
        await redis.set(key, storeVal, ttlSeconds);
      } catch {
        // Redis write failed
      }

      memSet(key, data);
      return data;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

async function invalidateKeys(patterns) {
  for (const p of patterns) memDel(p);
  try {
    await ensureConnected();
    const jobs = patterns.map((p) => redis.delPattern(p));
    await Promise.allSettled(jobs);
  } catch {
    // Redis unavailable, memory cache already cleared
  }
}

async function invalidateKey(key) {
  memDelKey(key);
  try {
    await ensureConnected();
    await redis.del(key);
  } catch {
    // Redis unavailable, memory cache already cleared
  }
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
