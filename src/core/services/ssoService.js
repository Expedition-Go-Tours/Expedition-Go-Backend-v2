const crypto = require('crypto');
const AppError = require('./appError');
const logger = require('./logger');
const redis = require('./redisClient');
const prisma = require('./prismaClient');
const {
  signSsoTicket,
  verifySsoTicket,
  signAccessToken,
  signRefreshToken,
  SSO_TICKET_EXPIRY_SECONDS,
} = require('../../../config/jwt');
const { storeRefreshToken } = require('./refreshTokenHelper');

/**
 * Cross-storefront session handoff.
 *
 * expeditiongotours.com and travioghana.com are separate apex domains, so
 * neither can read the other's localStorage and a cookie cannot be scoped
 * across both. Identity, though, is already shared: one `User` table and an
 * access token whose only claim is `{ userId }`, signed with one secret — a
 * token minted on either storefront is already accepted by the other's routes.
 *
 * So the only missing piece is carrying a credential across the origin
 * boundary without putting a standing one in a URL. That is what the ticket
 * is for: a 120-second, single-use, destination-bound signed value that the
 * receiving site exchanges for its own token pair. The pair it receives is
 * minted fresh here, so a long-lived refresh token never travels anywhere.
 *
 * The ticket goes in the URL *fragment*, which browsers never send to a
 * server — so it stays out of access logs, Referer headers and the analytics
 * page-view payload.
 */

const USED_KEY = 'sso:used:';

/** Claims a valid ticket must carry for the destination asking for it. */
function readTicket(ticket, destination) {
  let claims;
  try {
    claims = verifySsoTicket(ticket);
  } catch {
    throw new AppError('This sign-in link is invalid or has expired', 401);
  }
  if (!claims || typeof claims.jti !== 'string' || typeof claims.userId !== 'string') {
    throw new AppError('This sign-in link is invalid or has expired', 401);
  }
  // Bound to the site it was minted for: a ticket captured on the way to one
  // storefront cannot be redeemed on another, even within its lifetime.
  if (claims.dest !== destination) {
    throw new AppError('This sign-in link was issued for a different site', 403);
  }
  return claims;
}

/**
 * Mint a ticket for `userId`, redeemable only at `destination`.
 *
 * Deliberately carries no authority of its own: without the exchange it
 * grants nothing, and it dies in two minutes.
 */
function mintTicket(userId, destination) {
  const ticket = signSsoTicket({ userId: String(userId), jti: crypto.randomUUID(), dest: destination });
  return { ticket, expiresIn: SSO_TICKET_EXPIRY_SECONDS };
}

/**
 * Redeem a ticket for a full session on the receiving storefront.
 *
 * Single-use is enforced with SET NX so two concurrent redemptions cannot both
 * win. Redis being unavailable returns `null` rather than `false` — in that
 * case we allow the exchange and log it. The ticket is already short-lived and
 * bound to one destination, so the worst case is a second session for the same
 * user; failing closed instead would take the whole handoff down on a Redis
 * blip, which is a worse trade for a marginal gain.
 */
async function exchangeTicket(ticket, destination) {
  const claims = readTicket(ticket, destination);

  const firstUse = await redis.setnx(USED_KEY + claims.jti, SSO_TICKET_EXPIRY_SECONDS);
  if (firstUse === false) {
    throw new AppError('This sign-in link has already been used', 410);
  }
  if (firstUse === null) {
    logger.warn(`[SSO] Redis unavailable; allowing ticket ${claims.jti} without single-use`);
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: {
      id: true,
      name: true,
      email: true,
      photoURL: true,
      roles: true,
      passwordHash: true,
      active: true,
    },
  });
  if (!user) throw new AppError('Account not found', 404);
  if (!user.active) throw new AppError('This account has been deactivated', 403);

  const accessToken = signAccessToken({ userId: user.id });
  const refreshToken = signRefreshToken({ userId: user.id });
  await storeRefreshToken(user.id, refreshToken);

  logger.info(`[SSO] session handed off to ${destination} for user ${user.id}`);

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      photoURL: user.photoURL,
      roles: user.roles,
      hasPassword: Boolean(user.passwordHash),
    },
  };
}

module.exports = { mintTicket, exchangeTicket, readTicket };
