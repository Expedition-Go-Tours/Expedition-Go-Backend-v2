/**
 * API major-version helpers.
 *
 * The platform serves one implementation under two URL prefixes:
 *
 *   /api/…      legacy, unversioned — every existing storefront and supplier
 *               integration calls this and must keep behaving identically.
 *   /api/v1/…   canonical. Same routers, same middleware, different prefix.
 *
 * Two rules keep the alias honest:
 *
 *  1. Never duplicate a router to support the second prefix. Mount the same
 *     router twice. A forked controller is how the two paths quietly drift.
 *  2. Any middleware mounted on a *prefix* rather than a route must not run
 *     twice for a `/api/v1` request. Express prefix matching means
 *     `app.use('/api', x)` also matches `/api/v1/...`, so a naive
 *     `app.use('/api', globalLimiter)` plus `app.use('/api/v1', globalLimiter)`
 *     would charge every canonical request twice and halve the real budget.
 *
 * `normalizeWithinApi` exists for the second rule: middleware mounted at
 * `/api` sees a path relative to that mount (`/v1/tours`), while the same
 * request through the legacy prefix sees `/tours`. Anything that inspects the
 * path — rate-limit skips, the maintenance-mode exemption list — compares the
 * normalised form so both prefixes make the same decision.
 */

const LEGACY_API_PREFIX = '/api';
const VERSIONED_API_PREFIX = '/api/v1';
const API_MAJOR_VERSION = 'v1';
const API_VERSION_HEADER = 'X-API-Version';

/**
 * Drop a leading `v1` segment from a path that is already relative to the
 * `/api` mount. `/v1/tours` → `/tours`; `/tours` → `/tours`; `/v1` → `/`.
 *
 * Only the known major version is stripped — `/v10/...` or a resource that
 * happens to be named `v1` under the legacy prefix is left alone.
 */
function normalizeWithinApi(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return pathname;
  if (pathname === `/${API_MAJOR_VERSION}`) return '/';
  if (pathname.startsWith(`/${API_MAJOR_VERSION}/`)) {
    return pathname.slice(API_MAJOR_VERSION.length + 1);
  }
  return pathname;
}

/** Is this request path (query-free) served by the canonical prefix? */
function isVersionedPath(pathname) {
  if (typeof pathname !== 'string') return false;
  return pathname === VERSIONED_API_PREFIX || pathname.startsWith(`${VERSIONED_API_PREFIX}/`);
}

/**
 * Stamp the request and the response with the contract version that served it,
 * so a client (or a log search) can tell a canonical call from a legacy one
 * without parsing the URL.
 *
 * Uses `req.originalUrl` rather than `req.path`: this middleware is mounted at
 * `/api`, so `req.path` has already been rewritten relative to that mount
 * (`/v1/tours`) and would never match the absolute versioned prefix. The
 * original URL keeps the full `/api/v1/...` form regardless of where this runs
 * in the stack.
 */
function tagApiVersion(req, res, next) {
  const versioned = isVersionedPath((req.originalUrl || '').split('?')[0]);
  req.apiVersion = versioned ? API_MAJOR_VERSION : 'legacy';
  res.setHeader(API_VERSION_HEADER, req.apiVersion);
  next();
}

module.exports = {
  LEGACY_API_PREFIX,
  VERSIONED_API_PREFIX,
  API_MAJOR_VERSION,
  API_VERSION_HEADER,
  normalizeWithinApi,
  isVersionedPath,
  tagApiVersion,
};
