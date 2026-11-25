/**
 * Unit contract for the restaurant homepage rails.
 *
 * Prisma and the cache are mocked at their module boundary. The public venue
 * mapper is the real one, so every assertion on output shape also proves the
 * internal ranking numbers never leave the service.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  restaurantVenue: { findMany: jest.fn() },
  event: { findMany: jest.fn() },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fetchFn) => fetchFn()),
}));

jest.mock('../../src/core/services/restaurantVenueService', () => {
  const actual = jest.requireActual('../../src/core/services/restaurantVenueService');
  return { ...actual, toPublicVenue: jest.fn(actual.toPublicVenue) };
});

const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');
const venueService = require('../../src/core/services/restaurantVenueService');
const ranking = require('../../src/core/services/restaurantHomepageRanking');

const now = new Date('2026-11-25T12:00:00.000Z');

function venue(overrides = {}) {
  return {
    id: 'v1',
    slug: 'v1-place',
    name: 'V1 Place',
    status: 'ACTIVE',
    city: 'Accra',
    region: 'Greater Accra',
    neighbourhood: 'Osu',
    latitude: 5.56,
    longitude: -0.18,
    cuisines: ['ghanaian'],
    dietary: [],
    priceBand: 2,
    amenities: [],
    photos: [],
    coverPhoto: null,
    averageRating: 4.5,
    reviewCount: 20,
    recentRating: 4.6,
    recentReviewCount: 10,
    verifiedReviewCount: 5,
    externalSource: null,
    externalRating: null,
    externalReviewCount: 0,
    combinedRating: 4.6,
    combinedReviewCount: 100,
    rankingScore: 4.5,
    demandScore: 10,
    highDemand: false,
    rankInCity: 1,
    cityVenueCount: 10,
    distribution: null,
    listings: [{ isFeatured: false, displayOrder: 0 }],
    offers: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function offer(overrides = {}) {
  return {
    id: 'o1',
    brand: 'ghana',
    title: '10% off',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    promoCode: null,
    startsAt: null,
    endsAt: null,
    isActive: true,
    createdAt: new Date('2026-11-24T00:00:00.000Z'),
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    name: 'restaurant_card_clicked',
    resourceId: null,
    properties: {},
    createdAt: now,
    ...overrides,
  };
}

function ids(venues) {
  return venues.map((item) => item.id);
}

describe('restaurantHomepageRanking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now });
    prisma.restaurantVenue.findMany.mockResolvedValue([]);
    prisma.event.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getRecommended', () => {
    it('orders by stored quality and returns public DTOs only', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        venue({ id: 'mid', rankingScore: 4.1, cuisines: ['suya'] }),
        venue({ id: 'top', rankingScore: 4.8, cuisines: ['jollof'] }),
        venue({ id: 'low', rankingScore: 3.2, cuisines: ['banku'] }),
      ]);

      const rows = await ranking.getRecommended({ brand: 'ghana', limit: 3 });

      expect(ids(rows)).toEqual(['top', 'mid', 'low']);
      expect(rows[0]).toEqual(expect.objectContaining({ id: 'top', name: 'V1 Place' }));
      expect(rows[0]).not.toHaveProperty('rankingScore');
      expect(rows[0]).not.toHaveProperty('_score');
      expect(rows[0]).not.toHaveProperty('demandScore');
      expect(venueService.toPublicVenue).toHaveBeenCalledTimes(3);
      expect(prisma.restaurantVenue.findMany.mock.calls[0][0].where).toEqual({
        status: 'ACTIVE',
        listings: { some: { brand: 'ghana', isActive: true } },
      });
    });

    it('caps each cuisine at two cards in the first six, then backfills by score', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        venue({ id: 'j1', rankingScore: 5, cuisines: ['jollof'] }),
        venue({ id: 'j2', rankingScore: 4.9, cuisines: ['jollof'] }),
        venue({ id: 'j3', rankingScore: 4.8, cuisines: ['jollof'] }),
        venue({ id: 'j4', rankingScore: 4.7, cuisines: ['jollof'] }),
        venue({ id: 's1', rankingScore: 4.0, cuisines: ['suya'] }),
        venue({ id: 's2', rankingScore: 3.9, cuisines: ['suya'] }),
        venue({ id: 'b1', rankingScore: 3.0, cuisines: ['banku'] }),
        venue({ id: 'b2', rankingScore: 2.9, cuisines: ['banku'] }),
      ]);

      const rows = await ranking.getRecommended({ limit: 8 });
      const firstSix = rows.slice(0, 6);
      const counts = firstSix.reduce((acc, row) => {
        const cuisine = row.cuisines[0];
        acc[cuisine] = (acc[cuisine] || 0) + 1;
        return acc;
      }, {});

      expect(ids(rows)).toEqual(['j1', 'j2', 's1', 's2', 'b1', 'b2', 'j3', 'j4']);
      expect(counts).toEqual({ jollof: 2, suya: 2, banku: 2 });
    });

    it('puts city-local venues first and backfills globally when short', async () => {
      prisma.restaurantVenue.findMany.mockImplementation(({ where }) =>
        Promise.resolve(
          where.city
            ? [venue({ id: 'local', rankingScore: 3.0, city: 'Accra' })]
            : [
                venue({ id: 'far-low', rankingScore: 2.0, city: 'Kumasi', cuisines: ['banku'] }),
                venue({ id: 'far-high', rankingScore: 4.0, city: 'Kumasi', cuisines: ['suya'] }),
              ],
        ),
      );

      const rows = await ranking.getRecommended({ city: 'Accra', limit: 3 });

      expect(ids(rows)).toEqual(['local', 'far-high', 'far-low']);
    });

    it('excludes clicked venues and boosts cuisines from 30-day events', async () => {
      prisma.event.findMany.mockResolvedValue([
        event({ name: 'restaurant_card_clicked', resourceId: 'clicked' }),
        event({
          name: 'restaurant_search_used',
          properties: { query: 'suya', city: 'Accra' },
          createdAt: new Date('2026-11-20T00:00:00.000Z'),
        }),
      ]);
      prisma.restaurantVenue.findMany.mockResolvedValue([
        venue({ id: 'clicked', rankingScore: 5, cuisines: ['jollof'] }),
        venue({ id: 'plain', rankingScore: 4.2, cuisines: ['banku'], city: 'Kumasi' }),
        venue({ id: 'matched', rankingScore: 4.1, cuisines: ['suya'], city: 'Accra' }),
      ]);

      const rows = await ranking.getRecommended({ userId: 'u1', limit: 3 });

      expect(ids(rows)).toEqual(['matched', 'plain']);
      expect(prisma.event.findMany.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        name: { in: ['restaurant_card_clicked', 'restaurant_search_used'] },
        createdAt: { gte: expect.any(Date) },
      });
    });

    it('uses a brand-specific cache key and a five-minute TTL', async () => {
      await ranking.getRecommended({ brand: 'africa', limit: 8 });
      await ranking.getRecommended({ brand: 'ghana', limit: 8 });

      const [africa, ghana] = cache.getOrSet.mock.calls;
      expect(africa[0]).toMatch(/^rv:home:recommended:africa:/);
      expect(ghana[0]).toMatch(/^rv:home:recommended:ghana:/);
      expect(africa[0]).not.toBe(ghana[0]);
      expect(africa[2]).toBe(300);
    });
  });

  describe('getLikelyToBookOut', () => {
    it('treats highDemand as a boost, not a gate, and backfills by demand', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        venue({ id: 'eligible', recentReviewCount: 5, demandScore: 8, highDemand: false }),
        venue({ id: 'flagged', recentReviewCount: 1, demandScore: 7, highDemand: true }),
        venue({ id: 'volume', recentReviewCount: 2, demandScore: 9, highDemand: false }),
      ]);

      const rows = await ranking.getLikelyToBookOut({ limit: 3 });

      expect(ids(rows)).toEqual(['eligible', 'volume', 'flagged']);
      expect(rows.every((row) => row.highDemand === false || row.highDemand === true)).toBe(true);
      expect(rows[0]).not.toHaveProperty('demandScore');
      expect(rows[0]).not.toHaveProperty('_score');
    });

    it('includes stored high-demand venues even when review volume would hide them', async () => {
      prisma.restaurantVenue.findMany.mockImplementation(({ where }) =>
        Promise.resolve(
          where.highDemand
            ? [
                venue({
                  id: 'flagged',
                  rankingScore: 1,
                  recentReviewCount: 4,
                  demandScore: 5,
                  highDemand: true,
                }),
              ]
            : [
                venue({
                  id: 'volume',
                  rankingScore: 9,
                  recentReviewCount: 0,
                  demandScore: 0,
                  highDemand: false,
                }),
              ],
        ),
      );

      const rows = await ranking.getLikelyToBookOut({ limit: 2 });

      expect(ids(rows)).toContain('flagged');
      expect(rows[0]).not.toHaveProperty('demandScore');
    });

    it('keeps local venues ahead of global ones', async () => {
      prisma.restaurantVenue.findMany.mockImplementation(({ where }) =>
        Promise.resolve(
          where.city
            ? [venue({ id: 'here', city: 'Accra', recentReviewCount: 4, demandScore: 3 })]
            : [venue({ id: 'there', city: 'Kumasi', recentReviewCount: 9, demandScore: 20 })],
        ),
      );

      const rows = await ranking.getLikelyToBookOut({ city: 'Accra', limit: 2 });

      expect(ids(rows)).toEqual(['here', 'there']);
    });
  });

  describe('getSpecialOffers', () => {
    it('returns only venues with a live offer and never backfills', async () => {
      prisma.restaurantVenue.findMany.mockImplementation(({ where }) =>
        Promise.resolve(
          where.offers
            ? [venue({ id: 'with-offer', offers: [offer()] })]
            : [
                venue({ id: 'with-offer', offers: [offer()] }),
                venue({ id: 'no-offer', offers: [] }),
              ],
        ),
      );

      const rows = await ranking.getSpecialOffers({ limit: 8 });

      expect(ids(rows)).toEqual(['with-offer']);
      expect(rows[0].offers).toEqual([
        expect.objectContaining({ id: 'o1', title: '10% off', discountValue: 10 }),
      ]);
      expect(prisma.restaurantVenue.findMany.mock.calls[0][0].where.offers.some.brand).toBe('ghana');
    });

    it('drops an offer whose window has closed even if a cached row carries it', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        venue({ id: 'expired', offers: [offer({ endsAt: new Date('2026-11-01T00:00:00.000Z') })] }),
      ]);

      expect(await ranking.getSpecialOffers({ limit: 8 })).toEqual([]);
    });

    it('caches offers with a validity guard and boundary-aware TTL', async () => {
      await ranking.getSpecialOffers({ city: 'Accra', limit: 4 });

      const [key, , ttl, options] = cache.getOrSet.mock.calls[0];
      expect(key).toMatch(/^rv:home:offers:ghana:4:accra:/);
      expect(ttl).toBe(300);
      expect(options.isValid).toEqual(expect.any(Function));
      expect(options.isValid({ offerValidUntil: now.getTime() + 60000 })).toBe(true);
      expect(options.isValid({ offerValidUntil: now.getTime() - 1 })).toBe(false);
    });

    it('prefers the newer offer when venue quality is equal', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        venue({ id: 'old', offers: [offer({ id: 'o-old', createdAt: new Date('2026-09-01') })] }),
        venue({ id: 'new', offers: [offer({ id: 'o-new', createdAt: new Date('2026-11-24') })] }),
      ]);

      expect(ids(await ranking.getSpecialOffers({ limit: 2 }))).toEqual(['new', 'old']);
    });
  });

  describe('getSectionVenueIds', () => {
    it('returns the matching rail ids in display order', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        venue({ id: 'third', rankingScore: 2, recentReviewCount: 8, demandScore: 3 }),
        venue({ id: 'first', rankingScore: 5, recentReviewCount: 8, demandScore: 9 }),
        venue({ id: 'second', rankingScore: 4, recentReviewCount: 7, demandScore: 6 }),
      ]);

      const idsFromRail = ids(await ranking.getLikelyToBookOut({ limit: 3 }));
      const sectionIds = await ranking.getSectionVenueIds({ section: 'likely-to-book-out', limit: 3 });

      expect(sectionIds).toEqual(idsFromRail);
      expect(sectionIds).toEqual(['first', 'second', 'third']);
    });

    it('returns an empty list for an unknown section', async () => {
      expect(await ranking.getSectionVenueIds({ section: 'mood' })).toEqual([]);
      expect(prisma.restaurantVenue.findMany).not.toHaveBeenCalled();
    });
  });
});
