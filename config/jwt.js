const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret';
const REFRESH_TOKEN_SECRET = (process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'fallback-refresh-secret') + '_refresh';
const PASSWORD_RESET_SECRET = process.env.JWT_PASSWORD_RESET_SECRET || (process.env.JWT_SECRET || 'fallback-reset-secret') + '_password_reset';

const ACCESS_TOKEN_EXPIRY = '30m';
const REFRESH_TOKEN_EXPIRY = '7d';
const PASSWORD_RESET_EXPIRY = '15m';

function signAccessToken(payload) {
  return jwt.sign(payload, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_TOKEN_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_TOKEN_SECRET);
}

const isProduction = process.env.NODE_ENV === 'production';

const COOKIE_OPTIONS = Object.freeze({
  accessToken: {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    domain: isProduction ? '.travioafrica.com' : undefined,
    path: '/',
    maxAge: 30 * 60 * 1000,
  },
  refreshToken: {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    domain: isProduction ? '.travioafrica.com' : undefined,
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

function signPasswordResetToken(payload) {
  return jwt.sign(payload, PASSWORD_RESET_SECRET, { expiresIn: PASSWORD_RESET_EXPIRY });
}

function verifyPasswordResetToken(token) {
  return jwt.verify(token, PASSWORD_RESET_SECRET);
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie('accessToken', accessToken, COOKIE_OPTIONS.accessToken);
  res.cookie('refreshToken', refreshToken, COOKIE_OPTIONS.refreshToken);
}

function clearAuthCookies(res) {
  const opts = { ...COOKIE_OPTIONS.accessToken, maxAge: 0 };
  const refreshOpts = { ...COOKIE_OPTIONS.refreshToken, maxAge: 0 };
  res.cookie('accessToken', '', opts);
  res.cookie('refreshToken', '', refreshOpts);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  signPasswordResetToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifyPasswordResetToken,
  setAuthCookies,
  clearAuthCookies,
};
