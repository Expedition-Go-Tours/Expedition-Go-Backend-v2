/**
 * HTTP contract for the restaurant review write surface.
 *
 * The service is mocked so this file proves routing, auth, permissions and
 * validation only. Business rules live in restaurantVenueWriteService.test.js.
 */

jest.mock('../../config/jwt', () => ({
  verifyAccessToken: jest.fn((token) => {
    if (token === 'user-token') return { userId: 'u1' };
    if (token === 'admin-token') return { userId: 'admin1' };
    throw new Error('invalid token');
  }),
}));

jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn() },
  adminRole: { findUnique: jest.fn() },
  restaurantVenue: { findMany: jest.fn(), findFirst: jest.fn() },
  restaurantVenueReview: { findMany: jest.fn() },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateTourCaches: jest.fn(() => Promise.resolve()),
  invalidateReviewCaches: jest.fn(() => Promise.resolve()),
  invalidateRestaurantVenueCaches: jest.fn(() => Promise.resolve()),
  invalidateHomepageCaches: jest.fn(() => Promise.resolve()),
  invalidateHomepageSections: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/restaurantVenueWriteService', () => ({
  createReview: jest.fn(),
  deleteOwnReview: jest.fn(),
  submitReport: jest.fn(),
  listPendingReviews: jest.fn(),
  moderateReview: jest.fn(),
  resolveReport: jest.fn(),
  createInvite: jest.fn(),
}));

const request = require('supertest');
const app = require('../../apps/platform-api/app');
const prisma = require('../../src/core/services/prismaClient');
const write = require('../../src/core/services/restaurantVenueWriteService');

const VALID_REVIEW = {
  rating: 5,
  title: 'Worth the queue',
  body: 'The jollof was smoky and the service was warm from start to finish.',
  visitedAt: '2026-11-20',
};

const user = (token) => `Bearer ${token}`;

