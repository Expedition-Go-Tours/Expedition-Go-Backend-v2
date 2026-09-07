const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

function envKey(name, suffix) {
  return `RATELIMIT_${name.toUpperCase().replace(/-/g, '_')}_${suffix}`;
}

function createLimiter(options) {
  const maxKey = envKey(options.name, 'MAX');
  const windowKey = envKey(options.name, 'WINDOW_MS');
  const { name, defaultMax, defaultWindowMs, message, skip, ...rest } = options;

  const max = parseInt(process.env[maxKey], 10) || defaultMax;
  const windowMs = parseInt(process.env[windowKey], 10) || defaultWindowMs;

  return rateLimit({
    windowMs,
    max,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skip || ((req) => req.method === 'OPTIONS'),
    ...rest,
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
  const { name, defaultMax, defaultWindowMs, message, skip, ...rest } = options;

  const max = parseInt(process.env[maxKey], 10) || defaultMax;
  const windowMs = parseInt(process.env[windowKey], 10) || defaultWindowMs;

  return rateLimit({
    windowMs,
    max,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Authenticated users are keyed on their verified id. Unauthenticated
      // fallback normalizes IPv6 via ipKeyGenerator so address-rotation can't
      // silently bypass the per-user bound.
      if (req.user?.id) return `user:${req.user.id}`;
      return req.ip ? ipKeyGenerator(req.ip) : 'anon';
    },
    skip: skip || ((req) => req.method === 'OPTIONS'),
    ...rest,
  });
}

module.exports = { createLimiter, createUserLimiter };
