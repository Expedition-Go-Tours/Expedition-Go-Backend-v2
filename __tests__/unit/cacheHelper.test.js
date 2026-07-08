jest.mock('../../utils/redisClient');

const redis = require('../../utils/redisClient');
const cache = require('../../utils/cacheHelper');

describe('cacheHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cache._clearMemory();
    redis.connect.mockResolvedValue({});
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue();
    redis.del.mockResolvedValue(1);
    redis.delPattern.mockResolvedValue();
  });

  describe('getOrSet', () => {
    it('returns cached value when found', async () => {
      redis.get.mockResolvedValue({ cached: 'data' });
      const fetchFn = jest.fn();
      const result = await cache.getOrSet('my-key', fetchFn, 300);
      expect(result).toEqual({ cached: 'data' });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('fetches and caches when not found', async () => {
      const fetchFn = jest.fn().mockResolvedValue({ fresh: 'data' });
      const result = await cache.getOrSet('my-key', fetchFn, 300);
      expect(result).toEqual({ fresh: 'data' });
      expect(redis.set).toHaveBeenCalledWith('my-key', { fresh: 'data' }, 300);
    });

    it('re-throws fetch errors', async () => {
      const fetchFn = jest.fn().mockRejectedValue(new Error('Fetch failed'));
      await expect(cache.getOrSet('my-key', fetchFn)).rejects.toThrow('Fetch failed');
    });
  });

  describe('invalidateKeys', () => {
    it('calls delPattern for each pattern', async () => {
      await cache.invalidateKeys(['pattern:*', 'other:*']);
      expect(redis.delPattern).toHaveBeenCalledTimes(2);
      expect(redis.delPattern).toHaveBeenCalledWith('pattern:*');
      expect(redis.delPattern).toHaveBeenCalledWith('other:*');
    });
  });

  describe('invalidateTourCaches', () => {
    it('invalidates list, filters, popular and detail cache when tourId provided', async () => {
      await cache.invalidateTourCaches('t-1');
      expect(redis.delPattern).toHaveBeenCalledWith('tours:list:*');
      expect(redis.delPattern).toHaveBeenCalledWith('tours:filters:options');
      expect(redis.delPattern).toHaveBeenCalledWith('tours:popular:by-category');
      expect(redis.del).toHaveBeenCalledWith('tours:detail:t-1');
    });

    it('skips detail cache invalidation when no tourId', async () => {
      await cache.invalidateTourCaches();
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('invalidateReviewCaches', () => {
    it('invalidates review and list caches with tourId', async () => {
      await cache.invalidateReviewCaches('t-1');
      expect(redis.delPattern).toHaveBeenCalledWith('reviews:tour:t-1:*');
    });

    it('still invalidates list/filters even without tourId', async () => {
      await cache.invalidateReviewCaches();
      expect(redis.delPattern).toHaveBeenCalledWith('tours:list:*');
    });
  });
});
