const bcrypt = require('bcrypt');
const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { signAccessToken, signRefreshToken, signPasswordResetToken, verifyPasswordResetToken, setAuthCookies, clearAuthCookies } = require('../config/jwt');
const { storeRefreshToken, rotateRefreshToken, clearRefreshToken } = require('../utils/refreshTokenHelper');
const { enqueueEvent, enqueueCreateStripeCustomer } = require('../utils/queue');
const passport = require('passport');
const { OAuth2Client } = require('google-auth-library');

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return next(new AppError('Please provide email and password', 400));
  }

  passport.authenticate('local', { session: false }, async (err, user, info) => {
    if (err) return next(err);
    if (!user) return next(new AppError(info?.message || 'Invalid credentials', 401));

    const accessToken = signAccessToken({ userId: user.id });
    const refreshToken = signRefreshToken({ userId: user.id });
    await storeRefreshToken(user.id, refreshToken);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    enqueueEvent({
      name: 'user.logged_in',
      userId: user.id,
      req,
      resource: 'User',
      resourceId: user.id,
      properties: { method: 'local' },
    });

    setAuthCookies(res, accessToken, refreshToken);

    res.status(200).json({
      status: 'success',
      data: {
        user: { id: user.id, name: user.name, email: user.email, photoURL: user.photoURL, roles: user.roles },
        accessToken,
        refreshToken,
      },
    });
  })(req, res, next);
});

exports.register = catchAsync(async (req, res, next) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return next(new AppError('Please provide name, email, and password', 400));
  }

  if (password.length < 8) {
    return next(new AppError('Password must be at least 8 characters', 400));
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (existing) {
    return next(new AppError('An account with this email already exists', 409));
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      name,
      email: email.toLowerCase().trim(),
      passwordHash,
      authProvider: 'local',
      roles: ['customer'],
      lastLoginAt: new Date(),
    },
  });

  enqueueCreateStripeCustomer({ userId: user.id, email: user.email, name: user.name });

  const accessToken = signAccessToken({ userId: user.id });
  const refreshToken = signRefreshToken({ userId: user.id });
  await storeRefreshToken(user.id, refreshToken);

  enqueueEvent({
    name: 'user.signed_up',
    userId: user.id,
    req,
    resource: 'User',
    resourceId: user.id,
    properties: { method: 'local' },
  });

  setAuthCookies(res, accessToken, refreshToken);

  res.status(201).json({
    status: 'success',
    data: {
      user: { id: user.id, name: user.name, email: user.email, photoURL: user.photoURL, roles: user.roles },
      accessToken,
      refreshToken,
    },
  });
});

exports.refresh = catchAsync(async (req, res, next) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

  if (!refreshToken) {
    return next(new AppError('Refresh token required', 400));
  }

  let decoded;
  try {
    const { verifyRefreshToken } = require('../config/jwt');
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    return next(new AppError('Invalid or expired refresh token', 401));
  }

  const rotated = await rotateRefreshToken(decoded.userId, refreshToken, signRefreshToken({ userId: decoded.userId }));
  if (!rotated) {
    return next(new AppError('Refresh token has been revoked. Please log in again.', 401));
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: { id: true, name: true, email: true, photoURL: true, roles: true, active: true },
  });

  if (!user || !user.active) {
    return next(new AppError('User not found or deactivated', 401));
  }

  const newAccessToken = signAccessToken({ userId: user.id });
  const newRefreshToken = signRefreshToken({ userId: user.id });

  setAuthCookies(res, newAccessToken, newRefreshToken);

  res.status(200).json({
    status: 'success',
    data: {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    },
  });
});

exports.setCookies = catchAsync(async (req, res, next) => {
  const { accessToken, refreshToken } = req.body;
  if (!accessToken || !refreshToken) {
    return next(new AppError('accessToken and refreshToken are required', 400));
  }

  // Validate the access token before setting cookies
  try {
    const { verifyAccessToken } = require('../config/jwt');
    verifyAccessToken(accessToken);
  } catch {
    return next(new AppError('Invalid access token', 401));
  }

  setAuthCookies(res, accessToken, refreshToken);

  res.status(200).json({ status: 'success', message: 'Cookies set' });
});

exports.logout = catchAsync(async (req, res) => {
  if (req.user?.id) {
    await clearRefreshToken(req.user.id);
  }

  clearAuthCookies(res);

  enqueueEvent({
    name: 'user.logged_out',
    userId: req.user?.id,
    req,
  });

  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully',
  });
});

