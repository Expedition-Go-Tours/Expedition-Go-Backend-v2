jest.mock('../../src/core/services/prismaClient', () => ({
  tour: { findMany: jest.fn(), update: jest.fn() },
  tourExternalReviewStat: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn((ops) => Promise.all(ops)),
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  invalidateHomepageCaches: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');
const {
  syncExternalReviewStats,
  recomputeCombinedStatsForTours,
} = require('../../src/core/services/externalReviewStats');

const CAPE_TOUR = { id: 't1', title: 'Cape Coast Castle, Elmina Castle & Kakum National Park Day Tour', city: 'Accra', country: 'Ghana', region: null };

describe('externalReviewStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tourExternalReviewStat.upsert.mockResolvedValue({});
    prisma.tourExternalReviewStat.deleteMany.mockResolvedValue({ count: 0 });
    prisma.tour.update.mockResolvedValue({});
  });

  describe('syncExternalReviewStats', () => {
    it('matches products, stores totals and recomputes the combined value', async () => {
      prisma.tour.findMany
        .mockResolvedValueOnce([CAPE_TOUR])
        .mockResolvedValueOnce([{ id: 't1', averageRating: 4.0, reviewCount: 10 }]);
      prisma.tourExternalReviewStat.findMany.mockResolvedValue([
        { tourId: 't1', source: 'TRIPADVISOR', rating: 4.9, reviewCount: 595, distribution: null },
      ]);

      const summary = await syncExternalReviewStats({
        products: [
          { id: 'p1', source: 'TRIPADVISOR', tourTitle: CAPE_TOUR.title, rating: 4.9, reviewCount: 595 },
        ],
      });

      expect(summary.matched).toBe(1);
      expect(summary.tours).toBe(1);
      expect(prisma.tourExternalReviewStat.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tourId_source: { tourId: 't1', source: 'TRIPADVISOR' } },
          create: expect.objectContaining({ tourId: 't1', source: 'TRIPADVISOR', rating: 4.9, reviewCount: 595 }),
        })
      );
      // internal 4.0 (10) + external 4.9 (595) => 605 reviews @ 4.9
      expect(prisma.tour.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { combinedRating: 4.9, combinedReviewCount: 605 },
      });
      expect(cache.invalidateHomepageCaches).toHaveBeenCalled();
      // Expedition detail/list payloads now embed the combined stats too.
      expect(cache.invalidateKeys).toHaveBeenCalledWith(['expedition:*']);
    });

    it('reports products it cannot match', async () => {
      prisma.tour.findMany.mockResolvedValueOnce([]);

      const summary = await syncExternalReviewStats({
        products: [{ source: 'TRIPADVISOR', tourTitle: 'Nonexistent Tour', rating: 4, reviewCount: 10 }],
      });

      expect(summary.matched).toBe(0);
      expect(summary.unmatched).toHaveLength(1);
      expect(prisma.tourExternalReviewStat.upsert).not.toHaveBeenCalled();
    });

    it('ignores sources that do not count (Google)', async () => {
      prisma.tour.findMany.mockResolvedValueOnce([]);

      const summary = await syncExternalReviewStats({
        products: [{ source: 'GOOGLE', tourTitle: 'Anything', rating: 5, reviewCount: 1000 }],
      });

      expect(summary.matched).toBe(0);
      expect(summary.unmatched).toHaveLength(0);
      expect(prisma.tourExternalReviewStat.upsert).not.toHaveBeenCalled();
    });

    it('keeps the larger total when two products map to the same tour+source', async () => {
      prisma.tour.findMany
        .mockResolvedValueOnce([CAPE_TOUR])
        .mockResolvedValueOnce([{ id: 't1', averageRating: null, reviewCount: 0 }]);
      prisma.tourExternalReviewStat.findMany.mockResolvedValue([]);

      await syncExternalReviewStats({
        products: [
          { id: 'small', source: 'TRIPADVISOR', tourTitle: CAPE_TOUR.title, rating: 4.5, reviewCount: 50 },
          { id: 'large', source: 'TRIPADVISOR', tourTitle: CAPE_TOUR.title, rating: 4.8, reviewCount: 500 },
        ],
      });

      expect(prisma.tourExternalReviewStat.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.tourExternalReviewStat.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ reviewCount: 500, productId: 'large' }) })
      );
    });

    it('writes nothing in dry-run mode', async () => {
      prisma.tour.findMany.mockResolvedValueOnce([CAPE_TOUR]);

      const summary = await syncExternalReviewStats({
        dryRun: true,
        products: [{ source: 'TRIPADVISOR', tourTitle: CAPE_TOUR.title, rating: 4.9, reviewCount: 595 }],
      });

      expect(summary.dryRun).toBe(true);
      expect(summary.matched).toBe(1);
      expect(prisma.tourExternalReviewStat.upsert).not.toHaveBeenCalled();
      expect(prisma.tour.update).not.toHaveBeenCalled();
      expect(cache.invalidateHomepageCaches).not.toHaveBeenCalled();
    });
  });

  describe('recomputeCombinedStatsForTours', () => {
    it('is a no-op for an empty id list', async () => {
      const updated = await recomputeCombinedStatsForTours([]);
      expect(updated).toBe(0);
      expect(prisma.tour.update).not.toHaveBeenCalled();
    });

    it('writes combined = internal when there is no external data', async () => {
      prisma.tour.findMany.mockResolvedValueOnce([{ id: 't1', averageRating: 4.2, reviewCount: 12 }]);
      prisma.tourExternalReviewStat.findMany.mockResolvedValue([]);

      const updated = await recomputeCombinedStatsForTours(['t1']);

      expect(updated).toBe(1);
      expect(prisma.tour.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { combinedRating: 4.2, combinedReviewCount: 12 },
      });
    });
  });
});
