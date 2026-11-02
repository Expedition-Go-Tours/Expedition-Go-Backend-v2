/**
 * Guest checkout access.
 *
 * A guest books without an account, so nothing in the normal auth chain can
 * authorize them afterwards: the draft read, the release, the PayPal capture
 * and the confirmation poll all used to be `protect, restrictTo('customer')`.
 *
 * This module issues an opaque bearer token at confirm time and maps it (via
 * SHA-256, never in the clear) to the draft or booking it opened. Three rules
 * carry the safety:
 *
 *   1. the token is random and the hash is what is stored — a database leak
 *      cannot be replayed;
 *   2. it expires (`GUEST_ACCESS_DAYS`), so a link pasted into a chat years
 *      ago stops working;
 *   3. it authorizes ONE resource. A token minted for draft A cannot read
 *      draft B or anyone else's booking, because the lookup is by hash and the
 *      caller then has to match the resource it is asking for.
 *
 * Guests are never auto-linked to an existing account by email: linking is a
 * separate, verified claim (see the claim flow in authController).
 */

const crypto = require('crypto');
const { isEnabled } = require('./featureFlags');

const DEFAULT_TTL_DAYS = 30;
const HEADER = 'x-guest-token';

function ttlDays() {
  const parsed = parseInt(process.env.GUEST_ACCESS_DAYS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_DAYS;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Mint a token bound to a draft (pay-now, before settlement) or a booking
 * (pay-later, or a draft that has already materialized).
 */
async function issueGuestAccess({ draftId = null, bookingId = null } = {}) {
  if (!draftId && !bookingId) throw new Error('issueGuestAccess needs a draftId or bookingId');

  const prisma = require('./prismaClient');
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlDays() * 24 * 3600 * 1000);

  await prisma.guestAccess.create({
    data: { tokenHash: hashToken(token), draftId, bookingId, expiresAt },
  });

  return { token, expiresAt };
}

/**
 * Express middleware. Attaches `req.guestAccess` when a valid, unexpired
 * `x-guest-token` header is present. Never rejects: routes decide whether a
 * guest may act, and a signed-in customer simply has no header.
 */
async function attachGuestAccess(req, res, next) {
  try {
    const raw = req.headers[HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token || typeof token !== 'string' || token.length > 200) return next();

    const prisma = require('./prismaClient');
    const row = await prisma.guestAccess.findUnique({ where: { tokenHash: hashToken(token) } });
    if (row && row.expiresAt > new Date()) req.guestAccess = row;
  } catch (err) {
    console.error('[GuestAccess] attach failed:', err.message);
  }
  next();
}

/**
 * Does this request hold a guest token that owns `resource`?
 *
 * `resource` is `{ draftId }` or `{ bookingId }`. A signed-in customer who
 * owns the resource passes too (the route runs optionalAuth first), so callers
 * write `ownsResource(req, x) || ownsGuest(req, x)` once and never again.
 */
function ownsGuest(req, resource = {}) {
  const access = req.guestAccess;
  if (!access) return false;
  if (resource.draftId && access.draftId === resource.draftId) return true;
  if (resource.bookingId && access.bookingId === resource.bookingId) return true;
  // A pay-now token still points at the draft until the webhook re-points it;
  // after settlement the caller may only know the booking id.
  return false;
}

/** Re-point a pay-now guest token at the booking the draft became. */
async function bindGuestAccessToBooking(draftId, bookingId) {
  if (!draftId || !bookingId) return;
  try {
    const prisma = require('./prismaClient');
    await prisma.guestAccess.updateMany({
      where: { draftId, bookingId: null },
      data: { bookingId },
    });
  } catch (err) {
    console.error('[GuestAccess] bind failed:', err.message);
  }
}

/** Kill every token issued for a draft/booking (cancelled, refunded, claimed). */
async function revokeGuestAccess({ draftId = null, bookingId = null } = {}) {
  try {
    const prisma = require('./prismaClient');
    await prisma.guestAccess.deleteMany({
      where: {
        OR: [
          ...(draftId ? [{ draftId }] : []),
          ...(bookingId ? [{ bookingId }] : []),
        ],
      },
    });
  } catch (err) {
    console.error('[GuestAccess] revoke failed:', err.message);
  }
}

/** True when guest checkout is switched on for this process. */
function guestCheckoutEnabled() {
  return isEnabled('guestCheckout');
}

module.exports = {
  HEADER,
  hashToken,
  issueGuestAccess,
  attachGuestAccess,
  ownsGuest,
  bindGuestAccessToBooking,
  revokeGuestAccess,
  guestCheckoutEnabled,
};
