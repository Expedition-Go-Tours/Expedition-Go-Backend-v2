const bcrypt = require('bcrypt');
const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const { signAccessToken, signRefreshToken, signPasswordResetToken, verifyPasswordResetToken, setAuthCookies, clearAuthCookies } = require('../../../config/jwt');
const { invalidateUserCache } = require('../../../middleware/authMiddleware');
const { storeRefreshToken, rotateRefreshToken, clearRefreshToken } = require('../services/refreshTokenHelper');
const { enqueueEvent, enqueueCreateStripeCustomer } = require('../services/queue');
const { logAuthEvent } = require('../services/auditLogger');
const passport = require('passport');
const { OAuth2Client } = require('google-auth-library');
const { resolveBrand } = require('../services/brandResolver');
const { googleStrategyFor, googleClientIdFor, isGoogleBrandConfigured } = require('../../../config/googleBrands');
const {
  sendVerificationEmail: sendVerificationEmailForUser,
  confirmEmailVerificationToken,
} = require('../services/emailVerification');
const {
  listClaimableGuestBookings: listClaimableGuestBookingsForUser,
  claimGuestBookings: claimGuestBookingsForUser,
  recordClaimDismissed,
} = require('../services/guestBookingClaim');

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    logAuthEvent({
      userEmail: req.body.email,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      event: 'login',
      success: false,
      details: { method: 'local', reason: 'missing_credentials' },
    });
    return next(new AppError('Please provide email and password', 400));
  }

  passport.authenticate('local', { session: false }, async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      logAuthEvent({
        userEmail: req.body.email,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        event: 'login',
        success: false,
        details: { method: 'local', reason: 'invalid_credentials' },
      });
      return next(new AppError(info?.message || 'Invalid credentials', 401));
    }

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

    logAuthEvent({
      userId: user.id,
      userEmail: user.email,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      event: 'login',
      success: true,
      details: { method: 'local' },
    });

    setAuthCookies(res, accessToken, refreshToken);

    res.status(200).json({
      status: 'success',
      data: {
        user: { id: user.id, name: user.name, email: user.email, photoURL: user.photoURL, roles: user.roles, hasPassword: Boolean(user.passwordHash), emailVerified: Boolean(user.emailVerified) },
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

  // A password account starts unverified. The email is the identity the
  // guest-claim flow will trust, so send the proof link immediately — but
  // never make signup wait on (or fail because of) the mail provider.
  sendVerificationEmailForUser(user, resolveVerificationOrigin(req)).catch((err) => {
    console.error('[Auth] Verification email failed:', err.message);
  });

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
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        photoURL: user.photoURL,
        roles: user.roles,
        hasPassword: true,
        // A password signup starts unverified; the response says so rather
        // than making the client infer it.
        emailVerified: false,
      },
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
    const { verifyRefreshToken } = require('../../../config/jwt');
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    return next(new AppError('Invalid or expired refresh token', 401));
  }

  const newAccessToken = signAccessToken({ userId: decoded.userId });
  const newRefreshToken = signRefreshToken({ userId: decoded.userId });

  // Sign the refresh token ONCE and store exactly what gets returned. Rotating
  // to a different token than the one sent back left the client with a refresh
  // token that could never validate again, breaking the session ~1h later.
  const rotated = await rotateRefreshToken(decoded.userId, refreshToken, newRefreshToken);
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

  // Validate both tokens before setting cookies. A mismatched pair would let
  // one user's access token ride on another user's refresh token and keep the
  // session alive under the wrong identity.
  try {
    const { verifyAccessToken, verifyRefreshToken } = require('../../../config/jwt');
    const access = verifyAccessToken(accessToken);
    const refresh = verifyRefreshToken(refreshToken);
    if (!access?.userId || access.userId !== refresh?.userId) {
      return next(new AppError('Tokens do not belong to the same user', 401));
    }
  } catch {
    return next(new AppError('Invalid access or refresh token', 401));
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

  const { sendEmail, resolveEmailBrand } = require('../services/emailService');
  const { getBrandEmail } = require('../../../config/brands');
  const emailUrls = require('../../../config/emailUrls');
  // Branded identity: the sender, logo, footer and subject follow the user's
  // brand. The reset page lives in the supplier dashboard (Ghana suppliers get
  // the Ghana dashboard), not on the public storefront — the storefront has no
  // reset screen, so the old link dead-ended there.
  const brandKey = resolveEmailBrand({ user });
  // The reset screen lives in the app the user signs in to (see
  // emailUrls.resetPasswordUrl): admins on the console, suppliers on their
  // dashboard. Sending an admin to the supplier dashboard dead-ends the link.
  const resetUrl = emailUrls.resetPasswordUrl(user, resetToken);

  try {
    await sendEmail({
      to: user.email,
      subject: `Password Reset - ${getBrandEmail(brandKey).brandName}`,
      template: 'generic-notification',
      opts: { brandKey },
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

  logAuthEvent({
    userId: user.id,
    userEmail: user.email,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    event: 'password_reset_requested',
    success: true,
    details: { method: 'email' },
  });

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
      // Completing the reset proves control of the inbox, exactly like the
      // verification link does.
      emailVerified: true,
      emailVerifiedAt: new Date(),
    },
  });

  enqueueEvent({
    name: 'user.password_reset',
    userId: decoded.userId,
    req,
    resource: 'User',
    resourceId: decoded.userId,
  });

  logAuthEvent({
    userId: decoded.userId,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    event: 'password_reset_completed',
    success: true,
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

  logAuthEvent({
    userId: user.id,
    userEmail: user.email,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    event: 'password_changed',
    success: true,
  });

  res.status(200).json({
    status: 'success',
    message: 'Password updated successfully',
  });
});

/**
 * Set the authenticated user's password.
 *
 * Social-login accounts (Google) are created without a passwordHash, so they
 * have no "current password" to prove. This endpoint lets them opt in to
 * email/password sign-in from inside the app:
 *   - no existing password  → `newPassword` alone is enough
 *   - existing password     → `currentPassword` is required (same rules as
 *                             PATCH /auth/change-password)
 * Setting `passwordHash` is all the local strategy needs; `authProvider` keeps
 * recording how the account was originally created.
 */
exports.setPassword = catchAsync(async (req, res, next) => {
  const { newPassword, currentPassword } = req.body;

  if (!newPassword) {
    return next(new AppError('Please provide a new password', 400));
  }

  if (newPassword.length < 8) {
    return next(new AppError('Password must be at least 8 characters', 400));
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  if (user.passwordHash) {
    if (!currentPassword) {
      return next(new AppError('Please provide your current password', 400));
    }

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      return next(new AppError('Current password is incorrect', 401));
    }
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  // protect() caches the user row, so drop it before any response can serve a
  // stale hasPassword flag.
  invalidateUserCache(user.id);

  logAuthEvent({
    userId: user.id,
    userEmail: user.email,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    event: 'password_set',
    success: true,
    details: { hadPassword: Boolean(user.passwordHash) },
  });

  res.status(200).json({
    status: 'success',
    message: 'Password set successfully',
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        photoURL: user.photoURL,
        roles: user.roles,
        hasPassword: true,
        // Completing a reset proves inbox control (see the update above).
        emailVerified: true,
      },
    },
  });
});

/**
 * The storefront that asked for the verification email. Only allow-listed
 * origins are trusted, so a forged Origin header cannot turn the email into a
 * link to an attacker's site.
 */
function resolveVerificationOrigin(req) {
  const raw = req.headers?.origin || req.headers?.referer;
  try {
    const origin = new URL(raw).origin;
    if (getAllowedClientOrigins().includes(origin)) return origin;
  } catch {
    // fall through
  }
  return process.env.GHANA_STOREFRONT_URL || 'https://www.travioghana.com';
}

function getClientOrigin(req) {
  const raw = req.headers.origin || req.headers.referer || process.env.CLIENT_URL || 'http://localhost:8080';
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return process.env.CLIENT_URL || 'http://localhost:8080';
  }
}

