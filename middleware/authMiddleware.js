const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { verifyAccessToken } = require('../config/jwt');
const cache = require('../utils/cacheHelper');

const USER_CACHE_TTL = 30;

exports.protect = catchAsync(async (req, res, next) => {
  // Prefer the Authorization Bearer header. A stale accessToken cookie set
  // for the .travioafrica.com domain can outlive the client's current token
  // and shadow a valid header if the cookie is checked first — which would
  // 401 requests that actually carried a fresh token.
  const token = (() => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.split(' ')[1];
    }
    return req.cookies?.accessToken || null;
  })();

  if (!token) {
    return next(new AppError('You are not logged in! Please log in to get access.', 401));
  }

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    return next(new AppError('Invalid or expired token. Please log in again.', 401));
  }

  const userCacheKey = `auth:user:${decoded.userId}`;
  const user = await cache.getOrSet(userCacheKey, async () => {
    return prisma.user.findUnique({
      where: { id: decoded.userId },
    });
  }, USER_CACHE_TTL);

  if (!user) {
    return next(new AppError('User not found. Please complete onboarding.', 404));
  }

  if (!user.active) {
    return next(new AppError('This account has been deactivated.', 403));
  }

  req.user = user;

  next();
});

/**
 * Invalidate user auth cache. Call this after:
 * - Profile update
 * - Role change
 * - Account deactivation/reactivation
 */
exports.invalidateUserCache = (userId) => {
  cache.invalidateKey(`auth:user:${userId}`).catch(() => {});
};

/**
 * Optional authentication — attaches req.user when a valid token is present,
 * but does NOT fail when no token is provided. Used for endpoints that
 * personalize results for authenticated users while remaining public.
 */
exports.optionalAuth = catchAsync(async (req, res, next) => {
  const token = (() => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.split(' ')[1];
    }
    return req.cookies?.accessToken || null;
  })();

  if (!token) return next();

  try {
    const decoded = verifyAccessToken(token);
    const userCacheKey = `auth:user:${decoded.userId}`;
    const user = await cache.getOrSet(userCacheKey, async () => {
      return prisma.user.findUnique({ where: { id: decoded.userId } });
    }, USER_CACHE_TTL);

    if (user && user.active) {
      req.user = user;
    }
  } catch {
    // Invalid/expired token — proceed as anonymous
  }

  next();
});

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.roles || !req.user.roles.some(role => roles.includes(role))) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    next();
  };
};
