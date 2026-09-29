/**
 * Origin allow-list, shared by the Express CORS middleware and the Socket.IO
 * handshake.
 *
 * These two used to keep their own copy of the same rule, which meant an origin
 * could be accepted over HTTP and then refused on the websocket — the client
 * sees a chat connection that simply never opens. One implementation, one place
 * to add an origin.
 *
 * Preview deployments are why this is a function rather than a list. The
 * supplier dashboard runs from two kinds of host:
 *
 *   https://supplier-staging.travioghana.com              fixed staging host
 *   https://travio-ghana-supplier-git-<branch>-<hash>...  per-branch preview
 *                                                        (Vercel)
 *
 * The second form embeds a per-deployment hash, so an exact allow-list is a
 * list we would be editing after every push. Match our own project's
 * git-preview namespace instead of the whole of `*.vercel.app`, which would
 * authorise every application anyone has deployed on the platform.
 */

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
];

/** Fixed staging host bound to the `staging` branch in Vercel. */
const STAGING_ORIGIN = 'https://supplier-staging.travioghana.com';

/** Vercel renders branch previews as `<project>-git-<branch>-<suffix>.vercel.app`. */
const PREVIEW_HOST_PREFIX = 'travio-ghana-supplier-git-';
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
  if (!host.endsWith(VERCEL_HOST_SUFFIX) || !host.startsWith(PREVIEW_HOST_PREFIX)) return false;
  // Require something between the prefix and the suffix, so the bare
  // `travio-ghana-supplier-git-.vercel.app` is not accepted.
  const branchPart = host.slice(PREVIEW_HOST_PREFIX.length, host.length - VERCEL_HOST_SUFFIX.length);
  return branchPart.length > 0;
}

/**
 * Origins authorised for preview traffic but not listed in ALLOWED_ORIGINS.
 *
 * @param {string} origin
 * @returns {boolean}
 */
function isTrustedPreviewOrigin(origin) {
  return origin === STAGING_ORIGIN || isProjectPreviewOrigin(origin);
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
  PREVIEW_HOST_PREFIX,
  httpOrigins,
  socketOrigins,
  isAllowedOrigin,
  isTrustedPreviewOrigin,
};
