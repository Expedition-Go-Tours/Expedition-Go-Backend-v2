const prisma = require('../utils/prismaClient');

let cachedValue = null;
let cacheTime = 0;
const CACHE_TTL = 30_000;

async function middleware(req, res, next) {
  if (req.originalUrl.startsWith('/api/admin') || req.originalUrl.startsWith('/api/webhooks')) return next();

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