function getAllowedClientOrigins() {
  const defaults = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174'];
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...defaults, ...configured];
}

/**
 * The OAuth `state` (the client origin the user should be returned to after
 * Google) must come from the client's own request so a dev session returns to
 * the dev origin — never derived from the Origin header, whose absence falls
 * back to the production CLIENT_URL and could bounce dev tokens there.
 * The value is validated against ALLOWED_ORIGINS before use.
 */
function resolveOAuthReturnOrigin(req) {
  const requested = typeof req.query.state === 'string' ? req.query.state : '';
  if (requested && getAllowedClientOrigins().includes(requested)) {
    return requested;
  }
  return getClientOrigin(req);
}

exports.googleAuth = catchAsync(async (req, res, next) => {
  const origin = resolveOAuthReturnOrigin(req);
  const brand = resolveBrand(origin);

  if (!isGoogleBrandConfigured(brand) && !isGoogleBrandConfigured('default')) {
    return res.redirect(`${getClientOrigin(req)}/login?error=Google sign-in is not configured. Contact an administrator.`);
  }

  passport.authenticate(googleStrategyFor(brand), {
    session: false,
    scope: ['profile', 'email'],
    state: origin,
    prompt: req.query.prompt || 'select_account',
  })(req, res, next);
});

exports.googleCallback = catchAsync(async (req, res, next) => {
  // Each brand's client registers a callback on that brand's API host, so the
  // callback request's own host identifies which client exchanged the code.
  const brand = resolveBrand(req.hostname || req.headers.host);
  passport.authenticate(googleStrategyFor(brand), { session: false }, async (err, user, info) => {
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

    logAuthEvent({
      userId: user.id,
      userEmail: user.email,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      event: 'login',
      success: true,
      details: { method: 'google' },
    });

    const origin = req.query.state || process.env.CLIENT_URL || 'http://localhost:8080';
    setAuthCookies(res, accessToken, refreshToken);
    res.redirect(`${origin}/auth/callback?accessToken=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`);
  })(req, res, next);
});

