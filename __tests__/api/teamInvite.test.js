/**
 * Team invitations — end-to-end contract on the Ghana supplier API.
 *
 * Regression cover for the bug that made the feature unusable: every team
 * route sat behind `restrictTo('supplier')`, so an invitee (who is a plain
 * `customer` account until they accept) was rejected with 403 before the
 * controller ran, and an accepted member never got the roles needed to open
 * the dashboard.
 */
const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

jest.mock('../../src/core/services/prismaClient', () => ({
  travioGhanaTour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  expeditionTour: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  tour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  user: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  supplierProfile: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  adminRole: { findUnique: jest.fn() },
  teamMember: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  review: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  booking: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  specialOffer: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
  specialOfferTarget: { findMany: jest.fn().mockResolvedValue([]) },
  newsletterSubscriber: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  tourDateOverride: { findMany: jest.fn(), upsert: jest.fn() },
  wishlistItem: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  notification: { findMany: jest.fn(), count: jest.fn(), updateMany: jest.fn(), aggregate: jest.fn(), update: jest.fn() },
  adminNotification: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), updateMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  payout: { findMany: jest.fn(), findFirst: jest.fn(), aggregate: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  payoutRequest: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  payoutMethod: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  dispute: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  chatConversation: { findMany: jest.fn(), count: jest.fn() },
  cancellationRecord: { findMany: jest.fn(), count: jest.fn() },
  event: { findMany: jest.fn() },
  auditLog: { findMany: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../src/core/services/homepageRanking', () => {
  const empty = () => jest.fn().mockResolvedValue([]);
  return {
    getLikelySellOut: empty(),
    getTopRated: empty(),
    getTrending: empty(),
    getMoodKeywords: empty(),
    getPopularDestinations: empty(),
  };
});

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

const mockSendTeamInviteEmail = jest.fn(() => Promise.resolve());
jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  sendTeamInviteEmail: (...args) => mockSendTeamInviteEmail(...args),
  sendTeamInviteRevokedEmail: jest.fn(() => Promise.resolve()),
  resolveEmailBrand: jest.fn(() => 'ghana'),
}));

jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/tourHelpers', () => ({
  checkTourAvailability: jest.fn(() => Promise.resolve({ available: true, availableSpots: 10, reason: null })),
  calculateTourPrice: jest.fn(() => Promise.resolve({ success: true, currency: 'USD', subtotal: 100, fees: 5, discount: 0, total: 105 })),
  cheapestRetailPrice: jest.fn(() => 100),
}));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');