describe('/api/restaurant-venues write routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve({
        id: where.id,
        name: where.id === 'admin1' ? 'Admin' : 'Guest',
        email: 'guest@example.com',
        active: true,
        roles: where.id === 'admin1' ? ['admin'] : ['user'],
        adminRoleId: where.id === 'admin1' ? 'role1' : null,
      }),
    );
    prisma.adminRole.findUnique.mockResolvedValue({
      id: 'role1',
      permissions: [
        { permission: { key: 'reviews.view' } },
        { permission: { key: 'reviews.moderate' } },
      ],
    });
    write.createReview.mockResolvedValue({ id: 'r1', status: 'PENDING' });
    write.deleteOwnReview.mockResolvedValue({ id: 'r1', status: 'ARCHIVED' });
    write.submitReport.mockResolvedValue({ id: 'rep1', status: 'OPEN' });
    write.listPendingReviews.mockResolvedValue({ reviews: [], pagination: {} });
    write.moderateReview.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
    write.resolveReport.mockResolvedValue({ id: 'rep1', reviewStatus: 'REMOVED' });
    write.createInvite.mockResolvedValue({ token: 'signed.token', proofMethod: 'QR_RECEIPT' });
  });

  it('refuses an anonymous review submission before validation', async () => {
    const res = await request(app)
      .post('/api/restaurant-venues/buka/reviews')
      .send(VALID_REVIEW);

    expect(res.status).toBe(401);
    expect(write.createReview).not.toHaveBeenCalled();
  });

  it('submits a review on both API prefixes with the author taken from the token', async () => {
    const legacy = await request(app)
      .post('/api/restaurant-venues/buka/reviews')
      .set('Authorization', user('user-token'))
      .send(VALID_REVIEW);

    const canonical = await request(app)
      .post('/api/v1/restaurant-venues/buka/reviews')
      .set('Authorization', user('user-token'))
      .send(VALID_REVIEW);

    expect(legacy.status).toBe(201);
    expect(canonical.status).toBe(201);
    expect(write.createReview).toHaveBeenCalledTimes(2);
    expect(write.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        slugOrId: 'buka',
        brand: 'ghana',
        author: expect.objectContaining({ id: 'u1' }),
      }),
    );
  });

  it('rejects a client that tries to set its own provenance', async () => {
    const res = await request(app)
      .post('/api/restaurant-venues/buka/reviews')
      .set('Authorization', user('user-token'))
      .send({ ...VALID_REVIEW, source: 'TRAVIO_VERIFIED', verified: true });

    expect(res.status).toBe(400);
    expect(write.createReview).not.toHaveBeenCalled();
  });

  it('rejects an author id in the body', async () => {
    const res = await request(app)
      .post('/api/restaurant-venues/buka/reviews')
      .set('Authorization', user('user-token'))
      .send({ ...VALID_REVIEW, authorId: 'someone-else' });

    expect(res.status).toBe(400);
    expect(write.createReview).not.toHaveBeenCalled();
  });

  it('rejects a review shorter than 20 characters', async () => {
    const res = await request(app)
      .post('/api/restaurant-venues/buka/reviews')
      .set('Authorization', user('user-token'))
      .send({ ...VALID_REVIEW, body: 'Nice' });

    expect(res.status).toBe(400);
  });

  it('requires auth to archive a review', async () => {
    const res = await request(app).delete('/api/restaurant-venues/buka/reviews/r1');

    expect(res.status).toBe(401);
    expect(write.deleteOwnReview).not.toHaveBeenCalled();
  });

  it('accepts a report from a signed-in customer', async () => {
    const res = await request(app)
      .post('/api/restaurant-venues/buka/reviews/r1/report')
      .set('Authorization', user('user-token'))
      .send({ reason: 'Not a first-hand visit' });

    expect(res.status).toBe(201);
    expect(write.submitReport).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'r1', reporter: expect.objectContaining({ id: 'u1' }) }),
    );
  });

  it('keeps the moderation queue away from non-admins', async () => {
    const res = await request(app)
      .get('/api/admin/restaurant-venues/reviews/pending')
      .set('Authorization', user('user-token'));

    expect(res.status).toBe(403);
    expect(write.listPendingReviews).not.toHaveBeenCalled();
  });

  it('serves the moderation queue to permitted admins on both prefixes', async () => {
    const legacy = await request(app)
      .get('/api/admin/restaurant-venues/reviews/pending')
      .set('Authorization', user('admin-token'));
    const canonical = await request(app)
      .get('/api/v1/admin/restaurant-venues/reviews/pending')
      .set('Authorization', user('admin-token'));

    expect(legacy.status).toBe(200);
    expect(canonical.status).toBe(200);
    expect(canonical.body).toEqual(legacy.body);
  });

  it('routes moderation and report decisions to the write service', async () => {
    const moderated = await request(app)
      .patch('/api/admin/restaurant-venues/reviews/r1/moderate')
      .set('Authorization', user('admin-token'))
      .send({ action: 'approve' });
    const resolved = await request(app)
      .patch('/api/admin/restaurant-venues/reports/rep1')
      .set('Authorization', user('admin-token'))
      .send({ classification: 'FAKE', outcome: 'UPHELD' });

    expect(moderated.status).toBe(200);
    expect(resolved.status).toBe(200);
    expect(write.moderateReview).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: 'admin1', action: 'approve' }),
    );
    expect(write.resolveReport).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: 'admin1', classification: 'FAKE' }),
    );
  });

  it('mints an invite only for an admin with moderation permission', async () => {
    const res = await request(app)
      .post('/api/admin/restaurant-venues/buka/review-invites')
      .set('Authorization', user('admin-token'))
      .send({ proofMethod: 'QR_RECEIPT' });

    expect(res.status).toBe(201);
    expect(res.body.data.invite.token).toBe('signed.token');
    expect(write.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: 'admin1', input: { proofMethod: 'QR_RECEIPT' } }),
    );
  });
});
