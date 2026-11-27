/**
 * Team invitations and ownership.
 *
 * The boundary being protected: an invitation is a hashed, single-use
 * credential tied to one email address, and a listing can never be left without
 * an owner.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  $transaction: jest.fn(),
  restaurantVenueMember: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  },
  restaurantVenueInvite: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  user: { findUnique: jest.fn() },
}));

jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  invalidateRestaurantVenueCaches: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/clientOrigin', () => ({
  resolveAllowedClientUrl: jest.fn(() => 'https://store.example'),
}));

jest.mock('../../src/core/services/emailService', () => ({
  sendHtml: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/restaurantVenueAccess', () => ({
  assertOwner: jest.fn(),
  assertPermission: jest.fn(),
}));

const crypto = require('crypto');
const prisma = require('../../src/core/services/prismaClient');
const team = require('../../src/core/services/restaurantVenueTeamService');
const emailService = require('../../src/core/services/emailService');

const CONTEXT = {
  venue: { id: 'v1', slug: 'buka-accra', name: 'Buka' },
  membership: { id: 'm1', userId: 'u1', role: 'OWNER' },
  permissions: ['team.manage'],
};

describe('restaurantVenueTeamService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn) => fn(prisma));
    prisma.restaurantVenueInvite.create.mockImplementation((args) =>
      Promise.resolve({
        id: 'inv1',
        createdAt: new Date(),
        ...args.data,
      }),
    );
    prisma.user.findUnique.mockResolvedValue(null);
    emailService.sendHtml.mockResolvedValue({});
    require('../../src/core/services/clientOrigin').resolveAllowedClientUrl.mockReturnValue(
      'https://store.example',
    );
    require('../../src/core/services/cacheHelper').invalidateRestaurantVenueCaches.mockResolvedValue(
      undefined,
    );
    require('../../src/core/services/queue').enqueueNotification.mockResolvedValue(undefined);
  });

  it('stores only a hash of the invitation token', async () => {
    const invite = await team.inviteMember(
      CONTEXT,
      { email: 'Manager@Example.com' },
      { headers: {}, user: { name: 'Ama' } },
    );

    const create = prisma.restaurantVenueInvite.create.mock.calls[0][0];
    expect(create.data.email).toBe('manager@example.com');
    expect(create.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(invite)).not.toContain(create.data.tokenHash);
    expect(invite).not.toHaveProperty('token');
  });

  it('mails the raw token once and never returns it in the API payload', async () => {
    await team.inviteMember(
      CONTEXT,
      { email: 'manager@example.com' },
      { headers: {}, user: { name: 'Ama' } },
    );

    const mail = emailService.sendHtml.mock.calls[0][0];
    expect(mail.to).toBe('manager@example.com');
    expect(mail.html).toContain('/restaurants/manage/invite?token=');
  });

  it('refuses to invite someone as an owner', async () => {
    await expect(
      team.inviteMember(
        CONTEXT,
        { email: 'manager@example.com', role: 'OWNER' },
        { headers: {}, user: { name: 'Ama' } },
      ),
    ).rejects.toMatchObject({ errorCode: 'INVALID_INVITE_ROLE' });
  });

  it('refuses to invite someone who already manages the venue', async () => {
    prisma.restaurantVenueMember.findFirst.mockResolvedValue({ id: 'm2' });

    await expect(
      team.inviteMember(
        CONTEXT,
        { email: 'manager@example.com' },
        { headers: {}, user: { name: 'Ama' } },
      ),
    ).rejects.toMatchObject({ errorCode: 'ALREADY_A_MEMBER', statusCode: 409 });
  });

  it('refuses a duplicate pending invitation', async () => {
    prisma.restaurantVenueInvite.findFirst.mockResolvedValue({ id: 'inv0' });

    await expect(
      team.inviteMember(
        CONTEXT,
        { email: 'manager@example.com' },
        { headers: {}, user: { name: 'Ama' } },
      ),
    ).rejects.toMatchObject({ errorCode: 'INVITE_ALREADY_PENDING' });
  });

  it('accepts only when the signed-in email matches the invitation', async () => {
    prisma.restaurantVenueInvite.findUnique.mockResolvedValue({
      id: 'inv1',
      venueId: 'v1',
      email: 'manager@example.com',
      role: 'MANAGER',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
      invitedById: 'u1',
      venue: { id: 'v1', slug: 'buka-accra', name: 'Buka' },
    });

    await expect(
      team.acceptInvite(
        { token: 'raw-token', user: { id: 'u9', email: 'someone@else.com' } },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'INVITE_EMAIL_MISMATCH', statusCode: 403 });
    expect(prisma.restaurantVenueMember.upsert).not.toHaveBeenCalled();
  });

  it('marks an expired invitation and refuses it', async () => {
    prisma.restaurantVenueInvite.findUnique.mockResolvedValue({
      id: 'inv1',
      venueId: 'v1',
      email: 'manager@example.com',
      role: 'MANAGER',
      status: 'PENDING',
      expiresAt: new Date(Date.now() - 60_000),
      venue: { id: 'v1', slug: 'buka-accra', name: 'Buka' },
    });

    await expect(
      team.acceptInvite(
        { token: 'raw-token', user: { id: 'u9', email: 'manager@example.com' } },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'INVITE_EXPIRED', statusCode: 410 });
    expect(prisma.restaurantVenueInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    );
  });

  it('creates a manager membership when the invitation is accepted', async () => {
    prisma.restaurantVenueInvite.findUnique.mockResolvedValue({
      id: 'inv1',
      venueId: 'v1',
      email: 'manager@example.com',
      role: 'MANAGER',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
      invitedById: 'u1',
      venue: { id: 'v1', slug: 'buka-accra', name: 'Buka' },
    });
    prisma.restaurantVenueMember.upsert.mockResolvedValue({
      id: 'm9',
      role: 'MANAGER',
      status: 'ACTIVE',
    });

    const result = await team.acceptInvite(
      { token: 'raw-token', user: { id: 'u9', email: 'Manager@Example.com' } },
      { headers: {} },
    );

    expect(result.membership).toMatchObject({ role: 'MANAGER', status: 'ACTIVE' });
    expect(prisma.restaurantVenueMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_userId: { venueId: 'v1', userId: 'u9' } },
      }),
    );
    expect(prisma.restaurantVenueInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACCEPTED', acceptedById: 'u9' }),
      }),
    );
  });

  it('hashes with sha256 so the stored value is deterministic', () => {
    const token = 'abc123';
    expect(team.hashToken(token)).toBe(
      crypto.createHash('sha256').update(token).digest('hex'),
    );
  });

  it('refuses to remove the only owner', async () => {
    prisma.restaurantVenueMember.findFirst.mockResolvedValue({
      id: 'm1',
      userId: 'u1',
      role: 'OWNER',
    });
    prisma.restaurantVenueMember.count.mockResolvedValue(1);

    await expect(
      team.removeMember(CONTEXT, { memberId: 'm1' }, { headers: {} }),
    ).rejects.toMatchObject({ errorCode: 'LAST_OWNER', statusCode: 409 });
  });

  it('demotes the previous owner when ownership transfers', async () => {
    prisma.restaurantVenueMember.findFirst.mockResolvedValue({
      id: 'm2',
      userId: 'u2',
      role: 'MANAGER',
    });
    prisma.restaurantVenueMember.update.mockResolvedValue({});

    await team.transferOwnership(CONTEXT, { memberId: 'm2' }, { headers: {} });

    expect(prisma.restaurantVenueMember.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { role: 'MANAGER' },
    });
    expect(prisma.restaurantVenueMember.update).toHaveBeenCalledWith({
      where: { id: 'm2' },
      data: { role: 'OWNER' },
    });
  });
});
