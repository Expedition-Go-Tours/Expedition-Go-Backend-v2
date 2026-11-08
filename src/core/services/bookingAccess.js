/**
 * Guest booking-access exchange.
 *
 * A guest confirmation email carries a signed, booking-scoped token instead of
 * an account session. The storefront posts that token here and receives the
 * same GuestAccess credential the checkout tab uses. The token is the only
 * credential this path accepts, and it authorises exactly one booking.
 *
 * Once an account owns the booking the exchange refuses (`requireLogin`):
 * minting a guest credential for a claimed booking would leave a second,
 * weaker way to read it.
 */
const prisma = require('./prismaClient');
const AppError = require('./appError');
const { issueGuestAccess } = require('./guestAccess');
const { verifyBookingAccessToken } = require('../../../config/jwt');

function invalidLink() {
  return new AppError(
    'This booking link is invalid or has expired. Please sign in to view your booking.',
    400,
    { code: 'BOOKING_ACCESS_INVALID', reasonCode: 'BOOKING_ACCESS_INVALID' },
  );
}

/**
 * @param {unknown} rawToken
 * @returns {Promise<{ requireLogin: boolean, guestToken?: string, expiresAt?: Date, booking: { id: string, bookingNumber: string } }>}
 */
async function exchangeBookingAccessToken(rawToken) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token || token.length > 2000) throw invalidLink();

  let payload;
  try {
    payload = verifyBookingAccessToken(token);
  } catch {
    throw invalidLink();
  }

  const booking = await prisma.booking.findUnique({
    where: { id: payload.bookingId },
    select: { id: true, bookingNumber: true, customerId: true },
  });
  if (!booking) throw invalidLink();

  const summary = { id: booking.id, bookingNumber: booking.bookingNumber };

  if (booking.customerId) {
    return { requireLogin: true, booking: summary };
  }

  const access = await issueGuestAccess({ bookingId: booking.id });
  return {
    requireLogin: false,
    guestToken: access.token,
    expiresAt: access.expiresAt,
    booking: summary,
  };
}

module.exports = { exchangeBookingAccessToken };
