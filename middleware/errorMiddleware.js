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

function shouldSkipErrorLog(req) {
  const url = (req && (req.originalUrl || req.url)) || '';
  return SKIP_ERROR_LOG.some((prefix) => url.startsWith(prefix));
}

// Fire-and-forget audit logging; never allow logging failures to affect the
// response or crash the process.
function logApiError(err, req) {
  try {
    if (!req || shouldSkipErrorLog(req)) return;
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
