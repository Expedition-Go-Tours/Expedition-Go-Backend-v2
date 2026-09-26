/**
 * The Analytics page is gated on `analytics.view` (admin + editor + finance),
 * but it used to build its per-product charts by calling the supplier's BOOKINGS
 * LIST — `bookings.view`, which is admin + editor. A finance member could open
 * Analytics and got a "You do not have permission" error instead of the charts.
 *
 * These tests cover the endpoint that replaced it: keyed on the same permission
 * as the page, scoped to the supplier the caller acts for.
 */
const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

jest.mock('../../src/core/services/prismaClient', () => ({
  travioGhanaTour: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  expeditionTour: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  tour: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn(), create: jest.fn(), delete: jest.fn() },
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

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const OWNER = { id: 'owner-1', name: 'Expedition-Go Tours', email: 'owner@test.com', roles: ['supplier'], active: true, photoURL: '', notificationPreferences: {} };
const EDITOR = { id: 'editor-1', name: 'Editor', email: 'editor@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const FINANCE = { id: 'finance-1', name: 'Finance', email: 'finance@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const SUPPORT = { id: 'support-1', name: 'Support', email: 'support@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };
const CUSTOMER = { id: 'customer-1', name: 'Traveller', email: 'traveller@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };

const USERS = {
  'owner-1': OWNER,
  'editor-1': EDITOR,
  'finance-1': FINANCE,
  'support-1': SUPPORT,
  'customer-1': CUSTOMER,
};

const MEMBERS = {
  'editor@test.com': { roles: ['editor'], role: 'editor' },
  'finance@test.com': { roles: ['finance'], role: 'finance' },
  'support@test.com': { roles: ['support'], role: 'support' },
};

const auth = (user) => ({ Authorization: `Bearer ${signAccessToken({ userId: user.id })}` });
const PRODUCTS = '/api/suppliers/analytics/products';

beforeEach(() => {
  jest.clearAllMocks();

  prisma.booking.groupBy.mockResolvedValue([
    { tourId: 'tour-1', _count: { _all: 7 }, _sum: { grossAmount: 2100, supplierPayout: 1470 } },
    { tourId: 'tour-2', _count: { _all: 2 }, _sum: { grossAmount: 300, supplierPayout: 210 } },
  ]);
  prisma.tour.findMany.mockResolvedValue([
    { id: 'tour-1', title: 'Shai Hills Safari', coverPhoto: 'https://cdn.test/shai.jpg', averageRating: 4.5 },
    { id: 'tour-2', title: 'Cape Coast Castle', coverPhoto: null, averageRating: 4.1 },
  ]);
  prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(USERS[where.id] || null));
  prisma.user.findFirst.mockResolvedValue(null);

  const isOwner = (userId) => userId === 'owner-1';
  prisma.supplierProfile.findFirst.mockImplementation(({ where }) => (
    Promise.resolve(isOwner(where.userId) ? { id: 'profile-1', status: 'ACTIVE' } : null)
  ));
  prisma.supplierProfile.findUnique.mockImplementation(({ where }) => (
    Promise.resolve(isOwner(where.userId) ? { id: 'profile-1', status: 'ACTIVE' } : null)
  ));

  prisma.teamMember.findFirst.mockImplementation(({ where }) => {
    const membership = MEMBERS[where?.email];
    if (!membership || where?.status !== 'ACCEPTED') return Promise.resolve(null);
    return Promise.resolve({ roles: membership.roles, role: membership.role, supplierId: 'owner-1' });
  });
});

describe('per-product analytics', () => {
  it('serves a FINANCE member the charts — the page is theirs to open', async () => {
    const res = await request(app).get(PRODUCTS).set(auth(FINANCE));

    expect(res.status).toBe(200);
    expect(res.body.data.products).toHaveLength(2);
  });

  it('serves an editor member and the owner too', async () => {
    expect((await request(app).get(PRODUCTS).set(auth(EDITOR))).status).toBe(200);
    expect((await request(app).get(PRODUCTS).set(auth(OWNER))).status).toBe(200);
  });

  it('refuses a support member — Analytics is not theirs (analytics.view)', async () => {
    const res = await request(app).get(PRODUCTS).set(auth(SUPPORT));

    expect(res.status).toBe(403);
    expect(prisma.booking.groupBy).not.toHaveBeenCalled();
  });

  it('refuses a traveller', async () => {
    expect((await request(app).get(PRODUCTS).set(auth(CUSTOMER))).status).toBe(403);
  });

  it('groups the OWNER\'s bookings, not the caller\'s', async () => {
    await request(app).get(PRODUCTS).set(auth(FINANCE));

    expect(prisma.booking.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tour: expect.objectContaining({ supplierId: 'owner-1' }) }) }),
    );
  });

  it('joins the counts and sums to the tour title, photo and rating', async () => {
    const res = await request(app).get(PRODUCTS).set(auth(OWNER));

    expect(res.body.data.products).toEqual([
      { tourId: 'tour-1', name: 'Shai Hills Safari', photo: 'https://cdn.test/shai.jpg', rating: 4.5, bookings: 7, revenue: 2100, payout: 1470 },
      { tourId: 'tour-2', name: 'Cape Coast Castle', photo: null, rating: 4.1, bookings: 2, revenue: 300, payout: 210 },
    ]);
  });

  it('names a tour that no longer resolves, rather than dropping the row', async () => {
    prisma.tour.findMany.mockResolvedValue([{ id: 'tour-1', title: 'Shai Hills Safari', coverPhoto: null, averageRating: 0 }]);

    const res = await request(app).get(PRODUCTS).set(auth(OWNER));

    expect(res.body.data.products[1].name).toBe('Unknown product');
  });

  it('returns an empty list, not an error, for a supplier with no bookings', async () => {
    prisma.booking.groupBy.mockResolvedValue([]);

    const res = await request(app).get(PRODUCTS).set(auth(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data.products).toEqual([]);
    expect(prisma.tour.findMany).not.toHaveBeenCalled();
  });
});
