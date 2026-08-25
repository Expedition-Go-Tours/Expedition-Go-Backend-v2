/**
 * Shared Tour View Tracking Guard
 *
 * Single source of truth for deciding whether a tour page view should be
 * counted. Used by both the public tour detail endpoint (tourController)
 * and the expedition tour detail endpoint (expeditionController).
 *
 * RULE — only external audiences count toward a tour's viewCount:
 *   - Anonymous visitors                       → count
 *   - Tour owner                               → skip
 *   - Admin / Expedition (internal staff)      → skip
 *   - Supplier with an ACTIVE SupplierProfile  → skip
 *   - Customers (any other authenticated user) → count
 *   - Crawlers + social link-preview bots      → skip
 *
 * Dedup: each viewer is counted at most once per TOUR per 30 minutes, so
 * browsing several tours of the same supplier counts each of them.
 * Counting state lives in Redis (atomic SET NX, survives restarts, works
 * across instances) with an in-process Map fallback so counting degrades
 * gracefully when Redis is unavailable.
 *
 * Identity: authenticated users use their DB id. Anonymous visitors are
 * identified by a SHA-256 hash of their real IP address (raw IPs are never
 * stored). The same IP always maps to the same fingerprint regardless of
 * browser or User-Agent.
 *
 * @author Tour Platform Team
 * @version 2.0.0
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const redis = require('./redisClient');

const VIEW_COOLDOWN_SECONDS = 30 * 60; // 30-minute cooldown per viewer per tour
const MEMORY_FALLBACK_MAX = 10000;
const SUPPLIER_PROFILE_CACHE_TTL = 300;

const memoryFallback = new Map();

/**
 * User-Agent patterns of crawlers and social link-preview bots. These hit
 * tour detail endpoints like real users (and rotate IPs), so they would
 * otherwise inflate viewCount and pollute the analytics events.
 */
const BOT_UA_PATTERNS = [
  'googlebot',
  'bingbot',
  'duckduckbot',
  'bytespider',
  'slurp',
  'baiduspider',
  'yandex',
  'facebookexternalhit',
  'twitterbot',
  'linkedinbot',
  'slackbot',
  'whatsapp',
  'telegrambot',
  'discordbot',
  'pinterestbot',
  'applebot',
  'semrushbot',
  'ahrefsbot',
  'petalbot',
].map((p) => new RegExp(p, 'i'));

function isBotUA(userAgent = '') {
  return BOT_UA_PATTERNS.some((re) => re.test(userAgent));
}

/**
 * Extract the real client IP from the request, respecting X-Forwarded-For
 * behind proxies/load balancers. Returns 'unknown' as a last resort.
 */
function getRealIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown'
  );
}

/**
 * Build a stable viewer fingerprint.
 * Authenticated users use their DB id; anonymous visitors use a SHA-256
 * hash of their IP address. Raw IPs are never stored. The same IP always
 * produces the same fingerprint regardless of browser or User-Agent.
 */
function getViewerFingerprint(req) {
  if (req.user?.id) return req.user.id;
  const realIp = getRealIp(req);
  return `ip:${crypto.createHash('sha256').update(realIp).digest('hex').slice(0, 16)}`;
}

/**
 * Resolve the viewer's geographic location from their IP using geoip-lite.
 * Returns { country, region, city, timezone } or null when the IP cannot
 * be resolved (e.g. private IPs, localhost, missing geoip-lite data).
 */
let geoip;
try {
  geoip = require('geoip-lite');
} catch {
  geoip = null;
}

function getViewerGeo(req) {
  if (!geoip) return null;
  const realIp = getRealIp(req);
  if (!realIp || realIp === 'unknown' || realIp === '127.0.0.1' || realIp === '::1') return null;
  const geo = geoip.lookup(realIp);
  if (!geo) return null;
  return {
    country: geo.country || null,
    region: geo.region || null,
    city: geo.city || null,
    timezone: geo.timezone || null,
  };
}

