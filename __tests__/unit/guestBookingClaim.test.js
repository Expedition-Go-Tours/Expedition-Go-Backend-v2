/**
 * Verified claim of guest bookings.
 *
 * The safety property is the predicate: only verified accounts, only
 * MARKETPLACE guest bookings, and the email must match the booking contact.
 * The update re-checks `customerId: null`, so a double-submit cannot move a
 * booking twice.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  booking: {
    count: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
}));
jest.mock('../../src/core/services/guestAccess', () => ({
  revokeGuestAccess: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
}));
// getOrSet calls the producer once; the dedupe window itself is covered by the
// cache helper's own tests.
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_key, fn) => fn()),
}));

const prisma = require('../../src/core/services/prismaClient');
const { revokeGuestAccess } = require('../../src/core/services/guestAccess');
const { logActivity } = require('../../src/core/services/auditLogger');
const { enqueueEvent } = require('../../src/core/services/queue');
const cache = require('../../src/core/services/cacheHelper');
const {
  listClaimableGuestBookings,
  claimGuestBookings,
  recordClaimDismissed,
} = require('../../src/core/services/guestBookingClaim');

const verifiedUser = { id: 'u1', email: 'ada@example.com', emailVerified: true };
const unverifiedUser = { ...verifiedUser, emailVerified: false };

const bookingRow = (overrides = {}) => ({
  id: 'b1',
  bookingNumber: 'TRG-1',
  travelDate: new Date('2026-11-20T00:00:00Z'),
  status: 'CONFIRMED',
  grossAmount: 90,
  currency: 'USD',
  leadTravelerName: 'Ada Mensah',
  tour: { title: 'Accra: Shai Hills Safari' },
  guest: { name: 'Ada Mensah' },
  ...overrides,
});

describe('guest booking claim', () => {
  beforeEach(() => jest.clearAllMocks());

  it('asks an unverified account to verify instead of returning bookings', async () => {
    const result = await listClaimableGuestBookings(unverifiedUser);

    expect(result).toMatchObject({ canClaim: false, needsVerification: true, count: 0 });
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('matches the verified email against the guest contact or lead traveller', async () => {
    prisma.booking.count.mockResolvedValue(2);
    prisma.booking.findMany.mockResolvedValue([bookingRow()]);

    const result = await listClaimableGuestBookings(verifiedUser);

    expect(prisma.booking.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        customerId: null,
        origin: 'MARKETPLACE',
        OR: [
          { guest: { email: { equals: 'ada@example.com', mode: 'insensitive' } } },
          { leadTravelerEmail: { equals: 'ada@example.com', mode: 'insensitive' } },
        ],
      },
      take: 20,
    }));
    expect(result).toMatchObject({
      canClaim: true,
      count: 2,
      bookings: [{ id: 'b1', bookingNumber: 'TRG-1', tourTitle: 'Accra: Shai Hills Safari' }],
    });
    // The funnel event is deduped per account per day through the cache key.
    expect(cache.getOrSet).toHaveBeenCalledWith(
      'guest-claim:prompted:u1',
      expect.any(Function),
      24 * 60 * 60,
    );
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'user.guest_claim_prompted',
      userId: 'u1',
    }));
  });

  it('refuses a claim from an unverified account', async () => {
    await expect(claimGuestBookings(unverifiedUser)).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'EMAIL_NOT_VERIFIED',
    });
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('claims every matching guest booking and revokes the old access', async () => {
    prisma.booking.findMany.mockResolvedValue([
      bookingRow({ id: 'b1' }),
      bookingRow({ id: 'b2', bookingNumber: 'TRG-2' }),
    ]);
    prisma.booking.updateMany.mockResolvedValue({ count: 2 });

    const result = await claimGuestBookings(verifiedUser);

    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['b1', 'b2'] }, customerId: null },
      data: { customerId: 'u1' },
    });
    expect(revokeGuestAccess).toHaveBeenCalledWith({ bookingId: 'b1' });
    expect(revokeGuestAccess).toHaveBeenCalledWith({ bookingId: 'b2' });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      action: 'booking.guest_claimed',
      resourceId: 'b1',
    }));
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'user.guest_bookings_claimed',
      properties: { count: 2 },
    }));
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'user.guest_claim_completed',
      properties: { count: 2 },
    }));
    expect(result.claimed).toBe(2);
  });

  it('claims only the requested ids and caps the batch', async () => {
    prisma.booking.findMany.mockResolvedValue([bookingRow({ id: 'b9' })]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });

    await claimGuestBookings(verifiedUser, ['b9', 'b9', 42, 'b10']);

    expect(prisma.booking.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['b9', 'b10'] } }),
    }));
  });

  it('does nothing when there is no match', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    const result = await claimGuestBookings(verifiedUser);

    expect(result).toEqual({ claimed: 0, bookings: [] });
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('records a dismissal as a funnel event without touching a booking', () => {
    recordClaimDismissed(verifiedUser);

    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'user.guest_claim_dismissed',
      userId: 'u1',
      properties: { surface: 'app_prompt' },
    }));
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('ignores a dismissal without a user', () => {
    recordClaimDismissed(null);

    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});
