const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { verifyAccessToken } = require('../config/jwt');

exports.protect = catchAsync(async (req, res, next) => {
  const token = req.cookies?.accessToken || (() => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.split(' ')[1];
    }
    return null;
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

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
      });
    
      if (!user) {
        return next(new AppError('User not found. Please complete onboarding.', 404));
      }
    
      if (!user.active) {
        return next(new AppError('This account has been deactivated.', 403));
      }
    
      req.user = user;

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
