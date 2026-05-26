const admin = require('../config/firebaseAdmin');
const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

exports.protect = catchAsync(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }

  const idToken = authHeader.split(' ')[1];

  if (process.env.NODE_ENV === 'development' && idToken === 'test-token') {
    let user = await prisma.user.findFirst({
      where: { firebaseUid: 'dev-uid' },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          firebaseUid: 'dev-uid',
          name: 'Dev User',
          email: 'dev@test.com',
          photoURL: '',
          roles: ['admin'],
        },
      });
    }

    req.user = user;

    req.firebaseUser = {
      uid: user.firebaseUid,
      name: user.name,
      email: user.email,
      picture: user.photoURL || '',
    };

    return next();
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch {
    return next(
      new AppError('Invalid or expired token. Please log in again.', 401),
    );
  }

  const user = await prisma.user.findUnique({
    where: { firebaseUid: decoded.uid },
  });

  if (!user) {
    return next(
      new AppError('User not found. Please complete onboarding.', 404),
    );
  }

  if (!user.active) {
    return next(new AppError('This account has been deactivated.', 403));
  }

  req.firebaseUser = decoded;
  req.user = user;

  next();
});

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.roles || !req.user.roles.some(role => roles.includes(role))) {
      return next(
        new AppError('You do not have permission to perform this action', 403),
      );
    }
    next();
  };
};