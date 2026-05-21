module.exports = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');

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
  } else if (err.name === 'CastError') {
    err.statusCode = 400;
    err.message = 'Invalid ID format';
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
      ...(err.isOperational ? { isOperational: true } : {}),
    });
  }
};