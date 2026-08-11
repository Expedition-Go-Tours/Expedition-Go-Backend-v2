jest.mock('../../utils/prismaClient', () => ({
  $queryRawUnsafe: jest.fn(),
}));

const prisma = require('../../utils/prismaClient');
const fts = require('../../utils/fullTextSearch');

describe('fullTextSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('rankTourIdsBySearch', () => {
    it('returns original ids when no search term', async () => {
      const ids = ['t-1', 't-2'];
      const result = await fts.rankTourIdsBySearch('', ids);
      expect(result).toEqual(ids);
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('returns original ids when tourIds empty', async () => {
      const result = await fts.rankTourIdsBySearch('safari', []);
      expect(result).toEqual([]);
    });

    it('returns ranked ids from query', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([{ id: 't-2' }, { id: 't-1' }]);
      const result = await fts.rankTourIdsBySearch('safari', ['t-1', 't-2']);
      expect(result).toEqual(['t-2', 't-1']);
    });

    it('returns original ids on query error', async () => {
      prisma.$queryRawUnsafe.mockRejectedValue(new Error('DB error'));
      const result = await fts.rankTourIdsBySearch('safari', ['t-1', 't-2']);
      expect(result).toEqual(['t-1', 't-2']);
    });
  });

  describe('searchToursByRelevance', () => {
    it('returns paginated ranked ids with total count', async () => {
      // New implementation uses a single CTE query via $queryRawUnsafe
      prisma.$queryRawUnsafe.mockResolvedValue([
        { id: 't-3', total: 3 },
        { id: 't-1', total: 3 },
      ]);

      const result = await fts.searchToursByRelevance('safari', { status: 'PUBLISHED' }, 0, 2);

      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(result.ids).toEqual(['t-3', 't-1']);
      expect(result.totalCount).toBe(3);
    });

    it('returns empty when no tours match', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);
      const result = await fts.searchToursByRelevance('safari', {}, 0, 10);
      expect(result).toEqual({ ids: [], totalCount: 0 });
    });

    it('returns empty on query error', async () => {
      prisma.$queryRawUnsafe.mockRejectedValue(new Error('DB error'));
      const result = await fts.searchToursByRelevance('safari', {}, 0, 10);
      expect(result).toEqual({ ids: [], totalCount: 0 });
    });

    it('returns empty when no search term', async () => {
      const result = await fts.searchToursByRelevance('', {}, 0, 10);
      expect(result).toEqual({ ids: [], totalCount: 0 });
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });
});