exports.forgotPassword = catchAsync(async (req, res, next) => {
  const { email } = req.body;
  if (!email) return next(new AppError('Please provide your email address', 400));

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) {
    return res.status(200).json({
      status: 'success',
      message: 'If an account with that email exists, a password reset link has been sent.',
    });
  }

  const resetToken = signPasswordResetToken({ userId: user.id });

  const resetUrl = `${process.env.CLIENT_URL || 'http://localhost:8080'}/reset-password?token=${resetToken}`;

  try {
    const { sendEmail } = require('../utils/emailService');
    await sendEmail({
      to: user.email,
      subject: 'Password Reset - Travio Africa',
      template: 'generic-notification',
      data: {
        header: 'Password Reset',
        message: 'Click the button below to reset your password. This link expires in 15 minutes.',
        buttonText: 'Reset Password',
        buttonUrl: resetUrl,
        userName: user.name,
      },
    });
  } catch (err) {
    console.error('Failed to send password reset email:', err.message);
  }

  res.status(200).json({
    status: 'success',
    message: 'If an account with that email exists, a password reset link has been sent.',
  });
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return next(new AppError('Token and password are required', 400));
  }

  if (password.length < 8) {
    return next(new AppError('Password must be at least 8 characters', 400));
  }

  let decoded;
  try {
    decoded = verifyPasswordResetToken(token);
  } catch {
    return next(new AppError('Invalid or expired reset token', 400));
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.user.update({
    where: { id: decoded.userId },
    data: {
      passwordHash,
      authProvider: decoded.firebaseUid ? 'local' : undefined,
    },
  });

  enqueueEvent({
    name: 'user.password_reset',
    userId: decoded.userId,
    req,
    resource: 'User',
    resourceId: decoded.userId,
  });

  res.status(200).json({
    status: 'success',
    message: 'Password has been reset successfully. You can now log in with your new password.',
  });
});

exports.changePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return next(new AppError('Please provide current and new password', 400));
  }

  if (newPassword.length < 8) {
    return next(new AppError('Password must be at least 8 characters', 400));
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });

  if (!user || !user.passwordHash) {
    return next(new AppError('Password login is not enabled for this account', 400));
  }

  const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isMatch) {
    return next(new AppError('Current password is incorrect', 401));
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  res.status(200).json({
    status: 'success',
    message: 'Password updated successfully',
  });
});

function getClientOrigin(req) {
  const raw = req.headers.origin || req.headers.referer || process.env.CLIENT_URL || 'http://localhost:8080';
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return process.env.CLIENT_URL || 'http://localhost:8080';
  }
}

exports.googleAuth = catchAsync(async (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.redirect(`${getClientOrigin(req)}/login?error=Google sign-in is not configured. Contact an administrator.`);
  }
  passport.authenticate('google', {
    session: false,
    scope: ['profile', 'email'],
    state: getClientOrigin(req),
    prompt: req.query.prompt || 'select_account',
  })(req, res, next);
});

exports.googleCallback = catchAsync(async (req, res, next) => {
  passport.authenticate('google', { session: false }, async (err, user, info) => {
    if (err) return next(err);
    if (!user) return next(new AppError(info?.message || 'Google authentication failed', 401));

    const accessToken = signAccessToken({ userId: user.id });
    const refreshToken = signRefreshToken({ userId: user.id });
    await storeRefreshToken(user.id, refreshToken);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    enqueueEvent({
      name: 'user.logged_in',
      userId: user.id,
      req,
      resource: 'User',
      resourceId: user.id,
      properties: { method: 'google' },
    });

    const origin = req.query.state || process.env.CLIENT_URL || 'http://localhost:8080';
    setAuthCookies(res, accessToken, refreshToken);
    res.redirect(`${origin}/auth/callback?accessToken=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`);
  })(req, res, next);
});

exports.googleOneTap = catchAsync(async (req, res, next) => {
  const { credential } = req.body;
  if (!credential) return next(new AppError('Google credential is required', 400));

  if (!process.env.GOOGLE_CLIENT_ID) {
    return next(new AppError('Google sign-in is not configured', 503));
  }

  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    return next(new AppError('Invalid Google credential', 401));
  }

  const email = payload.email?.toLowerCase().trim();
  if (!email) return next(new AppError('No email found from Google', 401));

  const name = payload.name || '';
  const photoURL = payload.picture || '';
  const firebaseUid = payload.sub;

  let user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        authProvider: 'google',
        name: user.name || name,
        photoURL: user.photoURL || photoURL,
        firebaseUid: user.firebaseUid || firebaseUid,
      },
    });
  } else {
    user = await prisma.user.create({
      data: {
        email,
        name,
        photoURL,
        authProvider: 'google',
        firebaseUid,
        roles: ['customer'],
      },
    });
  }

  if (!user.active) return next(new AppError('Account has been deactivated', 403));

  const accessToken = signAccessToken({ userId: user.id });
  const refreshToken = signRefreshToken({ userId: user.id });
  await storeRefreshToken(user.id, refreshToken);

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  enqueueEvent({
    name: 'user.logged_in',
    userId: user.id,
    req,
    resource: 'User',
    resourceId: user.id,
    properties: { method: 'google_onetap' },
  });

  setAuthCookies(res, accessToken, refreshToken);

  res.status(200).json({
    status: 'success',
    data: {
      user: { id: user.id, name: user.name, email: user.email, photoURL: user.photoURL, roles: user.roles },
    },
  });
});
