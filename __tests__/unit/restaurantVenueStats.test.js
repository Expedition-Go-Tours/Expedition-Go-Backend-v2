jest.mock('../../src/core/services/prismaClient', () => ({
  restaurantVenue: { findMany: jest.fn(), update: jest.fn(), groupBy: jest.fn() },
  restaurantVenueExternalStat: { findMany: jest.fn() },
  restaurantVenueReview: { groupBy: jest.fn() },
}));

const prisma = require('../../src/core/services/prismaClient');
const {
  combineExternalStats,
  primaryExternal,
  blendedOwnRating,
  combineVenueStats,
  bayesianRating,
  recomputeVenueStats,
  recomputeRecentStats,
  recomputeCityRanks,
  recomputeAllCityRanks,
} = require('../../src/core/services/restaurantVenueStats');

describe('restaurantVenueStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.restaurantVenue.update.mockResolvedValue({});
    prisma.restaurantVenueReview.groupBy.mockResolvedValue([]);
    prisma.restaurantVenue.groupBy.mockResolvedValue([]);
  });

  describe('combineExternalStats', () => {
    it('weights each counted source by its review count', () => {
      const result = combineExternalStats([
        { source: 'GOOGLE', rating: 4.5, reviewCount: 100 },
        { source: 'TRIPADVISOR', rating: 4.0, reviewCount: 100 },
      ]);

      expect(result).toEqual({ rating: 4.25, reviewCount: 200 });
    });

    it('counts Google, unlike the tour policy which treats it as display-only', () => {
      const result = combineExternalStats([
        { source: 'GOOGLE', rating: 4.8, reviewCount: 50 },
      ]);

      expect(result).toEqual({ rating: 4.8, reviewCount: 50 });
    });

    it('ignores uncounted sources', () => {
      const result = combineExternalStats([
        { source: 'YELP', rating: 5, reviewCount: 900 },
        { source: 'GOOGLE', rating: 4, reviewCount: 10 },
      ]);

      expect(result).toEqual({ rating: 4, reviewCount: 10 });
    });

    it('ignores rows with no usable rating or count', () => {
      expect(
        combineExternalStats([
          { source: 'GOOGLE', rating: 0, reviewCount: 10 },
          { source: 'GOOGLE', rating: 4.5, reviewCount: 0 },
        ]),
      ).toEqual({ rating: 0, reviewCount: 0 });
    });
  });

  describe('primaryExternal', () => {
    it('picks the source with the largest review total, for the card label', () => {
      const result = primaryExternal([
        { source: 'GOOGLE', rating: 4.6, reviewCount: 1204 },
        { source: 'TRIPADVISOR', rating: 4.9, reviewCount: 88 },
      ]);

      expect(result).toEqual({ source: 'GOOGLE', rating: 4.6, reviewCount: 1204 });
    });

    it('breaks ties deterministically by source name', () => {
      const result = primaryExternal([
        { source: 'TRIPADVISOR', rating: 4.9, reviewCount: 100 },
        { source: 'GOOGLE', rating: 4.6, reviewCount: 100 },
      ]);

      expect(result.source).toBe('GOOGLE');
    });

    it('returns null when nothing counts', () => {
      expect(primaryExternal([{ source: 'YELP', rating: 5, reviewCount: 10 }])).toBeNull();
    });
  });

  describe('blendedOwnRating', () => {
    it('leans 70% on the last 12 months', () => {
      // 0.7 * 5 + 0.3 * 3 = 4.4
      expect(
        blendedOwnRating({
          averageRating: 3,
          reviewCount: 100,
          recentRating: 5,
          recentReviewCount: 10,
        }),
      ).toBe(4.4);
    });

    it('falls back to the lifetime mean when there is no recent window', () => {
      expect(
        blendedOwnRating({
          averageRating: 4.1,
          reviewCount: 40,
          recentRating: null,
          recentReviewCount: 0,
        }),
      ).toBe(4.1);
    });

    it('returns zero for a venue with no reviews at all', () => {
      expect(
        blendedOwnRating({
          averageRating: null,
          reviewCount: 0,
          recentRating: null,
          recentReviewCount: 0,
        }),
      ).toBe(0);
    });
  });

  describe('combineVenueStats', () => {
    it('merges the in-app aggregate with the external one', () => {
      const result = combineVenueStats(5, 1, { rating: 4, reviewCount: 3 });

      expect(result).toEqual({ rating: 4.25, reviewCount: 4 });
    });

    it('returns an empty aggregate when nothing counts', () => {
      expect(combineVenueStats(null, 0, { rating: 0, reviewCount: 0 })).toEqual({
        rating: 0,
        reviewCount: 0,
      });
    });
  });

  describe('bayesianRating', () => {
    it('shrinks a single five-star review toward the prior', () => {
      // (20 * 3.9 + 1 * 5) / 21 = 3.9524
      expect(bayesianRating(5, 1)).toBe(3.9524);
    });

    it('lets a large sample dominate the prior', () => {
      const value = bayesianRating(4.6, 400);
      expect(value).toBeGreaterThan(4.5);
      expect(value).toBeLessThan(4.7);
    });

    it('returns null for an unrated venue so it sorts last', () => {
      expect(bayesianRating(0, 0)).toBeNull();
      expect(bayesianRating(null, null)).toBeNull();
    });
  });

  describe('recomputeVenueStats', () => {
    it('writes the external headline and the internal ranking score', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        {
          id: 'v1',
          averageRating: 4.0,
          reviewCount: 10,
          recentRating: 4.0,
          recentReviewCount: 10,
        },
      ]);
      prisma.restaurantVenueExternalStat.findMany.mockResolvedValue([
        { venueId: 'v1', source: 'GOOGLE', rating: 4.8, reviewCount: 90 },
      ]);

      const updated = await recomputeVenueStats(['v1', 'v1', null]);

      expect(updated).toBe(1);
      expect(prisma.restaurantVenue.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['v1'] } },
        select: {
          id: true,
          averageRating: true,
          reviewCount: true,
          recentRating: true,
          recentReviewCount: true,
        },
      });
      expect(prisma.restaurantVenue.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: {
          combinedRating: 4.72,
          combinedReviewCount: 100,
          // The card label names Google, the source with the larger total.
          externalSource: 'GOOGLE',
          externalRating: 4.8,
          externalReviewCount: 90,
          // (20 * 3.9 + 4.72 * 100) / 120 = 4.5833…
          rankingScore: 4.5833,
        },
      });
    });

    it('clears the numeric columns when a venue loses every review', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        {
          id: 'v1',
          averageRating: null,
          reviewCount: 0,
          recentRating: null,
          recentReviewCount: 0,
        },
      ]);
      prisma.restaurantVenueExternalStat.findMany.mockResolvedValue([]);

      await recomputeVenueStats(['v1']);

      expect(prisma.restaurantVenue.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: {
          combinedRating: null,
          combinedReviewCount: 0,
          externalSource: null,
          externalRating: null,
          externalReviewCount: 0,
          rankingScore: null,
        },
      });
    });

    it('does nothing for an empty id list', async () => {
      const updated = await recomputeVenueStats([]);

      expect(updated).toBe(0);
      expect(prisma.restaurantVenue.findMany).not.toHaveBeenCalled();
    });
  });

  describe('recomputeRecentStats', () => {
    it('stores the 12-month average and count per venue', async () => {
      prisma.restaurantVenueReview.groupBy.mockResolvedValue([
        { venueId: 'v1', _avg: { rating: 4.3333 }, _count: { _all: 3 } },
      ]);

      const updated = await recomputeRecentStats(['v1', 'v2']);

      expect(updated).toBe(2);
      expect(prisma.restaurantVenueReview.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['venueId'],
          where: expect.objectContaining({ status: 'APPROVED' }),
          _avg: { rating: true },
          _count: { _all: true },
        }),
      );
      expect(prisma.restaurantVenue.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { recentRating: 4.3333, recentReviewCount: 3 },
      });
      // A venue with no recent rows must be cleared, not left stale.
      expect(prisma.restaurantVenue.update).toHaveBeenCalledWith({
        where: { id: 'v2' },
        data: { recentRating: null, recentReviewCount: 0 },
      });
    });
  });

  describe('recomputeCityRanks', () => {
    it('writes an ordinal position and the city total', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        { id: 'v1', rankingScore: 4.8 },
        { id: 'v2', rankingScore: 4.5 },
        { id: 'v3', rankingScore: null },
      ]);

      const ranked = await recomputeCityRanks('Accra');

      expect(ranked).toBe(3);
      expect(prisma.restaurantVenue.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'v1' },
        data: expect.objectContaining({ rankInCity: 1, cityVenueCount: 3 }),
      });
      expect(prisma.restaurantVenue.update).toHaveBeenNthCalledWith(3, {
        where: { id: 'v3' },
        data: expect.objectContaining({ rankInCity: 3, cityVenueCount: 3 }),
      });
    });

    it('orders by ranking score with unrated venues last', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([]);

      await recomputeCityRanks('Accra');

      expect(prisma.restaurantVenue.findMany).toHaveBeenCalledWith({
        where: { status: 'ACTIVE', city: { equals: 'Accra', mode: 'insensitive' } },
        select: { id: true, rankingScore: true },
        orderBy: [{ rankingScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      });
    });

    it('does nothing without a city', async () => {
      expect(await recomputeCityRanks(null)).toBe(0);
      expect(prisma.restaurantVenue.findMany).not.toHaveBeenCalled();
    });
  });

  describe('recomputeAllCityRanks', () => {
    it('ranks every city that has an active venue', async () => {
      prisma.restaurantVenue.groupBy.mockResolvedValue([
        { city: 'Accra', _count: { _all: 2 } },
        { city: null, _count: { _all: 1 } },
      ]);
      prisma.restaurantVenue.findMany.mockResolvedValue([]);

      const cities = await recomputeAllCityRanks();

      expect(cities).toBe(1);
      expect(prisma.restaurantVenue.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
