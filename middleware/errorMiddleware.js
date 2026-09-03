const { logActivity } = require('../utils/auditLogger');

// Endpoints we never want to audit-log errors for (noise / self-inflicted traffic).
const SKIP_ERROR_LOG = [
  '/api/admin/audit-log',
  '/api/admin/system/health',
  '/health',
  '/api/webhooks',
  '/api/chat',
  '/socket.io',
];

// Scanner / probe paths that hit the server but are never real application
// traffic (DNS-over-HTTPS probes, vulnerability scanners, favicon bots, etc.).
// Requests to these are not audit-logged as api.error at all.
const NOISE_PATH_RE =
  /^\/?(?:dns-query|query|resolve|owa(?:\/.*)?|Dr0v|ui(?:\/.*)?|favicon\.ico|\.well-known(?:\/.*)?|sitemap.*|robots\.txt|phpinfo\.php|wp-admin(?:\/.*)?|\.env)$/i;

// The catch-all 404 middleware ("Can't find <path> on this server!") fires for
// routes that do not exist. Whether under /api or not, that is not an
// application error — it is a route miss (typo, stale frontend, or probing).
const CATCHALL_404_RE = /^Can't find .* on this server!/;

/**
 * Classify an audited API error so activity summaries can separate signal
 * from noise deterministically.
 *   real     — 5xx: the application actually failed.
 *   auth     — 401: authentication/authorization rejections (worth watching).
 *   business — intentional operational 4xx from controllers (e.g. a 404
 *              meaning "no supplier application found"): expected outcomes.
 * Returns null when the error is pure noise that should not be recorded.
 */
function classifyApiError(req, err, statusCode) {
  const path = String((req && (req.originalUrl || req.url)) || '').split('?')[0];
  const code = statusCode || err?.statusCode || 500;
  const message = String(err?.message || '');

  if (NOISE_PATH_RE.test(path) || path === '/') return null; // probe → don't log
  if (CATCHALL_404_RE.test(message)) return null; // route never existed → don't log

  if (code >= 500) return 'real';
  if (code === 401) return 'auth';
  return 'business';
}

function shouldSkipErrorLog(req) {
  const url = (req && (req.originalUrl || req.url)) || '';
  return SKIP_ERROR_LOG.some((prefix) => url.startsWith(prefix));
}

// Fire-and-forget audit logging; never allow logging failures to affect the
// response or crash the process.
function logApiError(err, req) {
  try {
    if (!req || shouldSkipErrorLog(req)) return;
    const classification = classifyApiError(req, err);
    if (!classification) return; // probe/route-miss noise — do not record
    const url = (req.originalUrl || req.url || '').split('?')[0];
    logActivity({
      userId: req.user?.id || null,
      userEmail: req.user?.email || null,
      action: 'api.error',
      resource: 'API',
      metadata: {
        endpoint: { method: req.method || 'GET', url },
        statusCode: err.statusCode || 500,
        errorName: err.name || 'Error',
        message: err.message || 'Unknown error',
        errorCode: err.code || null,
        classification,
        query: Object.keys(req.query || {}).length ? req.query : undefined,
      },
    }).catch(() => {});
  } catch {
    // swallow — audit logging must never break the error handler
  }
}

module.exports = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  // Handle specific error types
  if (err.code === 'P2002') {
    err.statusCode = 400;
    err.message = 'Duplicate field value';
  } else if (err.code === 'P2025') {
    err.statusCode = 404;
    err.message = 'Record not found';
  } else if (err.name === 'SyntaxError') {
    err.statusCode = 400;
    err.message = 'Invalid JSON in request body';
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    err.statusCode = 413;
    err.message = 'File too large';
  } else if (err.name === 'JsonWebTokenError') {
    err.statusCode = 401;
    err.message = 'Invalid token';
  } else if (err.name === 'TokenExpiredError') {
    err.statusCode = 401;
    err.message = 'Token expired';
  }

  if (process.env.NODE_ENV === 'development') {
    res.status(err.statusCode).json({
      status: err.status,
      error: err,
      message: err.message,
      stack: err.stack,
    });
  } else {
    if (!err.isOperational) {
      console.error('[ERROR]', err.name || 'Error', err.message, err.stack?.split('\n')[0]);
    }
    res.status(err.statusCode).json({
      status: err.status,
      message: err.isOperational ? err.message : 'Something went wrong!',
    });
  }

  // Audit the error (production & development; skipped in test env to keep
  // middleware tests hermetic).
  if (process.env.NODE_ENV !== 'test') {
    logApiError(err, req);
  }
};

module.exports.classifyApiError = classifyApiError;
