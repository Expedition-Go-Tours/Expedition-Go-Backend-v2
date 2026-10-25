const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required in production');
  if (!process.env.JWT_REFRESH_SECRET) throw new Error('JWT_REFRESH_SECRET is required in production');
}

const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret';
const REFRESH_TOKEN_SECRET = (process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'fallback-refresh-secret') + '_refresh';
const PASSWORD_RESET_SECRET = process.env.JWT_PASSWORD_RESET_SECRET || (process.env.JWT_SECRET || 'fallback-reset-secret') + '_password_reset';
// Cross-storefront handoff tickets. Derived from JWT_SECRET like the others, so
// api.expeditiongotours.com and apiv1.travioafrica.com — which resolve to the
// same deployment — sign and verify the same ticket.
const SSO_TICKET_SECRET = process.env.JWT_SSO_SECRET || (process.env.JWT_SECRET || 'fallback-sso-secret') + '_sso';

const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_EXPIRY = '7d';
const PASSWORD_RESET_EXPIRY = '15m';
// Short by design: the ticket exists only to cross an origin boundary, so it
// should be dead before anyone can find it in a browser history entry.
// Exported as seconds so the exchange can expire its single-use marker over
// exactly the same window.
const SSO_TICKET_EXPIRY_SECONDS = 120;

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

// Auth cookie scope. Auth is Bearer-first (frontends store the token in
// localStorage and send the Authorization header), so cookies are secondary.
// Cookies are host-only by default: a token minted by api.travioghana.com is
// then sent back only to that API host, never to admin/supplier storefronts
// (which may run on Vercel) or to a different brand's API. A parent domain
// such as `.travioafrica.com` is rejected by the browser when the response
// comes from api.travioghana.com, which silently breaks cookie-based sign-in.
// Set AUTH_COOKIE_DOMAIN only when a deployment genuinely needs to share the
// cookie across subdomains.
const COOKIE_DOMAIN = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;

// Before host-only scoping, Africa auth cookies were issued for this parent
// domain. Clear it on Africa API responses so a stale cookie of the same name
// cannot shadow the new host-only token. Ghana/Expedition hosts never had a
// valid parent-domain cookie, so this cleanup is scoped to *.travioafrica.com.
const LEGACY_COOKIE_DOMAIN = '.travioafrica.com';

const COOKIE_OPTIONS = Object.freeze({
  accessToken: {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    domain: isProduction ? COOKIE_DOMAIN : undefined,
    path: '/',
    maxAge: 60 * 60 * 1000,
  },
  refreshToken: {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    domain: isProduction ? COOKIE_DOMAIN : undefined,
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

/**
 * A one-time credential that lets a signed-in user land on another storefront
 * of ours already authenticated.
 *
 * The payload is `{ userId, jti, dest }`. `dest` binds the ticket to the site
 * it was minted for, so a ticket captured on the way to travioghana.com cannot
 * be replayed against any other origin; `jti` makes it single-use.
 */
function signSsoTicket(payload) {
  return jwt.sign(payload, SSO_TICKET_SECRET, { expiresIn: SSO_TICKET_EXPIRY_SECONDS });
}

function verifySsoTicket(token) {
  return jwt.verify(token, SSO_TICKET_SECRET);
}

function clearLegacyAuthCookies(res) {
  if (!isProduction || COOKIE_DOMAIN) return;
  if (typeof res.clearCookie !== 'function') return;
  const hostname = (res.req?.hostname || '').toLowerCase();
  if (hostname !== 'travioafrica.com' && !hostname.endsWith('.travioafrica.com')) return;
  const base = { domain: LEGACY_COOKIE_DOMAIN, secure: true, sameSite: 'none' };
  res.clearCookie('accessToken', { ...base, path: '/' });
  res.clearCookie('refreshToken', { ...base, path: '/api/auth' });
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie('accessToken', accessToken, COOKIE_OPTIONS.accessToken);
  res.cookie('refreshToken', refreshToken, COOKIE_OPTIONS.refreshToken);
  clearLegacyAuthCookies(res);
}

function clearAuthCookies(res) {
  const opts = { ...COOKIE_OPTIONS.accessToken, maxAge: 0 };
  const refreshOpts = { ...COOKIE_OPTIONS.refreshToken, maxAge: 0 };
  res.cookie('accessToken', '', opts);
  res.cookie('refreshToken', '', refreshOpts);
  clearLegacyAuthCookies(res);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  signPasswordResetToken,
  signSsoTicket,
  verifyAccessToken,
  verifyRefreshToken,
  verifyPasswordResetToken,
  verifySsoTicket,
  SSO_TICKET_EXPIRY_SECONDS,
  setAuthCookies,
  clearAuthCookies,
};
