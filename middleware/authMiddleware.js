const admin = require('../config/firebaseAdmin');
const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

// ADDED: session-cookie support for shared auth across subdomains
const jwt = require('jsonwebtoken');

// ADDED: one place to read auth from Firebase bearer token, backend session cookie, or Firebase __session cookie
const getAuthTokenFromRequest = (req) => {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  if (req.cookies?.session) {
    return { type: 'jwt', token: req.cookies.session };
  }

  if (req.cookies?.__session) {
    return { type: 'firebase_session', token: req.cookies.__session };
  }

  return null;
};

exports.protect = catchAsync(async (req, res, next) => {
  const auth = getAuthTokenFromRequest(req);

  if (!auth) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }

  const token = typeof auth === 'string' ? auth : auth.token;

  // DEV MODE BYPASS (works for either request header or cookie auth path)
  if (process.env.NODE_ENV === 'development' && token === 'test-token') {
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

    // Populate fields used by controllers (createMe/syncMe/updateMe)
    req.firebaseUser = {
      uid: user.firebaseUid,
      name: user.name,
      email: user.email,
      picture: user.photoURL || '',
    };

    return next();
  }

  // REAL FIREBASE AUTH OR BACKEND SESSION AUTH
  let user;
  let decodedFirebase = null;

  // Try Firebase verification (ID token or session cookie)
  try {
    if (auth.type === 'firebase_session') {
      decodedFirebase = await admin.auth().verifySessionCookie(token, true);
    } else {
      decodedFirebase = await admin.auth().verifyIdToken(token);
    }

    user = await prisma.user.findUnique({
      where: { firebaseUid: decodedFirebase.uid },
    });

    if (!user) {
      return next(
        new AppError('User not found. Please complete onboarding.', 404),
      );
    }

    req.firebaseUser = decodedFirebase;
    req.user = user;

    if (!user.active) {
      return next(new AppError('This account has been deactivated.', 403));
    }

    return next();
  } catch (firebaseErr) {
    // Firebase verification failed, so try the backend session cookie
  }

  let decodedSession;
  try {
    decodedSession = jwt.verify(token, process.env.JWT_SECRET);
  } catch (sessionErr) {
    return next(
      new AppError('Invalid or expired session. Please log in again.', 401),
    );
  }

  user = await prisma.user.findUnique({
    where: { id: decodedSession.id },
  });

  if (!user) {
    return next(
      new AppError('User not found. Please complete onboarding.', 404),
    );
  }

  if (!user.active) {
    return next(new AppError('This account has been deactivated.', 403));
  }

  // ADDED: synthesize firebaseUser so existing controllers still work
  req.firebaseUser = {
    uid: user.firebaseUid,
    name: user.name,
    email: user.email,
    picture: user.photoURL || '',
  };

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