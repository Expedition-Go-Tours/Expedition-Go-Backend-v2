/**
 * `/settings/team/my-role` reports which storefronts the BUSINESS is live on,
 * so the supplier dashboard's "Live Site" control can offer a choice.
 *
 * The trap this file guards: `TeamMember.supplierId` is a User id, while the
 * owner branch returns a SupplierProfile id — same field name, two meanings.
 * And a member's own roles are always `['customer']`, because 'expedition' is
 * not in BRAND_ROLES and is therefore never inherited. The answer has to come
 * from the OWNER in every branch, or team members silently lose the menu.
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
  payout: { findMany: jest.fn(), findFirst: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
  payoutRequest: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  payoutMethod: { findMany: jest.fn(), count: jest.fn() },
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

jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  sendTeamInviteEmail: jest.fn(() => Promise.resolve()),
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

const base = (roles) => ({
  name: 'Probe', email: '', roles, active: true, photoURL: '', notificationPreferences: {},
});

const OWNER_BOTH = { ...base(['supplier', 'ghana', 'expedition']), id: 'owner-both', email: 'both@test.com' };
const OWNER_GHANA = { ...base(['supplier', 'ghana']), id: 'owner-ghana', email: 'ghana@test.com' };
const ADMIN = { ...base(['admin']), id: 'admin-1', email: 'admin@test.com' };
const PLAIN = { ...base(['customer']), id: 'member-1', email: 'member@test.com' };

const USERS = {
  'owner-both': OWNER_BOTH,
  'owner-ghana': OWNER_GHANA,
  'admin-1': ADMIN,
  'member-1': PLAIN,
};

const token = (user) => signAccessToken({ userId: user.id });
const auth = (user) => ({ Authorization: `Bearer ${token(user)}` });

const MY_ROLE = '/api/travioghana/supplier/settings/team/my-role';

beforeEach(() => {
  jest.clearAllMocks();

  prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(USERS[where.id] || null));
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.user.update.mockImplementation(({ where, data }) => Promise.resolve({ ...USERS[where.id], ...data }));

  // Only owner accounts hold a supplier profile — members and admins do not.
  prisma.supplierProfile.findFirst.mockImplementation(({ where }) => (
    Promise.resolve(where.userId === 'owner-both' || where.userId === 'owner-ghana'
      ? { id: `profile-${where.userId}` }
      : null)
  ));

  prisma.teamMember.findFirst.mockResolvedValue(null);
  prisma.teamMember.count.mockResolvedValue(0);
  prisma.$transaction.mockImplementation(async (cb) => (typeof cb === 'function' ? cb(prisma) : cb));
});

describe('GET /settings/team/my-role — storefronts', () => {
  it('maps an owner with both brand roles to Travio Ghana first, then Expedition', async () => {
    const res = await request(app).get(MY_ROLE).set(auth(OWNER_BOTH));

    expect(res.status).toBe(200);
    expect(res.body.data.storefronts).toEqual(['GHANA', 'EXPEDITION']);
    expect(res.body.data.isOwner).toBe(true);
  });

  it('maps an owner with only the ghana role to a single storefront', async () => {
    const res = await request(app).get(MY_ROLE).set(auth(OWNER_GHANA));

    expect(res.status).toBe(200);
    expect(res.body.data.storefronts).toEqual(['GHANA']);
  });

  it('reads the OWNER roles for a team member, whose own roles never carry expedition', async () => {
    // The member is a plain `customer`: 'expedition' is not in BRAND_ROLES, so
    // accepting the invite never copies it onto them.
    expect(PLAIN.roles).toEqual(['customer']);

    prisma.teamMember.findFirst.mockResolvedValue({
      roles: ['editor'],
      role: 'editor',
      supplierId: OWNER_BOTH.id,
      supplier: { roles: OWNER_BOTH.roles },
    });

    const res = await request(app).get(MY_ROLE).set(auth(PLAIN));

    expect(res.status).toBe(200);
    expect(res.body.data.isOwner).toBe(false);
    expect(res.body.data.roles).toEqual(['editor']);
    expect(res.body.data.storefronts).toEqual(['GHANA', 'EXPEDITION']);
  });

  it('returns an empty list for a team member whose owner has no brand roles', async () => {
    prisma.teamMember.findFirst.mockResolvedValue({
      roles: ['support'],
      role: 'support',
      supplierId: OWNER_GHANA.id,
      supplier: { roles: ['supplier'] },
    });

    const res = await request(app).get(MY_ROLE).set(auth(PLAIN));

    expect(res.status).toBe(200);
    expect(res.body.data.storefronts).toEqual([]);
  });

  it('returns an empty list for an admin, who is not a supplier', async () => {
    const res = await request(app).get(MY_ROLE).set(auth(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.data.storefronts).toEqual([]);
  });

  it('always ships the key, so the dashboard can distinguish "none" from "not answered"', async () => {
    // No supplier profile and no membership: the pre-existing "nobody" answer.
    const res = await request(app).get(MY_ROLE).set(auth(PLAIN));

    expect(res.status).toBe(200);
    expect(res.body.data.storefronts).toEqual([]);
    expect(res.body.data.isOwner).toBe(false);
  });
});
