/**
 * HTTP contract for admin restaurant offers: existing admin auth/permissions,
 * Zod validation and the response envelope. The service is mocked.
 */

jest.mock('../../config/jwt', () => ({
  verifyAccessToken: jest.fn((token) => {
    if (token === 'admin-token') return { userId: 'admin1' };
    if (token === 'user-token') return { userId: 'u1' };
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

jest.mock('../../src/core/services/restaurantVenueOfferService', () => ({
  listOffers: jest.fn(),
  createOffer: jest.fn(),
  updateOffer: jest.fn(),
  deleteOffer: jest.fn(),
}));

const request = require('supertest');
const app = require('../../apps/platform-api/app');
const prisma = require('../../src/core/services/prismaClient');
const offers = require('../../src/core/services/restaurantVenueOfferService');

const admin = 'Bearer admin-token';
const guest = 'Bearer user-token';

const VALID_OFFER = {
  brand: 'ghana',
  title: '20% off your table',
  discountType: 'PERCENTAGE',
  discountValue: 20,
  promoCode: 'GHANA20',
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-12-01T00:00:00.000Z',
  isActive: true,
  terms: 'Dine-in only',
};

describe('/api/admin/restaurant-venues/:venueId/offers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve({
        id: where.id,
        name: where.id === 'admin1' ? 'Admin' : 'Guest',
        email: 'admin@example.com',
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
    offers.listOffers.mockResolvedValue([]);
    offers.createOffer.mockResolvedValue({ id: 'o1' });
    offers.updateOffer.mockResolvedValue({ id: 'o1', discountValue: 25 });
    offers.deleteOffer.mockResolvedValue({ id: 'o1', deleted: true });
  });

  it('refuses anonymous reads before touching the service', async () => {
    const res = await request(app).get('/api/admin/restaurant-venues/v1/offers?brand=ghana');

    expect(res.status).toBe(401);
    expect(offers.listOffers).not.toHaveBeenCalled();
  });

  it('rejects a non-admin even with a valid token', async () => {
    const res = await request(app)
      .get('/api/admin/restaurant-venues/v1/offers?brand=ghana')
      .set('Authorization', guest);

    expect(res.status).toBe(403);
    expect(offers.listOffers).not.toHaveBeenCalled();
  });

  it('lists offers for an admin with the review permissions', async () => {
    const res = await request(app)
      .get('/api/admin/restaurant-venues/v1/offers?brand=ghana')
      .set('Authorization', admin);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ offers: [] });
    expect(offers.listOffers).toHaveBeenCalledWith({ venueId: 'v1', brand: 'ghana' });
  });

  it('rejects an offer whose end precedes its start', async () => {
    const res = await request(app)
      .post('/api/admin/restaurant-venues/v1/offers?brand=ghana')
      .set('Authorization', admin)
      .send({ ...VALID_OFFER, endsAt: '2026-10-01T00:00:00.000Z' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/endsAt must be after startsAt/);
    expect(offers.createOffer).not.toHaveBeenCalled();
  });

  it('rejects a non-positive discount', async () => {
    const res = await request(app)
      .post('/api/admin/restaurant-venues/v1/offers?brand=ghana')
      .set('Authorization', admin)
      .send({ ...VALID_OFFER, discountValue: 0 });

    expect(res.status).toBe(400);
    expect(offers.createOffer).not.toHaveBeenCalled();
  });

  it('creates a valid offer', async () => {
    const res = await request(app)
      .post('/api/admin/restaurant-venues/v1/offers?brand=ghana')
      .set('Authorization', admin)
      .send(VALID_OFFER);

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ offer: { id: 'o1' } });
    expect(offers.createOffer).toHaveBeenCalledWith({
      venueId: 'v1',
      brand: 'ghana',
      input: expect.objectContaining({ title: VALID_OFFER.title, discountValue: 20 }),
    });
  });

  it('creates a non-Ghana offer without a redundant brand in the body', async () => {
    const body = { ...VALID_OFFER };
    delete body.brand;

    const res = await request(app)
      .post('/api/admin/restaurant-venues/v1/offers?brand=africa')
      .set('Authorization', admin)
      .send(body);

    expect(res.status).toBe(201);
    expect(offers.createOffer).toHaveBeenCalledWith({
      venueId: 'v1',
      brand: 'africa',
      input: expect.objectContaining({ title: VALID_OFFER.title }),
    });
    expect(offers.createOffer.mock.calls[0][0].input.brand).toBeUndefined();
  });

  it('patches and deletes by offer id', async () => {
    const patch = await request(app)
      .patch('/api/admin/restaurant-venues/v1/offers/o1?brand=ghana')
      .set('Authorization', admin)
      .send({ discountValue: 25 });
    const remove = await request(app)
      .delete('/api/admin/restaurant-venues/v1/offers/o1?brand=ghana')
      .set('Authorization', admin);

    expect(patch.status).toBe(200);
    expect(offers.updateOffer).toHaveBeenCalledWith({
      venueId: 'v1',
      brand: 'ghana',
      offerId: 'o1',
      input: { discountValue: 25 },
    });
    expect(remove.status).toBe(200);
    expect(offers.deleteOffer).toHaveBeenCalledWith({
      venueId: 'v1',
      brand: 'ghana',
      offerId: 'o1',
    });
  });
});
