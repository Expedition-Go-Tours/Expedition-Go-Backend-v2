/**
 * Origin allow-list, shared by the Express CORS middleware and the Socket.IO
 * handshake.
 *
 * These two used to keep their own copy of the same rule, which meant an origin
 * could be accepted over HTTP and then refused on the websocket — the client
 * sees a chat connection that simply never opens. One implementation, one place
 * to add an origin.
 *
 * Preview deployments are why this is a function rather than a list. Both the
 * supplier dashboard and the traveller storefront run from two kinds of host:
 *
 *   https://supplier-staging.travioghana.com              fixed staging host
 *   https://store-staging.travioghana.com                 fixed staging host
 *   https://travio-ghana-<app>-git-<branch>-<hash>...      per-branch preview
 *                                                        (Vercel)
 *
 * The last form embeds a per-deployment hash, so an exact allow-list is a list
 * we would be editing after every push. Match our own projects' git-preview
 * namespaces instead of the whole of `*.vercel.app`, which would authorise
 * every application anyone has deployed on the platform.
 */

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
];

/** Fixed staging hosts bound to the `staging` branch in Vercel. */
const STAGING_ORIGIN = 'https://supplier-staging.travioghana.com';
const STORE_STAGING_ORIGIN = 'https://store-staging.travioghana.com';
const STAGING_ORIGINS = [STAGING_ORIGIN, STORE_STAGING_ORIGIN];

/**
 * Fixed first-party Stays dashboard host. It is served from the same Vercel
 * project as the staging supplier host but uses its own public domain; the
 * API has to authorise it independently of ALLOWED_ORIGINS, exactly like the
 * staging hosts above.
 */
const STAYS_ORIGIN = 'https://stays.travioghana.com';
const FIXED_ORIGINS = [...STAGING_ORIGINS, STAYS_ORIGIN];

/** Vercel renders branch previews as `<project>-git-<branch>-<suffix>.vercel.app`. */
const PREVIEW_HOST_PREFIX = 'travio-ghana-supplier-git-';
const STORE_PREVIEW_HOST_PREFIX = 'travio-ghana-store-git-';
const PREVIEW_HOST_PREFIXES = [PREVIEW_HOST_PREFIX, STORE_PREVIEW_HOST_PREFIX];
const VERCEL_HOST_SUFFIX = '.vercel.app';

/**
 * ALLOWED_ORIGINS as a list, or null when it is unset.
 *
 * Read on every call rather than at require time: the value comes from the
 * process environment, and tests set it after the module has loaded.
 *
 * @returns {string[]|null}
 */
function envOrigins() {
  if (!process.env.ALLOWED_ORIGINS) return null;
  return process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Express semantics: ALLOWED_ORIGINS replaces the dev defaults outright, so a
 * configured production list never quietly leaves localhost authorised.
 *
 * @returns {string[]}
 */
function httpOrigins() {
  return envOrigins() ?? DEV_ORIGINS;
}

/**
 * Socket.IO semantics: the dev defaults are additive, which is what this code
 * has always done. Kept as-is so the websocket surface does not narrow.
 *
 * @returns {string[]}
 */
function socketOrigins() {
  return [...new Set([...(envOrigins() ?? []), ...DEV_ORIGINS])];
}

/**
 * True for a Vercel preview URL belonging to this project.
 *
 * The protocol and host are checked separately because a prefix test on the
 * whole origin would be fooled by `https://travio-ghana-supplier-git-x.evil.com`
 * or by a query string appended to a host we do control.
 *
 * @param {string} origin
 * @returns {boolean}
 */
function isProjectPreviewOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // An Origin carries no path, query or fragment; anything that does is not a
  // browser-supplied origin.
  if (url.pathname !== '/' || url.search || url.hash) return false;
  const host = url.host.toLowerCase();
  if (!host.endsWith(VERCEL_HOST_SUFFIX)) return false;
  // Require something between a known prefix and the suffix, so a bare
  // `travio-ghana-store-git-.vercel.app` is not accepted.
  return PREVIEW_HOST_PREFIXES.some((prefix) =>
    host.startsWith(prefix) &&
    host.slice(prefix.length, host.length - VERCEL_HOST_SUFFIX.length).length > 0,
  );
}

/**
 * Origins authorised for preview traffic but not listed in ALLOWED_ORIGINS.
 *
 * @param {string} origin
 * @returns {boolean}
 */
function isTrustedPreviewOrigin(origin) {
  return FIXED_ORIGINS.includes(origin) || isProjectPreviewOrigin(origin);
}

/**
 * Decide whether a request may be answered with CORS headers.
 *
 * @param {string|undefined} origin Absent for same-origin and non-browser
 *   callers, which have no cross-origin capability to restrict.
 * @param {string[]} [baseOrigins] The caller's configured list.
 * @returns {boolean}
 */
function isAllowedOrigin(origin, baseOrigins = []) {
  if (!origin) return true;
  if (baseOrigins.includes(origin)) return true;
  return isTrustedPreviewOrigin(origin);
}

module.exports = {
  DEV_ORIGINS,
  STAGING_ORIGIN,
  STORE_STAGING_ORIGIN,
  STAGING_ORIGINS,
  STAYS_ORIGIN,
  FIXED_ORIGINS,
  PREVIEW_HOST_PREFIX,
  STORE_PREVIEW_HOST_PREFIX,
  httpOrigins,
  socketOrigins,
  isAllowedOrigin,
  isTrustedPreviewOrigin,
};
