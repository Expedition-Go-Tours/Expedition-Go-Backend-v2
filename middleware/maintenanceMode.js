const prisma = require('../src/core/services/prismaClient');
const { normalizeWithinApi } = require('./apiVersion');

let cachedValue = null;
let cacheTime = 0;
const CACHE_TTL = 30_000;

/**
 * Admin and webhook paths stay reachable while the platform is in maintenance
 * — an operator needs the console to turn it off, and Stripe/PayPal cannot
 * retry around a 503 they were never told to expect.
 *
 * The check runs against the path relative to the `/api` mount with the
 * version segment stripped, so `/api/v1/admin/…` is exempt exactly like
 * `/api/admin/…`. Comparing `originalUrl` instead would silently lock
 * canonical clients (and payment webhooks) out during maintenance.
 */
function isExempt(req) {
  const path = normalizeWithinApi(req.path);
  return path.startsWith('/admin') || path.startsWith('/webhooks');
}

async function middleware(req, res, next) {
  if (isExempt(req)) return next();

  const now = Date.now();
  if (cachedValue === null || now - cacheTime > CACHE_TTL) {
    try {
      const config = await prisma.systemConfig.findUnique({
        where: { key: 'system.maintenance_mode' },
      });
      cachedValue = config?.value === true || config?.value === 'true';
      cacheTime = now;
    } catch {
      cachedValue = false;
      cacheTime = now;
    }
  }

  if (cachedValue) {
    return res.status(503).json({
      status: 'error',
      message: 'Platform is currently under maintenance. Please try again later.',
    });
  }

  next();
};

function clearCache() {
  cachedValue = null;
  cacheTime = 0;
}

middleware.clearCache = clearCache;
module.exports = middleware;
