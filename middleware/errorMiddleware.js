module.exports = (err, req, res, next) => {
  res.header('Access-Control_Allow_Origin',req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');

  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (process.env.NODE_ENV === 'development') {
    res.status(err.statusCode).json({
      status: err.status,
      error: err,
      message: err.message,
      stack: err.stack,
    });
  } else {
    // Production: Don't leak stack traces
    res.status(err.statusCode).json({
      status: err.status,
      message: err.isOperational ? err.message : 'Something went wrong!',
    });
  }
};