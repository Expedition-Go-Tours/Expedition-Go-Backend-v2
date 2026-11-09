/**
 * Working relay for unclaimed marketplace guest bookings.
 *
 * The supplier contact layer already hides a registered customer's address
 * behind the conversation relay (`c-…`). A guest checkout has no `User` and
 * therefore no `Conversation`, so it cannot reuse that mechanism. This service
 * mints a separate, booking-scoped alias:
 *
 *   supplier  ->  g-<16-hex-hmac>@<receiving-domain>
 *                     |  resolved by the stored GuestRelay token
 *   guest     <-  real inbox (read from the booking at send time)
 *
 * The real address is never copied onto the relay row. It is resolved from
 * `booking.guest.email || booking.leadTravelerEmail` when a message is
 * forwarded, which means a corrected address takes effect immediately.
 *
 * Scope is deliberately narrow: `origin = MARKETPLACE` and `customerId` null.
 * A supplier-created walk-in keeps the address the supplier typed in — they
 * entered it themselves, so there is nothing to hide from them.
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const chatInbound = require('./chatInbound');
const logger = require('./logger');

const SECRET = process.env.RESEND_INBOUND_WEBHOOK_SECRET || '';
const TOKEN_PREFIX = 'g-';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** The brand whose receiving domain this booking's mail should arrive on. */
function brandKeyForBooking(booking) {
  if (booking?.brand) return booking.brand;
  switch (String(booking?.source || '').toUpperCase()) {
    case 'GHANA': return 'ghana';
    case 'EXPEDITION': return 'expedition';
    case 'TRAVIO_AFRICA': return 'travioafrica';
    default: return null;
  }
}

/** Canonical local part: g-<16 hex>, keyed so it cannot be guessed/reversed. */
function tokenFor(bookingId) {
  const hex = crypto
    .createHmac('sha256', SECRET || 'insecure-dev')
    .update(`guest:${String(bookingId)}`)
    .digest('hex')
    .slice(0, 16);
  return `${TOKEN_PREFIX}${hex}`;
}

function addressFor(booking) {
  return `${tokenFor(booking.id)}@${chatInbound.receivingDomainFor(brandKeyForBooking(booking))}`;
}

/** The real inbox, never stored on the relay row. */
function preferredEmail(booking) {
  return normalizeEmail(
    booking?.guest?.email
    || booking?.leadTravelerEmail
    || booking?.guestEmail,
  );
}

/**
 * Only an unclaimed marketplace guest booking with a reachable inbox qualifies.
 * `supplierId` may be passed explicitly because several list queries select the
 * tour without its supplier id.
 */
function isEligible(booking, supplierId = null) {
  if (!booking?.id || !booking.guestId || booking.customerId) return false;
  if (String(booking.origin || '').toUpperCase() !== 'MARKETPLACE') return false;
  if (!(supplierId || booking.tour?.supplierId)) return false;
  return Boolean(preferredEmail(booking));
}

/**
 * Find or create the relay row for a booking. Returns null when the booking is
 * not eligible or the address cannot be minted. A minting failure must never
 * fall back to the real address — the caller blanks the field instead.
 */
async function ensureForBooking(booking, supplierId = null) {
  if (!isEligible(booking, supplierId)) return null;

  const existing = await prisma.guestRelay.findUnique({
    where: { bookingId: booking.id },
  });
  if (existing) return existing.disabledAt ? null : existing;

  const data = {
    bookingId: booking.id,
    guestId: booking.guestId,
    supplierId: supplierId || booking.tour.supplierId,
    token: tokenFor(booking.id),
    address: addressFor(booking),
  };

  try {
    return await prisma.guestRelay.create({ data });
  } catch (err) {
    // Two concurrent list/detail requests can race the create. The unique
    // bookingId is the arbiter; the loser reads the winner's row.
    if (err?.code === 'P2002') {
      const row = await prisma.guestRelay.findUnique({ where: { bookingId: booking.id } });
      if (row) return row.disabledAt ? null : row;
    }
    logger.warn(`[GuestRelay] could not mint a relay for booking ${booking.id}: ${err.message}`);
    return null;
  }
}

/** Resolve an inbound address back to its booking. */
async function findByToken(token) {
  const local = String(token || '').trim().toLowerCase();
  if (!/^g-[0-9a-f]{16}$/.test(local)) return null;
  return prisma.guestRelay.findUnique({
    where: { token: local },
    include: {
      booking: {
        select: {
          id: true,
          bookingNumber: true,
          customerId: true,
          guestId: true,
          origin: true,
          source: true,
          status: true,
          leadTravelerName: true,
          leadTravelerEmail: true,
          guest: { select: { id: true, name: true, email: true } },
          tour: { select: { id: true, title: true, supplierId: true } },
        },
      },
    },
  });
}

/** The address that actually receives relayed mail, read fresh from the booking. */
function realGuestEmail(relay) {
  return preferredEmail(relay?.booking);
}

module.exports = {
  TOKEN_PREFIX,
  normalizeEmail,
  brandKeyForBooking,
  tokenFor,
  addressFor,
  preferredEmail,
  isEligible,
  ensureForBooking,
  findByToken,
  realGuestEmail,
};
