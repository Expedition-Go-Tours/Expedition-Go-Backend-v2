const crypto = require('crypto');
const cache = require('./cacheHelper');
const logger = require('./logger');
const geoapify = require('../../../providers/geoapifyProvider');
const serpApi = require('../../../providers/serpApiProvider');
const nominatim = require('../../../providers/nominatimProvider');
const photon = require('../../../providers/photonProvider');
const normalizer = require('./locationNormalizer');

const TTL = {
  SEARCH: 60 * 60 * 24,
  AUTOCOMPLETE: 60 * 60 * 24,
  REVERSE: 60 * 60 * 24 * 7,
  NEARBY: 60 * 60,
  // Google Maps results are stable and every uncached lookup is a paid
  // SerpApi credit — keep them as long as ordinary search results.
  GOOGLE: 60 * 60 * 24,
};

const DEDUP_THRESHOLD = 0.01;

function cacheKey(prefix, ...parts) {
  const input = parts.join(':').toLowerCase();
  const hash = crypto.createHash('md5').update(input).digest('hex');
  // `v2` bumps the namespace: the v1 provider used Geoapify's `format=json`
  // (which the normalizer couldn't parse), so v1 cache entries may be stale
  // empty results. Versioning invalidates them without a manual cache flush.
  return `geo:v2:${prefix}:${hash}`;
}

function isSameLocation(a, b) {
  if (a.latitude != null && a.longitude != null && b.latitude != null && b.longitude != null) {
    return (
      Math.abs(a.latitude - b.latitude) < DEDUP_THRESHOLD &&
      Math.abs(a.longitude - b.longitude) < DEDUP_THRESHOLD
    );
  }
  return a.formatted.toLowerCase() === b.formatted.toLowerCase();
}

function deduplicate(results) {
  const seen = [];
  return results.filter((item) => {
    const dup = seen.some((existing) => isSameLocation(existing, item));
    if (!dup) seen.push(item);
    return !dup;
  });
}

async function mergeProviders(providerFns, limit) {
  const settled = await Promise.allSettled(providerFns.map((fn) => fn()));

  const allResults = [];
  for (const result of settled) {
    if (result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0) {
      allResults.push(...result.value);
    } else if (result.status === 'rejected') {
      logger.warn(`[Location] Provider failed: ${result.reason.message}`);
    }
  }

  return deduplicate(allResults).slice(0, limit);
}

async function withFallback(fns) {
  let lastError = null;
  for (const fn of fns) {
    try {
      const result = await fn();
      if (result && result.length > 0) return result;
    } catch (err) {
      lastError = err;
      logger.warn(`[Location] Provider failed: ${err.message}`);
    }
  }
  throw lastError || new Error('All location providers failed');
}

async function search(query, limit = 5) {
  const key = cacheKey('search', query, String(limit));
  return cache.getOrSet(key, async () => {
    return mergeProviders([
      async () => {
        const raw = await geoapify.search(query, limit);
        return normalizer.normalizeGeoapifyResponse(raw);
      },
      async () => {
        const raw = await nominatim.search(query, limit);
        return normalizer.normalizeNominatimResponse(raw);
      },
      async () => {
        const raw = await photon.search(query, limit);
        return normalizer.normalizePhotonResponse(raw);
      },
    ], limit);
  }, TTL.SEARCH, { cacheEmpty: false });
}

async function autocomplete(query, limit = 5) {
  const key = cacheKey('autocomplete', query, String(limit));
  return cache.getOrSet(key, async () => {
    return mergeProviders([
      async () => {
        const raw = await geoapify.autocomplete(query, limit);
        return normalizer.normalizeGeoapifyResponse(raw);
      },
      async () => {
        const raw = await nominatim.search(query, limit);
        return normalizer.normalizeNominatimResponse(raw);
      },
      async () => {
        const raw = await photon.search(query, limit);
        return normalizer.normalizePhotonResponse(raw);
      },
    ], limit);
  }, TTL.AUTOCOMPLETE, { cacheEmpty: false });
}

/**
 * Google Maps (SerpApi) search — the explicit fallback for places none of the
 * free providers know. Never part of the automatic merge: it costs a credit
 * per uncached lookup, so the UI offers it as a deliberate "search Google Maps"
 * action rather than spending credits on every empty keystroke.
 *
 * The RESULT SET (including "no results") is cached, so re-clicking the same
 * search is free. Failures are never cached: a quota blip must not lock the
 * feature out for the whole TTL. Returns the storefront's contract —
 * `{ ok: true, results } | { ok: false, reason }` — so `not_configured` and
 * `quota` reach the UI as themselves and can never be read as "no matches".
 */
async function googleSearch(query, origin = null) {
  const q = String(query || '').trim();
  if (q.length < 3) return { ok: false, reason: 'invalid' };

  const originKey = origin ? `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}` : 'default';
  const key = cacheKey('google', q, originKey);

  try {
    const results = await cache.getOrSet(
      key,
      async () => {
        const raw = await serpApi.search(q, origin);
        if (!raw.ok) {
          const err = new Error(`Google Maps search unavailable: ${raw.reason}`);
          err.code = raw.reason;
          throw err;
        }
        return normalizer.normalizeSerpMapsResponse(raw.results);
      },
      TTL.GOOGLE,
      { cacheEmpty: true, cacheNull: false },
    );
    return { ok: true, results };
  } catch (err) {
    return { ok: false, reason: err.code || 'upstream' };
  }
}

async function reverse(lat, lng) {
  const key = cacheKey('reverse', String(lat), String(lng));
  return cache.getOrSet(key, async () => {
    return withFallback([
      async () => {
        const raw = await geoapify.reverse(lat, lng);
        const results = normalizer.normalizeGeoapifyResponse(raw);
        return results.length > 0 ? [results[0]] : [];
      },
      async () => {
        const raw = await nominatim.reverse(lat, lng);
        const normalized = normalizer.fromNominatim(raw);
        return normalized ? [normalized] : [];
      },
      async () => {
        const raw = await photon.reverse(lat, lng);
        const results = normalizer.normalizePhotonResponse(raw);
        return results.length > 0 ? [results[0]] : [];
      },
    ]);
  }, TTL.REVERSE);
}

async function nearby(lat, lng, radius = 10) {
  const key = cacheKey('nearby', String(lat), String(lng), String(radius));
  return cache.getOrSet(key, async () => {
    try {
      const raw = await geoapify.nearby(lat, lng, radius);
      return normalizer.normalizeGeoapifyResponse(raw);
    } catch (err) {
      logger.warn(`[Location] Geoapify nearby failed: ${err.message}`);
      return [];
    }
  }, TTL.NEARBY);
}

module.exports = { search, autocomplete, googleSearch, reverse, nearby };
