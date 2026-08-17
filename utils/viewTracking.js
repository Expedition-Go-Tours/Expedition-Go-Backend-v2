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
 * Identity: authenticated users use their DB id. First-time anonymous
 * viewers receive a 30-day `tv_anon` cookie so returning visitors keep
 * their cooldown across IP changes and NAT-grouped clients are not merged
 * into a single fingerprint. Where no cookie is present we fall back to a
 * hash of IP + User-Agent (raw IPs are never stored).
 *
 * @author Tour Platform Team
 * @version 1.1.0
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const redis = require('./redisClient');

const VIEW_COOLDOWN_SECONDS = 30 * 60; // 30-minute cooldown per viewer per tour
const MEMORY_FALLBACK_MAX = 10000;
const SUPPLIER_PROFILE_CACHE_TTL = 300;
const ANON_COOKIE_NAME = 'tv_anon';
const ANON_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

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
 * Build a stable viewer fingerprint.
 * Authenticated users use their DB id; anonymous visitors use the
 * `tv_anon` cookie when the client already carries one, otherwise a hash
 * of their real IP + User-Agent (raw IPs are never stored).
 */
function getViewerFingerprint(req) {
  if (req.user?.id) return req.user.id;
  const cookieId = req.cookies?.[ANON_COOKIE_NAME];
  if (cookieId) return `anon:${cookieId}`;
  const realIp =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown';
  const ua = req.headers['user-agent'] || '';
  return `ip:${crypto.createHash('sha256').update(`${realIp}:${ua}`).digest('hex').slice(0, 16)}`;
}

/**
 * Hand a new anonymous visitor a 30-day `tv_anon` cookie. Safe to call on
 * every counted request: no-op when the client already has a cookie, and
 * no-op when no `res` is available (e.g. unit tests / non-Express callers).
 */
function grantAnonCookie(req, res) {
  if (req.cookies?.[ANON_COOKIE_NAME] || typeof res?.cookie !== 'function') return null;
  const id = crypto.randomBytes(16).toString('hex');
  res.cookie(ANON_COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: ANON_COOKIE_MAX_AGE,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
  });
  return id;
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
 * When the view is counted and the anonymous visitor had no cookie yet, a
 * fresh `tv_anon` cookie is granted on the response AND the same cooldown is
 * pre-recorded under the cookie identity, so the IP-hash → cookie identity
 * switch never double-counts the same viewer within the cooldown window.
 *
 * @param {Object}   options
 * @param {import('express').Request}  options.req
 * @param {import('express').Response} [options.res] — needed to grant the anon cookie
 * @param {string}   options.tourSupplierId — id of the tour's owning supplier
 * @param {string}   options.tourId — id of the tour being viewed (dedup scope)
 * @param {string}   [options.prefix] — dedup key prefix ("view" | "expedition:view")
 * @returns {Promise<boolean>} true when the view should be counted + recorded
 */
async function shouldCountTourView({ req, res, tourSupplierId, tourId, prefix = 'view' }) {
  // Never count the tour owner browsing their own listing.
  if (req.user?.id && req.user.id === tourSupplierId) return false;

  // Never count crawlers / social link-preview bots.
  if (isBotUA(req.headers['user-agent'])) return false;

  // Never count internal accounts (admin / expedition / active suppliers).
  if (await isInternalViewer(req.user)) return false;

  const viewerId = getViewerFingerprint(req);
  const viewKey = `${prefix}:${tourId}:${viewerId}`;

  // Redis-backed atomic dedup: true = newly recorded, false = already counted.
  const redisResult = await redis.setnx(viewKey, VIEW_COOLDOWN_SECONDS);
  if (redisResult === true) {
    preloadAnonCooldown(req, res, prefix, tourId);
    return true;
  }
  if (redisResult === false) return false;

  // Redis unavailable → best-effort in-memory dedup.
  if (!memoryDedup(viewKey)) return false;
  preloadAnonCooldown(req, res, prefix, tourId);
  return true;
}

/**
 * When a view is counted for an anonymous visitor that had no cookie yet,
 * grant one and pre-record the cooldown under the cookie identity so the
 * identity switch (ip-hash → cookie) cannot double-count this viewer for
 * the same tour within the cooldown window.
 */
function preloadAnonCooldown(req, res, prefix, tourId) {
  if (req.user?.id) return;
  const granted = grantAnonCookie(req, res);
  if (!granted) return;
  const anonKey = `${prefix}:${tourId}:anon:${granted}`;
  redis.setnx(anonKey, VIEW_COOLDOWN_SECONDS); // never throws (returns null when Redis is down)
  memoryFallback.set(anonKey, Date.now());
}

module.exports = { shouldCountTourView, isInternalViewer };