const OWNER = { id: 'owner-1', name: 'Expedition-Go Tours', email: 'owner@test.com', roles: ['supplier', 'ghana'], active: true, photoURL: '', notificationPreferences: {} };
const INVITEE = { id: 'invitee-1', name: 'Secretary', email: 'invitee@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const STRANGER = { id: 'stranger-1', name: 'Someone Else', email: 'stranger@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const EDITOR_MEMBER = { id: 'member-1', name: 'Gideon', email: 'member@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };

const USERS = { 'owner-1': OWNER, 'invitee-1': INVITEE, 'stranger-1': STRANGER, 'member-1': EDITOR_MEMBER };

const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
const past = new Date(Date.now() - 60 * 60 * 1000);

const pendingInvite = {
  id: 'tm-1', supplierId: 'owner-1', email: 'invitee@test.com', role: 'editor',
  status: 'PENDING', inviteToken: 'tok-pending', tokenExpiresAt: future, acceptedAt: null,
  createdAt: new Date(), updatedAt: new Date(),
  supplier: { name: 'Expedition-Go Tours', email: 'owner@test.com' },
};

const token = (user) => signAccessToken({ userId: user.id });
const auth = (user) => ({ Authorization: `Bearer ${token(user)}` });

const GHANA = '/api/travioghana/supplier/settings/team';

beforeEach(() => {
  jest.clearAllMocks();
  mockSendTeamInviteEmail.mockResolvedValue();

  const models = ['travioGhanaTour', 'expeditionTour', 'tour', 'user', 'review', 'booking', 'specialOffer', 'payout', 'notification', 'teamMember', 'payoutRequest', 'dispute', 'chatConversation', 'cancellationRecord', 'wishlistItem'];
  for (const m of models) {
    prisma[m].findMany?.mockResolvedValue([]);
    prisma[m].count?.mockResolvedValue(0);
    if (prisma[m].aggregate) prisma[m].aggregate.mockResolvedValue({ _sum: {}, _avg: {}, _count: 0 });
    if (prisma[m].groupBy) prisma[m].groupBy.mockResolvedValue([]);
    if (prisma[m].update) prisma[m].update.mockResolvedValue({});
    if (prisma[m].updateMany) prisma[m].updateMany.mockResolvedValue({ count: 0 });
    if (prisma[m].create) prisma[m].create.mockResolvedValue({});
    if (prisma[m].delete) prisma[m].delete.mockResolvedValue({});
  }

  prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(USERS[where.id] || null));
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.user.update.mockImplementation(({ where, data }) => Promise.resolve({ ...USERS[where.id], ...data }));

  // Only the owner holds a supplier profile — members and invitees do not.
  prisma.supplierProfile.findFirst.mockImplementation(({ where }) => (
    Promise.resolve(where.userId === 'owner-1' ? { id: 'profile-1' } : null)
  ));

  prisma.teamMember.findUnique.mockImplementation(({ where }) => {
    if (where.inviteToken) return Promise.resolve(where.inviteToken === 'tok-pending' ? pendingInvite : null);
    if (where.id) return Promise.resolve(pendingInvite);
    return Promise.resolve(null);
  });
  prisma.teamMember.findFirst.mockResolvedValue(null);
  prisma.teamMember.count.mockResolvedValue(0);
  prisma.teamMember.update.mockImplementation(({ data }) => Promise.resolve({ ...pendingInvite, ...data }));
  prisma.$transaction.mockImplementation(async (cb) => (typeof cb === 'function' ? cb(prisma) : cb));
});

describe('team invite — invitee without the supplier role', () => {
  it('can read the invitation details (was 403 before the guard fix)', async () => {
    const res = await request(app).get(`${GHANA}/invite/tok-pending`).set(auth(INVITEE));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      supplierName: 'Expedition-Go Tours',
      role: 'editor',
      invitedEmail: 'invitee@test.com',
    });
  });

  it('can accept, and is granted the dashboard roles', async () => {
    const res = await request(app).post(`${GHANA}/invite/tok-pending/accept`).set(auth(INVITEE));

    expect(res.status).toBe(200);
    expect(res.body.data.member.status).toBe('ACCEPTED');

    const update = prisma.user.update.mock.calls.find(([args]) => args.where.id === 'invitee-1');
    expect(update).toBeTruthy();
    expect(update[0].data.roles).toEqual(expect.arrayContaining(['supplier', 'ghana']));

    // The SPA loads the dashboard immediately, so the auth cache must be dropped.
    expect(cache.invalidateKey).toHaveBeenCalledWith('auth:user:invitee-1');
    expect(cache.invalidateKey).toHaveBeenCalledWith('team:member:email:invitee@test.com');
  });

  it('cannot accept an invitation sent to someone else', async () => {
    const res = await request(app).post(`${GHANA}/invite/tok-pending/accept`).set(auth(STRANGER));

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/sent to invitee@test\.com/i);
  });

  it('cannot manage the team (management stays supplier-only)', async () => {
    const res = await request(app).get(`${GHANA}/members`).set(auth(INVITEE));
    expect(res.status).toBe(403);
  });

  it('cannot invite anyone', async () => {
    const res = await request(app)
      .post(`${GHANA}/invite`)
      .set(auth(INVITEE))
      .send({ email: 'someone@test.com', role: 'editor' });
    expect(res.status).toBe(403);
  });
});

describe('team invite — link states', () => {
  const itReturns = (status, mutate) => {
    prisma.teamMember.findUnique.mockImplementation(({ where }) => {
      if (where.inviteToken === 'tok-pending') return Promise.resolve(mutate({ ...pendingInvite }));
      return Promise.resolve(null);
    });
    return status;
  };

  it('404s for an unknown token', async () => {
    const res = await request(app).get(`${GHANA}/invite/nope`).set(auth(INVITEE));
    expect(res.status).toBe(404);
  });

  it('410s when the invitation expired', async () => {
    itReturns(410, (m) => ({ ...m, tokenExpiresAt: past }));
    const res = await request(app).get(`${GHANA}/invite/tok-pending`).set(auth(INVITEE));
    expect(res.status).toBe(410);
    expect(res.body.message).toMatch(/expired/i);
  });

  it('410s once cleanup marked it EXPIRED', async () => {
    itReturns(410, (m) => ({ ...m, status: 'EXPIRED', tokenExpiresAt: null }));
    const res = await request(app).get(`${GHANA}/invite/tok-pending`).set(auth(INVITEE));
    expect(res.status).toBe(410);
  });

  it('409s when already accepted', async () => {
    itReturns(409, (m) => ({ ...m, status: 'ACCEPTED' }));
    const res = await request(app).post(`${GHANA}/invite/tok-pending/accept`).set(auth(INVITEE));
    expect(res.status).toBe(409);
  });

  it('410s when revoked', async () => {
    itReturns(410, (m) => ({ ...m, status: 'REVOKED' }));
    const res = await request(app).post(`${GHANA}/invite/tok-pending/accept`).set(auth(INVITEE));
    expect(res.status).toBe(410);
  });

  it('requires authentication', async () => {
    const res = await request(app).get(`${GHANA}/invite/tok-pending`);
    expect(res.status).toBe(401);
  });
});

