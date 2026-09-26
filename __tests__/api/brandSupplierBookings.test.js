/**
 * The supplier's Bookings page is served from the BRAND storefront routers
 * (`/api/travioghana/supplier/bookings`, `/api/travioafrica/supplier/bookings`):
 * both dashboards rewrite their `/bookings/supplier/*` calls into a brand
 * namespace, so these are the routes the page actually hits.
 *
 * Those routes were gated on `restrictTo('supplier')`, which reads the CALLER's
 * own `roles` — and a team member's own account carries `['customer']`, because
 * the supplier they work for is reached through the membership, not through their
 * roles. So the page was refused to every member of every role, and the controller
 * behind it scoped by `req.user.id`, which for a member owns no tours at all. The
 * visible result was an empty "No bookings yet" page with a permission toast on
 * both brands: indistinguishable from a supplier with no bookings, which is how it
 * survived the role audit.
 *
 * These tests assert the whole chain — the guard AND the scoping — per role, for
 * every brand that serves it.
 */
const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

jest.mock('../../src/core/services/prismaClient', () => ({
  travioGhanaTour: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  expeditionTour: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  tour: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  user: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  supplierProfile: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  adminRole: { findUnique: jest.fn() },
  teamMember: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  review: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  booking: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn(), count: jest.fn().mockResolvedValue(0), aggregate: jest.fn(), groupBy: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  specialOffer: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), count: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  specialOfferTarget: { findMany: jest.fn().mockResolvedValue([]) },
  newsletterSubscriber: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  tourDateOverride: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn(), findFirst: jest.fn() },
  wishlistItem: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn() },
  notification: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), count: jest.fn(), updateMany: jest.fn(), update: jest.fn(), delete: jest.fn(), aggregate: jest.fn() },
  adminNotification: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  payout: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  payoutRequest: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  payoutMethod: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  dispute: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  chatConversation: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  conversationParticipant: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), deleteMany: jest.fn() },
  message: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  cancellationRecord: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  cancellationRequest: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
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

// The controllers reach for the cancellation-request service to attach chips;
// keep the rest of it real, since other modules loaded by app.js use it.
jest.mock('../../src/core/services/cancellationRequestService', () => ({
  ...jest.requireActual('../../src/core/services/cancellationRequestService'),
  pendingRequestsForBookingIds: jest.fn(async () => new Map()),
}));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const OWNER = { id: 'owner-1', name: 'Expedition-Go Tours', email: 'owner@test.com', roles: ['supplier'], active: true, photoURL: '', notificationPreferences: {} };
const EDITOR = { id: 'editor-1', name: 'Editor', email: 'editor@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const SUPPORT = { id: 'support-1', name: 'Support', email: 'support@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const FINANCE = { id: 'finance-1', name: 'Finance', email: 'finance@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const CUSTOMER = { id: 'customer-1', name: 'Traveller', email: 'traveller@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };

const USERS = {
  'owner-1': OWNER,
  'editor-1': EDITOR,
  'support-1': SUPPORT,
  'finance-1': FINANCE,
  'customer-1': CUSTOMER,
};

const MEMBERS = {
  'editor@test.com': { roles: ['editor'], role: 'editor' },
  'support@test.com': { roles: ['support'], role: 'support' },
  'finance@test.com': { roles: ['finance'], role: 'finance' },
};

const auth = (user) => ({ Authorization: `Bearer ${signAccessToken({ userId: user.id })}` });

/** Both dashboards rewrite into a brand namespace, and both brands serve it. */
const BRAND_LISTS = [
  '/api/travioghana/supplier/bookings',
  '/api/travioafrica/supplier/bookings',
];

beforeEach(() => {
  jest.clearAllMocks();

  prisma.booking.findMany.mockResolvedValue([]);
  prisma.booking.count.mockResolvedValue(0);
  prisma.booking.findFirst.mockResolvedValue(null);
  prisma.booking.aggregate.mockResolvedValue({ _sum: { grossAmount: 0, supplierPayout: 0 }, _count: 0 });
  prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(USERS[where.id] || null));
  prisma.user.findFirst.mockResolvedValue(null);

  // Only the owner is a supplier in their own right. A member reaches the account
  // through an ACCEPTED membership; a traveller has neither.
  const isOwner = (userId) => userId === 'owner-1';
  prisma.supplierProfile.findFirst.mockImplementation(({ where }) => (
    Promise.resolve(isOwner(where.userId) ? { id: 'profile-1', status: 'ACTIVE' } : null)
  ));
  // The bookings controller asks for the profile by the supplier it resolved.
  prisma.supplierProfile.findUnique.mockImplementation(({ where }) => (
    Promise.resolve(isOwner(where.userId) ? { id: 'profile-1', status: 'ACTIVE' } : null)
  ));

  prisma.teamMember.findFirst.mockImplementation(({ where }) => {
    const membership = MEMBERS[where?.email];
    if (!membership || where?.status !== 'ACCEPTED') return Promise.resolve(null);
    return Promise.resolve({ roles: membership.roles, role: membership.role, supplierId: 'owner-1' });
  });
});

/** The scoping assertion: the query named the owner's tours, not the caller's. */
const expectScopedToOwner = (mock) => {
  expect(mock).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ tour: expect.objectContaining({ supplierId: 'owner-1' }) }) }),
  );
};

describe.each(BRAND_LISTS)('the bookings list at %s', (LIST) => {
  it('serves an editor member the OWNER\'s bookings', async () => {
    const res = await request(app).get(LIST).set(auth(EDITOR));

    expect(res.status).toBe(200);
    expectScopedToOwner(prisma.booking.findMany);
  });

  it('leaves the owner serving themselves, unchanged', async () => {
    const res = await request(app).get(LIST).set(auth(OWNER));

    expect(res.status).toBe(200);
    expectScopedToOwner(prisma.booking.findMany);
  });

  it('refuses a support member — the page is not theirs (bookings.view)', async () => {
    const res = await request(app).get(LIST).set(auth(SUPPORT));

    expect(res.status).toBe(403);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('refuses a finance member', async () => {
    const res = await request(app).get(LIST).set(auth(FINANCE));

    expect(res.status).toBe(403);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('refuses a traveller, who is neither supplier nor member', async () => {
    const res = await request(app).get(LIST).set(auth(CUSTOMER));

    expect(res.status).toBe(403);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });
});

describe.each(BRAND_LISTS)('the booking status change at %s', (LIST) => {
  it('lets an editor member through and scopes it to the owner', async () => {
    const res = await request(app)
      .patch(`${LIST}/booking-1/status`)
      .set(auth(EDITOR))
      .send({ status: 'CONFIRMED' });

    // The guard let them through, and the controller looked in the OWNER's
    // bookings: it found none (there are none in this fixture), which is a 404
    // and not the 403 the old role check produced.
    expect(res.status).not.toBe(403);
    expectScopedToOwner(prisma.booking.findFirst);
  });

  it('refuses a support member — changing a booking is not theirs (bookings.manage)', async () => {
    const res = await request(app)
      .patch(`${LIST}/booking-1/status`)
      .set(auth(SUPPORT))
      .send({ status: 'CONFIRMED' });

    expect(res.status).toBe(403);
    expect(prisma.booking.findFirst).not.toHaveBeenCalled();
  });
});
