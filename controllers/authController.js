const express = require('express');
const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const admin = require('../config/firebaseAdmin');

// ADDED: shared session auth so the user stays logged in across subdomains
const jwt = require('jsonwebtoken');

const SESSION_COOKIE_NAME = 'session';

// ADDED: create a backend session token after Firebase identity is verified
const createSessionToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      firebaseUid: user.firebaseUid,
      roles: user.roles,
      supplierStatus: user.supplierStatus,
      active: user.active,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '30d',
    }
  );
};

// ADDED: send a cookie that works across travioafrica.com subdomains in production
const sendSessionCookie = (res, token) => {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: process.env.NODE_ENV === 'production' ? '.travioafrica.com' : undefined,
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
};

// ADDED: small helper so signup/login paths can reuse the same cookie logic
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
    // ADDED: issue shared session cookie for returning users too
    issueSessionCookie(res, user);

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

  res.status(201).json({
    status: 'success',
    data: { user },
  });
});


// ============================================================================
// LOGOUT USER
// Clears shared session cookie across all subdomains
// ============================================================================

exports.logout = (req, res) => {
  res.clearCookie('session', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain:
      process.env.NODE_ENV === 'production'
        ? '.travioafrica.com'
        : undefined,
    path: '/',
  });

  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully',
  });
};