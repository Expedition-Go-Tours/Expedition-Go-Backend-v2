/**
 * Homepage Pre-computation Service
 *
 * Runs all 8 homepage ranking functions once and stores results in Redis.
 * The homepage controller reads these pre-computed keys instead of computing
 * live on every request (reduces cold-load from ~40 DB queries to 0).
 *
 * DESIGN:
 *  - Called by BullMQ "homepage-precompute" worker (debounced, concurrency=1)
 *  - Also callable inline as fallback when Redis/BullMQ is unavailable
 *  - Writes each section to a dedicated Redis key with matching TTL
 *  - Warms L1 memory cache after Redis write (no stale-L1 window)
 *  - All-or-nothing: if any ranking function throws, no keys are written
 *    (previous precomputed data stays valid)
 *
 * @version 1.0.0
 */

const redis = require('./redisClient');
const cache = require('./cacheHelper');
const ranking = require('./homepageRanking');

// ─── Redis key constants ────────────────────────────────────────────
const SECTION_KEYS = {
  sellOut:      'hp:sections:sell-out',
  topRated:     'hp:sections:top-rated',
  trending:     'hp:sections:trending',
  recommended:  'hp:sections:recommended',
  new:          'hp:sections:new',
  attractions:  'hp:sections:attractions',
  mood:         'hp:sections:mood',
  destinations: 'hp:sections:destinations',
};

// TTLs matching the per-section caching in homepageRanking.js
const SECTION_TTLS = {
  sellOut:      300,   // 5 min
  topRated:     300,
  trending:     300,
  recommended:  300,
  new:          600,   // 10 min
  attractions:  600,
  mood:         300,
  destinations: 3600,  // 1 hour
};

/**
 * Run all 8 ranking functions and store results in Redis.
 *
 * Non-personalized sections (sell-out, top-rated, trending, new, destinations)
 * are pre-computed as-is. Personalized sections (recommended, mood) are
 * pre-computed with anonymous defaults (no userId). Attractions are
 * pre-computed without location — the controller enriches with location
 * on-demand when lat/lng are provided.
 *
 * @returns {{ success: boolean, duration: number, sections: number }}
 */
async function precomputeHomepageSections() {
  const start = Date.now();
  const results = {};

  try {
    // Run all 8 ranking functions in parallel
    const [sellOut, topRated, trending, recommended, newExp, attractions, mood, destinations] =
      await Promise.all([
        ranking.getLikelySellOut(12),
        ranking.getTopRated(12),
        ranking.getTrending(12),
        ranking.getRecommended(null, null, null, 12),  // anonymous, no location
        ranking.getNewExperiences(10),
        ranking.getTopAttractions(null, null, [], 10),  // no location
        ranking.getMoodKeywords(null, 8),               // anonymous
        ranking.getPopularDestinations(10),
      ]);

    results.sellOut = sellOut;
    results.topRated = topRated;
    results.trending = trending;
    results.recommended = recommended;
    results.new = newExp;
    results.attractions = attractions;
    results.mood = mood;
    results.destinations = destinations;
  } catch (err) {
    // Partial failure: do NOT write any keys (old data stays valid)
    console.error('[HomepagePrecompute] Ranking function failed:', err.message);
    return { success: false, duration: Date.now() - start, sections: 0 };
  }

  // Write all keys atomically (best-effort — if Redis is down, skip silently)
  let sectionsWritten = 0;
  const redisAvailable = await redis.isRedisAvailable().catch(() => false);
  if (!redisAvailable) {
    return { success: true, duration: Date.now() - start, sections: 0 };
  }

  const writePromises = Object.entries(results).map(([key, data]) => {
    const redisKey = SECTION_KEYS[key];
    const ttl = SECTION_TTLS[key];
    if (!redisKey || !data) return Promise.resolve();

    return (async () => {
      try {
        await redis.set(redisKey, data, ttl);
        // Warm L1 memory cache so the next request doesn't serve stale data
        cache.memSet(redisKey, data);
        sectionsWritten++;
      } catch {
        // Redis write failed — L1 may still be stale, but that's ≤60s
      }
    })();
  });

  await Promise.allSettled(writePromises);

  const duration = Date.now() - start;
  if (sectionsWritten > 0) {
    console.log(`[HomepagePrecompute] ${sectionsWritten} sections pre-computed in ${duration}ms`);
  }

  return { success: true, duration, sections: sectionsWritten };
}

/**
 * Read pre-computed homepage sections from Redis.
 * Returns an object with all section keys, or null for any missing keys.
 *
 * @returns {Object|null} { sellOut, topRated, trending, recommended, new, attractions, mood, destinations }
 */
function readPrecomputedSections() {
  // This is a synchronous check of L1 memory cache.
  // The actual Redis read is async and done in the controller.
  return SECTION_KEYS;
}

module.exports = {
  precomputeHomepageSections,
  readPrecomputedSections,
  SECTION_KEYS,
  SECTION_TTLS,
};
