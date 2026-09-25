/**
 * Chat is a shared route: customers, suppliers and team members all use it, so
 * the blanket `requirePermission` above it deliberately lets every non-admin
 * through. That left the supplier's customer inbox readable by ANY accepted
 * member — `GET /chat/conversations` returned 200 with the business's threads to
 * an editor or a finance member, while the dashboards hide the Customers page
 * from them (it is gated on `chat.view`, i.e. admin + support).
 *
 * The fix gates on "acting through a membership" rather than on the account
 * type, so customers, the owner and platform admins are untouched.
 */
const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

jest.mock('../../src/core/services/prismaClient', () => ({
  travioGhanaTour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  expeditionTour: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  tour: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  user: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  supplierProfile: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  adminRole: { findUnique: jest.fn() },
  teamMember: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  review: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  booking: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  specialOffer: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  specialOfferTarget: { findMany: jest.fn().mockResolvedValue([]) },
  newsletterSubscriber: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  tourDateOverride: { findMany: jest.fn(), upsert: jest.fn(), findFirst: jest.fn() },
  wishlistItem: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), delete: jest.fn() },
  notification: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), updateMany: jest.fn(), update: jest.fn(), delete: jest.fn(), aggregate: jest.fn() },
  adminNotification: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn() },
  payout: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  payoutRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  payoutMethod: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  dispute: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  chatConversation: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  conversationParticipant: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), deleteMany: jest.fn() },
  message: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  cancellationRecord: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  event: { findMany: jest.fn() },
  auditLog: { findMany: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  resolveEmailBrand: jest.fn(() => 'ghana'),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const OWNER = { id: 'owner-1', name: 'Expedition-Go Tours', email: 'owner@test.com', roles: ['supplier'], active: true, photoURL: '', notificationPreferences: {} };
const SUPPORT = { id: 'support-1', name: 'Support', email: 'support@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const EDITOR = { id: 'editor-1', name: 'Editor', email: 'editor@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const FINANCE = { id: 'finance-1', name: 'Finance', email: 'finance@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const CUSTOMER = { id: 'customer-1', name: 'Traveller', email: 'traveller@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };

const USERS = {
  'owner-1': OWNER,
  'support-1': SUPPORT,
  'editor-1': EDITOR,
  'finance-1': FINANCE,
  'customer-1': CUSTOMER,
};

const MEMBERS = {
  'support@test.com': { roles: ['support'], role: 'support' },
  'editor@test.com': { roles: ['editor'], role: 'editor' },
  'finance@test.com': { roles: ['finance'], role: 'finance' },
};

const auth = (user) => ({ Authorization: `Bearer ${signAccessToken({ userId: user.id })}` });
const CONVERSATIONS = '/api/chat/conversations';

beforeEach(() => {
  jest.clearAllMocks();

  const models = ['tour', 'user', 'review', 'booking', 'specialOffer', 'payout', 'notification', 'teamMember', 'payoutRequest', 'dispute', 'cancellationRecord', 'wishlistItem'];
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
  prisma.message.count.mockResolvedValue(0);
  prisma.conversationParticipant.findMany.mockResolvedValue([]);

  // Only the owner is a supplier in their own right; members reach the account
  // through an ACCEPTED membership, and the traveller has neither.
  prisma.supplierProfile.findFirst.mockImplementation(({ where }) => (
    Promise.resolve(where.userId === 'owner-1' ? { id: 'profile-1' } : null)
  ));

  prisma.teamMember.findFirst.mockImplementation(({ where }) => {
    const membership = MEMBERS[where?.email];
    if (!membership || where?.status !== 'ACCEPTED') return Promise.resolve(null);
    return Promise.resolve({ roles: membership.roles, role: membership.role, supplierId: 'owner-1' });
  });
});

describe('chat access for team members', () => {
  it('refuses the supplier inbox to a member without chat.view (editor)', async () => {
    const res = await request(app).get(CONVERSATIONS).set(auth(EDITOR));

    expect(res.status).toBe(403);
    expect(prisma.conversationParticipant.findMany).not.toHaveBeenCalled();
  });

  it('refuses it to a finance member too', async () => {
    const res = await request(app).get(CONVERSATIONS).set(auth(FINANCE));

    expect(res.status).toBe(403);
  });

  it('serves it to a support member, scoped to the supplier account', async () => {
    const res = await request(app).get(CONVERSATIONS).set(auth(SUPPORT));

    expect(res.status).toBe(200);
    // The membership, not the member's own account, decides whose inbox this is.
    expect(prisma.conversationParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'owner-1' } }),
    );
  });

  it('leaves the owner alone — they act as themselves, not as a member', async () => {
    const res = await request(app).get(CONVERSATIONS).set(auth(OWNER));

    expect(res.status).toBe(200);
    expect(prisma.conversationParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'owner-1' } }),
    );
  });

  it('leaves a traveller alone — chat is their route too', async () => {
    const res = await request(app).get(CONVERSATIONS).set(auth(CUSTOMER));

    expect(res.status).toBe(200);
    expect(prisma.conversationParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'customer-1' } }),
    );
  });
});
