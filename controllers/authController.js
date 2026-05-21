const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const admin = require('../config/firebaseAdmin');
const event = require('../utils/eventEmitter');
const { createSessionToken } = require('../utils/createSessionToken');
const { sendSessionCookie } = require('../utils/sendSessionCookie');

const issueSessionCookie = (res, user) => {
  const token = createSessionToken(user);
  sendSessionCookie(res, token);
};

// Verify Firebase token and set firebaseUser in request
// Updated: May 12, 2026 - Fixed roles array issue
exports.signup = catchAsync(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }

  const idToken = authHeader.split(' ')[1];

  // DEV MODE BYPASS (same as authMiddleware)
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

    // ADDED: issue shared session cookie in dev too, so the flow behaves the same
    issueSessionCookie(res, user);

    event.emit({ name: 'user.logged_in', userId: user.id, req, resource: 'User', resourceId: user.id, properties: { method: 'dev_bypass' } });

    return res.status(200).json({
      status: 'success',
      data: { user },
    });
  }

  // Verify Firebase token
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    return next(
      new AppError('Invalid or expired Firebase token. Please log in again.', 401),
    );
  }

  // Check if user already exists
  let user = await prisma.user.findUnique({ 
    where: { firebaseUid: decoded.uid } 
  });

  // If exists → return it (idempotent)
  if (user) {
    // Track last login time for active-user analytics
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // ADDED: issue shared session cookie for returning users too
    issueSessionCookie(res, user);

    event.emit({ name: 'user.logged_in', userId: user.id, req, resource: 'User', resourceId: user.id });

    return res.status(200).json({
      status: 'success',
      data: { user },
    });
  }

  // Create new user from Firebase claims
  user = await prisma.user.create({
    data: {
      firebaseUid: decoded.uid,
      name:
        decoded.name ||
        decoded.email?.split('@')[0] ||
        'User',
      email: decoded.email,
      photoURL: decoded.picture || '',
      roles: ['customer'],
    }
  });

  // ADDED: issue shared session cookie immediately after signup
  issueSessionCookie(res, user);

  event.emit({ name: 'user.signed_up', userId: user.id, req, resource: 'User', resourceId: user.id, properties: { method: 'firebase' } });

  res.status(201).json({
    status: 'success',
    data: { user },
  });
});


// ============================================================================
// VERIFY FIREBASE TOKEN & CREATE SESSION COOKIE
// Called by the supplier site on redirect from main site (?token=)
// ============================================================================

exports.verifyToken = catchAsync(async (req, res, next) => {
  const { token } = req.body;

  if (!token) {
    return next(new AppError('Token is required', 400));
  }

  // Verify Firebase ID token
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (err) {
    return next(new AppError('Invalid or expired token', 401));
  }

  // Create Firebase session cookie (5 days)
  const sessionCookie = await admin.auth().createSessionCookie(token, {
    expiresIn: 60 * 60 * 24 * 5 * 1000,
  });

  // Set __session cookie (consumed by supplier site middleware)
  // sameSite: 'none' required because frontend (supplier.travioafrica.com)
  // and backend (expedition-go-backend-v2.onrender.com) are different origins
  res.cookie('__session', sessionCookie, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 60 * 60 * 24 * 5 * 1000,
  });

  // Find or create user in our database
  let user = await prisma.user.findUnique({
    where: { firebaseUid: decoded.uid },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        firebaseUid: decoded.uid,
        name: decoded.name || decoded.email?.split('@')[0] || 'User',
        email: decoded.email,
        photoURL: decoded.picture || '',
        roles: ['customer'],
      },
    });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
  }

  // Also issue our internal session cookie for existing API routes
  const internalToken = createSessionToken(user);
  sendSessionCookie(res, internalToken);

  event.emit({
    name: 'user.logged_in',
    userId: user.id,
    req,
    resource: 'User',
    resourceId: user.id,
    properties: { method: 'session_cookie' },
  });

  res.status(200).json({
    status: 'success',
    data: { user },
  });
});

// ============================================================================
// LOGOUT USER
// Clears shared session cookie across all subdomains
// ============================================================================

exports.logout = (req, res) => {
  // Clear internal session cookie
  res.clearCookie('session', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
  });

  // Clear Firebase session cookie
  res.clearCookie('__session', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
  });

  event.emit({ name: 'user.logged_out', userId: req.user?.id, req });

  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully',
  });
};