exports.googleOneTap = catchAsync(async (req, res, next) => {
  const { credential } = req.body;
  if (!credential) return next(new AppError('Google credential is required', 400));

  const brand = resolveBrand(req.headers.origin || req.headers.referer);
  // Accept the brand's client ID, and fall back to the default one so One Tap
  // keeps working for a frontend that has not yet picked up its brand client ID.
  const audiences = [...new Set([googleClientIdFor(brand), googleClientIdFor('default')].filter(Boolean))];

  if (!audiences.length) {
    return next(new AppError('Google sign-in is not configured', 503));
  }

  const client = new OAuth2Client(audiences[0]);

  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: audiences,
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
        // Google has already verified this address.
        emailVerified: true,
        emailVerifiedAt: user.emailVerifiedAt || new Date(),
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
        emailVerified: true,
        emailVerifiedAt: new Date(),
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

  logAuthEvent({
    userId: user.id,
    userEmail: user.email,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    event: 'login',
    success: true,
    details: { method: 'google_onetap' },
  });

  setAuthCookies(res, accessToken, refreshToken);

  res.status(200).json({
    status: 'success',
    data: {
      user: { id: user.id, name: user.name, email: user.email, photoURL: user.photoURL, roles: user.roles, hasPassword: Boolean(user.passwordHash), emailVerified: Boolean(user.emailVerified) },
      accessToken,
      refreshToken,
    },
  });
});

/**
 * POST /api/auth/verify-email/send
 *
 * Protected: resend the verification link for the signed-in account. Safe to
 * call when already verified — it reports the state instead of mailing again.
 */
exports.sendVerificationEmail = catchAsync(async (req, res, next) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return next(new AppError('User not found', 404));

  const result = await sendVerificationEmailForUser(user, resolveVerificationOrigin(req));

  res.status(200).json({
    status: 'success',
    data: result,
    message: result.alreadyVerified
      ? 'Your email is already verified.'
      : 'Verification email sent. Check your inbox.',
  });
});

/**
 * POST /api/auth/verify-email/confirm
 * Body: { token }
 *
 * Public by design: the signed token is the credential. Idempotent, and bound
 * to the current account email.
 */
exports.confirmEmailVerification = catchAsync(async (req, res) => {
  const result = await confirmEmailVerificationToken(req.body?.token);

  // `protect` caches the user row; without this the next claim request could
  // still see `emailVerified: false` until the TTL expires.
  invalidateUserCache(result.user.id);

  // Funnel event: only the first verification counts. A replayed link is a
  // no-op and must not inflate the metric.
  if (!result.alreadyVerified) {
    enqueueEvent({
      name: 'user.email_verified',
      userId: result.user.id,
      resource: 'User',
      resourceId: result.user.id,
      properties: { method: 'email_link' },
    }).catch(() => {});
  }

  logAuthEvent({
    userId: result.user.id,
    userEmail: result.user.email,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    event: 'email_verified',
    success: true,
    details: { alreadyVerified: result.alreadyVerified },
  });

  res.status(200).json({ status: 'success', data: result });
});

/**
 * GET /api/auth/guest-bookings
 *
 * Preview the bookings made with this verified email that are not on an
 * account yet. Unverified accounts get `needsVerification` instead of a 403 so
 * the UI can offer the verification step.
 */
exports.listGuestBookings = catchAsync(async (req, res) => {
  const data = await listClaimableGuestBookingsForUser(req.user);
  res.status(200).json({ status: 'success', data });
});

/**
 * POST /api/auth/guest-bookings/claim
 * Body: { bookingIds?: string[] }
 *
 * Attach the matching guest bookings to the account. Idempotent: the update
 * re-checks `customerId: null` and the old guest tokens are revoked.
 */
exports.claimGuestBookings = catchAsync(async (req, res) => {
  const data = await claimGuestBookingsForUser(req.user, req.body?.bookingIds);
  res.status(200).json({ status: 'success', data });
});

/**
 * POST /api/auth/guest-bookings/dismiss
 *
 * The "Not now" choice is remembered client-side (30 days per account); this
 * endpoint exists only so the funnel can see the dismissal.
 */
exports.dismissGuestBookings = catchAsync(async (req, res) => {
  recordClaimDismissed(req.user);
  res.status(200).json({ status: 'success', data: { dismissed: true } });
});
