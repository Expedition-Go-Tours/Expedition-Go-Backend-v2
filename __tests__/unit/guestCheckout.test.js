/**
 * Guest checkout credentials.
 *
 * The token is the ONLY thing standing between a signed-out visitor and
 * somebody else's draft or booking, so these tests pin the properties that
 * make it safe: stored hashed, expiring, scoped to one resource, and off by
 * default so a deploy cannot enable guest checkout on its own.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  guestAccess: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
}));

const prisma = require('../../src/core/services/prismaClient');
const {
  HEADER,
  hashToken,
  issueGuestAccess,
  attachGuestAccess,
  ownsGuest,
  bindGuestAccessToBooking,
  revokeGuestAccess,
  guestCheckoutEnabled,
} = require('../../src/core/services/guestAccess');

const liveRow = (overrides = {}) => ({
  id: 'ga_1',
  tokenHash: hashToken('secret-token'),
  draftId: 'draft_1',
  bookingId: null,
  expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  ...overrides,
});

function mockReq(headers = {}) {
  return { headers };
}

describe('guest checkout access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FF_GUEST_CHECKOUT;
  });

  it('is off unless explicitly enabled', () => {
    expect(guestCheckoutEnabled()).toBe(false);
    process.env.FF_GUEST_CHECKOUT = '1';
    expect(guestCheckoutEnabled()).toBe(true);
  });

  it('stores the hash, never the token', async () => {
    prisma.guestAccess.create.mockResolvedValue({});

    const { token } = await issueGuestAccess({ draftId: 'draft_1' });

    expect(token).toBeTruthy();
    expect(prisma.guestAccess.create).toHaveBeenCalledTimes(1);
    const data = prisma.guestAccess.create.mock.calls[0][0].data;
    // The stored value must be the digest — a database leak then cannot be
    // replayed as a live credential.
    expect(data.tokenHash).toBe(hashToken(token));
    expect(data.tokenHash).not.toBe(token);
    expect(data.tokenHash).toHaveLength(64);
    expect(data.draftId).toBe('draft_1');
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to mint a token for nothing', async () => {
    await expect(issueGuestAccess({})).rejects.toThrow(/draftId or bookingId/);
    expect(prisma.guestAccess.create).not.toHaveBeenCalled();
  });

  it('attaches a live token and ignores an expired one', async () => {
    prisma.guestAccess.findUnique
      .mockResolvedValueOnce(liveRow())
      .mockResolvedValueOnce(liveRow({ expiresAt: new Date(Date.now() - 1000) }));

    const okReq = mockReq({ [HEADER]: 'secret-token' });
    let nextCalls = 0;
    await attachGuestAccess(okReq, {}, () => { nextCalls += 1; });
    expect(okReq.guestAccess).toBeTruthy();
    // Never blocks the request: a guest lookup failure degrades to "no guest".
    expect(nextCalls).toBe(1);

    const expiredReq = mockReq({ [HEADER]: 'secret-token' });
    await attachGuestAccess(expiredReq, {}, () => {});
    expect(expiredReq.guestAccess).toBeUndefined();

    // Lookup is by hash, so the plaintext token never reaches the query.
    expect(prisma.guestAccess.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken('secret-token') },
    });
  });

  it('attaches nothing for a missing or oversized header', async () => {
    const noHeader = mockReq({});
    await attachGuestAccess(noHeader, {}, () => {});
    expect(noHeader.guestAccess).toBeUndefined();

    const huge = mockReq({ [HEADER]: 'x'.repeat(400) });
    await attachGuestAccess(huge, {}, () => {});
    expect(huge.guestAccess).toBeUndefined();

    expect(prisma.guestAccess.findUnique).not.toHaveBeenCalled();
  });

  it('never lets a token open a different resource', () => {
    const req = mockReq({});
    req.guestAccess = liveRow({ draftId: 'draft_1' });

    expect(ownsGuest(req, { draftId: 'draft_1' })).toBe(true);
    expect(ownsGuest(req, { draftId: 'draft_2' })).toBe(false);
    // A draft-scoped token must not also read bookings.
    expect(ownsGuest(req, { bookingId: 'booking_1' })).toBe(false);
    expect(ownsGuest(mockReq({}), { draftId: 'draft_1' })).toBe(false);
  });

  it('re-points a pay-now token at the booking the draft became', async () => {
    prisma.guestAccess.updateMany.mockResolvedValue({ count: 1 });

    await bindGuestAccessToBooking('draft_1', 'booking_1');

    expect(prisma.guestAccess.updateMany).toHaveBeenCalledWith({
      where: { draftId: 'draft_1', bookingId: null },
      data: { bookingId: 'booking_1' },
    });
  });

  it('ignores a bind with a missing side so it can never widen access', async () => {
    await bindGuestAccessToBooking(null, 'booking_1');
    await bindGuestAccessToBooking('draft_1', null);
    expect(prisma.guestAccess.updateMany).not.toHaveBeenCalled();
  });

  it('revokes by draft or booking', async () => {
    prisma.guestAccess.deleteMany.mockResolvedValue({ count: 1 });

    await revokeGuestAccess({ draftId: 'draft_1' });

    expect(prisma.guestAccess.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ draftId: 'draft_1' }] },
    });
  });

  it('survives a failing lookup rather than blocking the request', async () => {
    prisma.guestAccess.findUnique.mockRejectedValue(new Error('db down'));

    const req = mockReq({ [HEADER]: 'secret-token' });
    await expect(
      attachGuestAccess(req, {}, () => {})
    ).resolves.toBeUndefined();
    expect(req.guestAccess).toBeUndefined();
  });
});
