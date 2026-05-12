const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const admin = require('../config/firebaseAdmin');

// Verify Firebase token and set firebaseUser in request
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

  res.status(201).json({
    status: 'success',
    data: { user },
  });
});