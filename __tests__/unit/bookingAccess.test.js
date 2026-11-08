/**
 * Guest booking-access exchange.
 *
 * The signed email link is a capability for exactly one booking. These tests
 * pin the three properties that matter: it mints a normal GuestAccess token
 * for an accountless booking, it refuses once an account owns the booking,
 * and a token minted for another purpose cannot be replayed here.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findUnique: jest.fn() },
}));
jest.mock('../../src/core/services/guestAccess', () => ({
  issueGuestAccess: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const { issueGuestAccess } = require('../../src/core/services/guestAccess');
const { exchangeBookingAccessToken } = require('../../src/core/services/bookingAccess');
const { signBookingAccessToken, signPasswordResetToken } = require('../../config/jwt');

const tokenFor = (bookingId) =>
  signBookingAccessToken({ bookingId, email: 'guest@example.com' });

describe('booking access exchange', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a GuestAccess token for an accountless booking', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b1',
      bookingNumber: 'TRG-1',
      customerId: null,
    });
    issueGuestAccess.mockResolvedValue({
      token: 'guest-token',
      expiresAt: new Date('2026-12-01T00:00:00Z'),
    });

    const result = await exchangeBookingAccessToken(tokenFor('b1'));

    expect(prisma.booking.findUnique).toHaveBeenCalledWith({
      where: { id: 'b1' },
      select: { id: true, bookingNumber: true, customerId: true },
    });
    expect(issueGuestAccess).toHaveBeenCalledWith({ bookingId: 'b1' });
    expect(result).toMatchObject({
      requireLogin: false,
      guestToken: 'guest-token',
      booking: { id: 'b1', bookingNumber: 'TRG-1' },
    });
  });

  it('refuses once an account owns the booking', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b1',
      bookingNumber: 'TRG-1',
      customerId: 'u1',
    });

    const result = await exchangeBookingAccessToken(tokenFor('b1'));

    expect(result).toEqual({
      requireLogin: true,
      booking: { id: 'b1', bookingNumber: 'TRG-1' },
    });
    expect(issueGuestAccess).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed token before touching the database', async () => {
    await expect(exchangeBookingAccessToken('')).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'BOOKING_ACCESS_INVALID',
    });
    await expect(exchangeBookingAccessToken('not-a-token')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a token for a booking that no longer exists', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    await expect(exchangeBookingAccessToken(tokenFor('gone'))).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(issueGuestAccess).not.toHaveBeenCalled();
  });

  it('rejects a token minted for another purpose', async () => {
    const reset = signPasswordResetToken({ userId: 'u1' });

    await expect(exchangeBookingAccessToken(reset)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
  });
});