/**
 * True when the authenticated user has the supplier role AND an ACTIVE
 * SupplierProfile. Only ACTIVE suppliers are treated as internal — PENDING,
 * UNDER_REVIEW, APPROVED, SUSPENDED and REJECTED profiles still count as
 * ordinary viewers.
 *
 * The profile lookup is cached (memory + Redis) so this costs one DB hit per
 * supplier per TTL window at most.
 */
async function isActiveSupplier(user) {
  if (!user?.id || !user.roles?.includes('supplier')) return false;
  const profile = await cache.getOrSet(
    `supplier:profile:status:userId:${user.id}`,
    () => prisma.supplierProfile.findFirst({
      where: { userId: user.id },
      select: { status: true },
    }),
    SUPPLIER_PROFILE_CACHE_TTL
  );
  return profile?.status === 'ACTIVE';
}

/**
 * True when the viewer is an internal (non-audience) account.
 * Anonymous visitors always return false (they count).
 */
async function isInternalViewer(user) {
  if (!user?.id) return false;
  if (user.roles?.includes('admin')) return true;
  if (user.roles?.includes('expedition')) return true;
  if (user.roles?.includes('supplier')) return isActiveSupplier(user);
  return false;
}

/**
 * In-memory dedup fallback used only when Redis is unavailable.
 * Same semantics as the Redis path: at most one count per viewer per cooldown.
 */
function memoryDedup(key) {
  const now = Date.now();
  const last = memoryFallback.get(key);
  if (last && now - last < VIEW_COOLDOWN_SECONDS * 1000) return false;

  if (memoryFallback.size >= MEMORY_FALLBACK_MAX) {
    const cutoff = now - VIEW_COOLDOWN_SECONDS * 1000;
    for (const [k, t] of memoryFallback.entries()) {
      if (t < cutoff) memoryFallback.delete(k);
    }
    if (memoryFallback.size >= MEMORY_FALLBACK_MAX) {
      const iter = memoryFallback.keys();
      for (let i = 0; i < 1000; i++) {
        const keyVal = iter.next().value;
        if (keyVal) memoryFallback.delete(keyVal);
        else break;
      }
    }
  }

  memoryFallback.set(key, now);
  return true;
}

/**
 * Decide whether this request should be counted as a view for the tour.
 *
 * @param {Object}   options
 * @param {import('express').Request}  options.req
 * @param {string}   options.tourSupplierId — id of the tour's owning supplier
 * @param {string}   options.tourId — id of the tour being viewed (dedup scope)
 * @param {string}   [options.prefix] — dedup key prefix ("view" | "expedition:view")
 * @returns {Promise<{ counted: boolean, geo: object|null }>} result with geo data
 */
async function shouldCountTourView({ req, tourSupplierId, tourId, prefix = 'view' }) {
  // Never count the tour owner browsing their own listing.
  if (req.user?.id && req.user.id === tourSupplierId) return { counted: false, geo: null };

  // Never count crawlers / social link-preview bots.
  if (isBotUA(req.headers['user-agent'])) return { counted: false, geo: null };

  // Never count internal accounts (admin / expedition / active suppliers).
  if (await isInternalViewer(req.user)) return { counted: false, geo: null };

  const viewerId = getViewerFingerprint(req);
  const viewKey = `${prefix}:${tourId}:${viewerId}`;
  const geo = getViewerGeo(req);

  // Redis-backed atomic dedup: true = newly recorded, false = already counted.
  const redisResult = await redis.setnx(viewKey, VIEW_COOLDOWN_SECONDS);
  if (redisResult === true) return { counted: true, geo };
  if (redisResult === false) return { counted: false, geo };

  // Redis unavailable → best-effort in-memory dedup.
  if (!memoryDedup(viewKey)) return { counted: false, geo };
  return { counted: true, geo };
}

module.exports = { shouldCountTourView, isInternalViewer, getViewerGeo };
