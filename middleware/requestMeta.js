/**
 * Request-scoped metadata capture.
 *
 * Runs per HTTP request and stores the client IP + user agent in an
 * AsyncLocalStorage context so that any logActivity() call made within
 * that request automatically inherits ipAddress/userAgent — even when the
 * call site only passes userId/userEmail. This backfills the audit trail
 * without touching every log site.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { resolveEventBrand } = require('../src/core/services/eventBrand');

const requestMetaStorage = new AsyncLocalStorage();

function getRequestMeta() {
  return requestMetaStorage.getStore() || {};
}

/**
 * Patch the request-scoped metadata after it has been captured.
 *
 * Brand-scoped mounts call this from attachBrand() so later logActivity()
 * calls inherit the route brand even when the request had no Origin header
 * (server-to-server, curl, webhooks).
 */
function setRequestMeta(patch) {
  const store = requestMetaStorage.getStore();
  if (store && patch && typeof patch === 'object') {
    Object.assign(store, patch);
  }
}

function getClientIp(req) {
  return (
    (req.headers && (
      req.headers['cf-connecting-ip'] ||
      (req.headers['x-forwarded-for'] &&
        req.headers['x-forwarded-for'].split(',')[0].trim()) ||
      req.headers['x-real-ip']
    )) ||
    req.ip ||
    (req.socket && req.socket.remoteAddress) ||
    null
  );
}

function captureRequestMeta(req, res, next) {
  const meta = {
    ipAddress: getClientIp(req),
    userAgent: (req.headers && req.headers['user-agent']) || null,
    method: req.method || null,
    url: req.originalUrl || req.url || null,
    origin: (req.headers && req.headers.origin) || null,
    referer: (req.headers && req.headers.referer) || null,
    // Best-effort at capture time. attachBrand() refines this for brand-scoped
    // routes, and every log/event written later in the request inherits it.
    brandKey: resolveEventBrand(req) || null,
  };
  requestMetaStorage.run(meta, next);
}

module.exports = { captureRequestMeta, getRequestMeta, setRequestMeta, getClientIp };