describe('team member — data scoping', () => {
  const acceptedMember = {
    id: 'tm-2', supplierId: 'owner-1', email: 'member@test.com', role: 'editor',
    status: 'ACCEPTED', inviteToken: null, tokenExpiresAt: null, acceptedAt: new Date(),
  };

  it('reads the owner supplier data, not their own empty set', async () => {
    prisma.teamMember.findFirst.mockResolvedValue(acceptedMember);
    prisma.user.findFirst.mockResolvedValue({ id: 'member-1' });
    prisma.tour.groupBy.mockResolvedValue([]);
    prisma.booking.groupBy.mockResolvedValue([]);

    const res = await request(app).get('/api/travioghana/supplier/dashboard').set(auth(EDITOR_MEMBER));

    expect(res.status).toBe(200);
    // The dashboard resolves the supplier from req.supplierId (the owner), which
    // is what makes a member's dashboard show real numbers.
    expect(prisma.tour.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { supplierId: 'owner-1' } }),
    );
  });

  it('reports the member role from my-role', async () => {
    prisma.teamMember.findFirst.mockResolvedValue(acceptedMember);
    const res = await request(app).get(`${GHANA}/my-role`).set(auth(EDITOR_MEMBER));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: 'editor', isOwner: false });
    expect(res.body.data.permissions).toContain('tours.update');
  });

  it('reports no role for an authenticated stranger', async () => {
    const res = await request(app).get(`${GHANA}/my-role`).set(auth(STRANGER));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: null, isOwner: false, permissions: [] });
  });

  it('rejects a customer with no membership from supplier data', async () => {
    const res = await request(app).get('/api/travioghana/supplier/dashboard').set(auth(STRANGER));
    expect(res.status).toBe(403);
  });

  it('blocks a support member from writing availability', async () => {
    prisma.teamMember.findFirst.mockResolvedValue({ ...acceptedMember, role: 'support' });
    const res = await request(app)
      .post('/api/travioghana/supplier/availability/tour-1')
      .set(auth(EDITOR_MEMBER))
      .send({ date: '2026-10-01', available: false });

    expect(res.status).toBe(403);
  });

  it('lets an editor write availability', async () => {
    prisma.teamMember.findFirst.mockResolvedValue(acceptedMember);
    prisma.tour.findFirst.mockResolvedValue({ id: 'tour-1' });
    prisma.tourDateOverride.upsert.mockResolvedValue({ id: 'ov-1' });

    const res = await request(app)
      .post('/api/travioghana/supplier/availability/tour-1')
      .set(auth(EDITOR_MEMBER))
      .send({ date: '2026-10-01', available: false });

    expect(res.status).toBe(200);
  });
});

describe('team invite — owner side', () => {
  it('invites and reports a mail failure instead of failing the request', async () => {
    mockSendTeamInviteEmail.mockRejectedValue(new Error('resend down'));
    prisma.teamMember.create.mockResolvedValue({
      id: 'tm-9', email: 'new@test.com', role: 'editor', status: 'PENDING',
      createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await request(app)
      .post(`${GHANA}/invite`)
      .set(auth(OWNER))
      .send({ email: 'new@test.com', role: 'editor' });

    expect(res.status).toBe(201);
    expect(res.body.data.emailSent).toBe(false);
    expect(res.body.message).toMatch(/could not be sent/i);
  });

  it('refuses a direct add for an email with no account', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post(`${GHANA}/direct-add`)
      .set(auth(OWNER))
      .send({ email: 'ghost@test.com', role: 'finance' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no account exists/i);
  });

  it('grants roles on a direct add for an existing account', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'invitee-1' });
    prisma.teamMember.create.mockResolvedValue({
      id: 'tm-10', email: 'invitee@test.com', role: 'finance', status: 'ACCEPTED',
      acceptedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await request(app)
      .post(`${GHANA}/direct-add`)
      .set(auth(OWNER))
      .send({ email: 'invitee@test.com', role: 'finance' });

    expect(res.status).toBe(201);
    const update = prisma.user.update.mock.calls.find(([args]) => args.where.id === 'invitee-1');
    expect(update[0].data.roles).toEqual(expect.arrayContaining(['supplier', 'ghana']));
  });

  it('revokes a pending invitation and emails the invitee', async () => {
    prisma.teamMember.findFirst.mockResolvedValue({ ...pendingInvite, role: 'editor' });

    const res = await request(app)
      .delete(`${GHANA}/invite/tm-1`)
      .set(auth(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/revoked/i);
    expect(prisma.teamMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVOKED' }) }),
    );
  });
});
