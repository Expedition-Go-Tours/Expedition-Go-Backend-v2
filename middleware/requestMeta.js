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

const requestMetaStorage = new AsyncLocalStorage();

function getRequestMeta() {
  return requestMetaStorage.getStore() || {};
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
  };
  requestMetaStorage.run(meta, next);
}

module.exports = { captureRequestMeta, getRequestMeta, getClientIp };
