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
  restaurantVenueReview: { findMany: jest.fn(), aggregate: jest.fn() },
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

jest.mock('../../src/core/services/restaurantHomepageRanking', () => ({
  getRecommended: jest.fn(),
  getLikelyToBookOut: jest.fn(),
  getSpecialOffers: jest.fn(),
  getSectionVenueIds: jest.fn(),
}));

const request = require('supertest');
const app = require('../../apps/platform-api/app');
const prisma = require('../../src/core/services/prismaClient');
const homeRanking = require('../../src/core/services/restaurantHomepageRanking');

describe('/api/restaurant-venues', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.restaurantVenue.findMany.mockResolvedValue([]);
    prisma.restaurantVenue.findFirst.mockResolvedValue(null);
    prisma.restaurantVenueReview.findMany.mockResolvedValue([]);
    prisma.restaurantVenueReview.aggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { _all: 0 },
    });
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

  it('serves the cross-venue review feed instead of reading "reviews" as a slug', async () => {
    prisma.restaurantVenueReview.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/restaurant-venues/reviews?brand=ghana&limit=5');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toEqual({
      reviews: [],
      stats: { averageRating: null, totalReviews: 0 },
      pagination: { limit: 5, hasMore: false, nextCursor: null },
    });
    expect(prisma.restaurantVenue.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an invalid feed brand before querying', async () => {
    const res = await request(app).get('/api/restaurant-venues/reviews?brand=moon');

    expect(res.status).toBe(400);
    expect(prisma.restaurantVenueReview.findMany).not.toHaveBeenCalled();
  });

  describe('homepage rails', () => {
    it('serves the recommended rail before the /:slugOrId catch-all', async () => {
      homeRanking.getRecommended.mockResolvedValue([{ id: 'v1' }]);

      const res = await request(app).get(
        '/api/restaurant-venues/homepage/recommended?brand=ghana&limit=3&city=Accra&lat=5.5&lng=-0.18',
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'success', data: { venues: [{ id: 'v1' }] } });
      expect(homeRanking.getRecommended).toHaveBeenCalledWith({
        brand: 'ghana',
        limit: 3,
        city: 'Accra',
        lat: 5.5,
        lng: -0.18,
        userId: null,
      });
      expect(prisma.restaurantVenue.findFirst).not.toHaveBeenCalled();
    });

    it('serves the offers and demand rails with the same envelope', async () => {
      homeRanking.getSpecialOffers.mockResolvedValue([]);
      homeRanking.getLikelyToBookOut.mockResolvedValue([]);

      const offers = await request(app).get('/api/restaurant-venues/homepage/offers');
      const demand = await request(app).get('/api/restaurant-venues/homepage/likely-to-book-out');

      expect(offers.status).toBe(200);
      expect(offers.body).toEqual({ status: 'success', data: { venues: [] } });
      expect(demand.status).toBe(200);
      expect(demand.body).toEqual({ status: 'success', data: { venues: [] } });
      expect(homeRanking.getSpecialOffers).toHaveBeenCalledWith(
        expect.objectContaining({ brand: 'ghana', limit: 8 }),
      );
    });

    it('returns section ids in display order', async () => {
      homeRanking.getSectionVenueIds.mockResolvedValue(['v2', 'v1']);

      const res = await request(app).get(
        '/api/restaurant-venues/homepage/section-venue-ids?section=offers&limit=2',
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'success', data: { venueIds: ['v2', 'v1'] } });
      expect(homeRanking.getSectionVenueIds).toHaveBeenCalledWith(
        expect.objectContaining({ section: 'offers', limit: 2 }),
      );
    });
  });
});
