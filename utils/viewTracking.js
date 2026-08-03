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
 *
 * Dedup: each viewer is counted at most once per 30 minutes. Dedup state
 * lives in Redis (atomic SET NX, survives restarts, works across instances)
 * with an in-process Map fallback so counting degrades gracefully when Redis
 * is unavailable.
 *
 * @author Tour Platform Team
 * @version 1.0.0
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const redis = require('./redisClient');

const VIEW_COOLDOWN_SECONDS = 30 * 60; // 30-minute cooldown per viewer
const MEMORY_FALLBACK_MAX = 10000;
const SUPPLIER_PROFILE_CACHE_TTL = 300;

const memoryFallback = new Map();

/**
 * Build a stable viewer fingerprint.
 * Authenticated users use their DB id; anonymous visitors use a hash of
 * their real IP + User-Agent (raw IPs are never stored).
 */
function getViewerFingerprint(req) {
  if (req.user?.id) return req.user.id;
  const realIp =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown';
  const ua = req.headers['user-agent'] || '';
  return crypto.createHash('sha256').update(`${realIp}:${ua}`).digest('hex').slice(0, 16);
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
 * @param {import('express').Request} options.req
 * @param {string}   options.tourSupplierId  — id of the tour's owning supplier
 * @param {string}   [options.prefix]        — dedup key prefix ("view" | "expedition:view")
 * @returns {Promise<boolean>} true when the view should be counted + recorded
 */
async function shouldCountTourView({ req, tourSupplierId, prefix = 'view' }) {
  // Never count the tour owner browsing their own listing.
  if (req.user?.id && req.user.id === tourSupplierId) return false;

  // Never count internal accounts (admin / expedition / active suppliers).
  if (await isInternalViewer(req.user)) return false;

  const viewerId = getViewerFingerprint(req);
  const viewKey = `${prefix}:${tourSupplierId}:${viewerId}`;

  // Redis-backed atomic dedup: true = newly recorded, false = already counted.
  const redisResult = await redis.setnx(viewKey, VIEW_COOLDOWN_SECONDS);
  if (redisResult === true) return true;
  if (redisResult === false) return false;

  // Redis unavailable → best-effort in-memory dedup.
  return memoryDedup(viewKey);
}

module.exports = { shouldCountTourView, isInternalViewer };
