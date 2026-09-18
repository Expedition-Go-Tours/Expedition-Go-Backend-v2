const crypto = require('crypto');

/**
 * Constant-time string comparison. Length is compared first because
 * timingSafeEqual throws on unequal buffer lengths.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Authenticates machine-to-machine callers with a shared bearer token.
 *
 * Used by the external-reviews sync job (GitHub Action). Fails closed: if the
 * configured token is missing the route returns 503 rather than allowing
 * anonymous writes.
 *
 * @param {string} envVar - name of the env var holding the expected token
 */
function requireServiceToken(envVar) {
  return (req, res, next) => {
    const expected = process.env[envVar];
    if (!expected) {
      return res.status(503).json({ status: 'error', message: 'Service token is not configured' });
    }

    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!provided || !safeEqual(provided, expected)) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    return next();
  };
}

module.exports = { requireServiceToken };
