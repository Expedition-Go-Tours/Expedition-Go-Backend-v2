const rateLimit = require('express-rate-limit');

function envKey(name, suffix) {
  return `RATELIMIT_${name.toUpperCase().replace(/-/g, '_')}_${suffix}`;
}

function createLimiter(options) {
  const maxKey = envKey(options.name, 'MAX');
  const windowKey = envKey(options.name, 'WINDOW_MS');

  const max = parseInt(process.env[maxKey], 10) || options.defaultMax;
  const windowMs = parseInt(process.env[windowKey], 10) || options.defaultWindowMs;

  return rateLimit({
    windowMs,
    max,
    message: options.message,
    standardHeaders: true,
    legacyHeaders: false,
    skip: options.skip || ((req) => req.method === 'OPTIONS'),
  });
}

/**
 * Per-authenticated-user rate limiter. Keyed on the verified JWT subject
 * (`req.user.id`) rather than IP, so legitimate shared-NAT / corporate users
 * aren't penalized together while a single abused account is still bounded.
 * Call AFTER the `protect` middleware so `req.user` is populated.
 */
function createUserLimiter(options) {
  const maxKey = envKey(options.name, 'MAX');
  const windowKey = envKey(options.name, 'WINDOW_MS');

  const max = parseInt(process.env[maxKey], 10) || options.defaultMax;
  const windowMs = parseInt(process.env[windowKey], 10) || options.defaultWindowMs;

  return rateLimit({
    windowMs,
    max,
    message: options.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : req.ip || 'anon'),
    skip: options.skip || ((req) => req.method === 'OPTIONS'),
  });
}

module.exports = { createLimiter, createUserLimiter };
