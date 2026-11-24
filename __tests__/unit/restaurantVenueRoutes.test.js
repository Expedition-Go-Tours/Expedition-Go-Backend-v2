/**
 * Route-level contract for /api/restaurant-venues.
 *
 * Proves the router is mounted on both API prefixes, that validation rejects
 * bad filters with a 400 before any query runs, and that the response envelope
 * matches the rest of the platform. No database: Prisma is mocked at the
 * client boundary.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  restaurantVenue: { findMany: jest.fn(), findFirst: jest.fn() },
  restaurantVenueReview: { findMany: jest.fn() },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateTourCaches: jest.fn(() => Promise.resolve()),
  invalidateReviewCaches: jest.fn(() => Promise.resolve()),
  invalidateHomepageCaches: jest.fn(() => Promise.resolve()),
  invalidateHomepageSections: jest.fn(() => Promise.resolve()),
}));

const request = require('supertest');
const app = require('../../apps/platform-api/app');
const prisma = require('../../src/core/services/prismaClient');

describe('/api/restaurant-venues', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.restaurantVenue.findMany.mockResolvedValue([]);
    prisma.restaurantVenue.findFirst.mockResolvedValue(null);
  });

  it('lists venues for the legacy prefix', async () => {
    const res = await request(app).get('/api/restaurant-venues');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.venues).toEqual([]);
    expect(res.body.data.pagination).toEqual({
      limit: 20,
      hasMore: false,
      nextCursor: null,
    });
  });

  it('serves the same contract on the canonical prefix', async () => {
    const legacy = await request(app).get('/api/restaurant-venues?limit=5');
    const canonical = await request(app).get('/api/v1/restaurant-venues?limit=5');

    expect(canonical.status).toBe(legacy.status);
    expect(canonical.body).toEqual(legacy.body);
  });

  it('rejects an out-of-range filter before touching the database', async () => {
    const res = await request(app).get('/api/restaurant-venues?priceBand=9');

    expect(res.status).toBe(400);
    expect(prisma.restaurantVenue.findMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown sort', async () => {
    const res = await request(app).get('/api/restaurant-venues?sort=cheapest');

    expect(res.status).toBe(400);
    expect(prisma.restaurantVenue.findMany).not.toHaveBeenCalled();
  });

  it('404s an unknown venue', async () => {
    const res = await request(app).get('/api/restaurant-venues/not-a-venue');

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Venue not found/);
  });

  it('404s reviews for an unknown venue instead of an empty list', async () => {
    const res = await request(app).get('/api/restaurant-venues/not-a-venue/reviews');

    expect(res.status).toBe(404);
    expect(prisma.restaurantVenueReview.findMany).not.toHaveBeenCalled();
  });
});
