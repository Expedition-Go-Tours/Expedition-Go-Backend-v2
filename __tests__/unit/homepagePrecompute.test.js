jest.mock('../../utils/redisClient');
jest.mock('../../utils/homepageRanking');
jest.mock('../../utils/cacheHelper', () => {
  const actual = jest.requireActual('../../utils/cacheHelper');
  return {
    ...actual,
    invalidateKeys: jest.fn().mockResolvedValue(),
    memSet: jest.fn(),
    _clearMemory: jest.fn(),
  };
});
jest.mock('../../utils/queue', () => ({
  enqueueHomepagePrecompute: jest.fn().mockResolvedValue(),
}));

const redis = require('../../utils/redisClient');
const cache = require('../../utils/cacheHelper');
const ranking = require('../../utils/homepageRanking');
const {
  precomputeHomepageSections,
  SECTION_KEYS,
  SECTION_TTLS,
} = require('../../utils/homepagePrecompute');

describe('homepagePrecompute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue();
    redis.isRedisAvailable.mockResolvedValue(true);

    ranking.getLikelySellOut.mockResolvedValue([{ id: 'sellout-1' }]);
    ranking.getTopRated.mockResolvedValue([{ id: 'rated-1' }]);
    ranking.getTrending.mockResolvedValue([{ id: 'trending-1' }]);
    ranking.getRecommended.mockResolvedValue([{ id: 'rec-1' }]);
    ranking.getNewExperiences.mockResolvedValue([{ id: 'new-1' }]);
    ranking.getAttractions.mockResolvedValue([{ name: 'Cape Coast Castle' }]);
    ranking.getMoodKeywords.mockResolvedValue([{ keyword: 'hiking' }]);
    ranking.getPopularDestinations.mockResolvedValue([{ city: 'Nairobi' }]);
  });

  describe('precomputeHomepageSections', () => {
    it('runs all 8 ranking functions in parallel', async () => {
      await precomputeHomepageSections();

      expect(ranking.getLikelySellOut).toHaveBeenCalledWith(12);
      expect(ranking.getTopRated).toHaveBeenCalledWith(12);
      expect(ranking.getTrending).toHaveBeenCalledWith(12);
      expect(ranking.getRecommended).toHaveBeenCalledWith(null, null, null, 12);
      expect(ranking.getNewExperiences).toHaveBeenCalledWith(10);
      expect(ranking.getAttractions).toHaveBeenCalledWith(10);
      expect(ranking.getMoodKeywords).toHaveBeenCalledWith(null, 8);
      expect(ranking.getPopularDestinations).toHaveBeenCalledWith(10);
    });

    it('writes all 8 keys to Redis with correct TTLs', async () => {
      const result = await precomputeHomepageSections();

      expect(result.success).toBe(true);
      expect(result.sections).toBe(8);
      expect(redis.set).toHaveBeenCalledTimes(8);

      expect(redis.set).toHaveBeenCalledWith(SECTION_KEYS.sellOut, [{ id: 'sellout-1' }], SECTION_TTLS.sellOut);
      expect(redis.set).toHaveBeenCalledWith(SECTION_KEYS.topRated, [{ id: 'rated-1' }], SECTION_TTLS.topRated);
      expect(redis.set).toHaveBeenCalledWith(SECTION_KEYS.mood, [{ keyword: 'hiking' }], SECTION_TTLS.mood);
      expect(redis.set).toHaveBeenCalledWith(SECTION_KEYS.destinations, [{ city: 'Nairobi' }], SECTION_TTLS.destinations);
    });

    it('warms L1 memory cache after writing to Redis', async () => {
      await precomputeHomepageSections();

      expect(cache.memSet).toHaveBeenCalledTimes(8);
      expect(cache.memSet).toHaveBeenCalledWith(SECTION_KEYS.sellOut, [{ id: 'sellout-1' }]);
    });

    it('returns success with duration and section count', async () => {
      const result = await precomputeHomepageSections();

      expect(result.success).toBe(true);
      expect(typeof result.duration).toBe('number');
      expect(result.sections).toBe(8);
    });

    it('does NOT write any keys when a ranking function throws', async () => {
      ranking.getLikelySellOut.mockRejectedValue(new Error('DB timeout'));

      const result = await precomputeHomepageSections();

      expect(result.success).toBe(false);
      expect(result.sections).toBe(0);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('skips Redis writes when Redis is unavailable', async () => {
      redis.isRedisAvailable.mockResolvedValue(false);

      const result = await precomputeHomepageSections();

      expect(result.success).toBe(true);
      expect(result.sections).toBe(0);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('handles partial Redis write failures gracefully', async () => {
      redis.set
        .mockResolvedValueOnce()   // sellOut: OK
        .mockRejectedValueOnce(new Error('write fail'))  // topRated: fail
        .mockResolvedValueOnce()   // trending: OK
        .mockResolvedValueOnce()   // recommended: OK
        .mockResolvedValueOnce()   // new: OK
        .mockResolvedValueOnce()   // attractions: OK
        .mockResolvedValueOnce()   // mood: OK
        .mockResolvedValueOnce();  // destinations: OK

      const result = await precomputeHomepageSections();

      expect(result.success).toBe(true);
      // 7 out of 8 succeeded (topRated failed)
      expect(result.sections).toBe(7);
    });
  });

  describe('SECTION_KEYS', () => {
    it('has keys for all 8 sections', () => {
      expect(Object.keys(SECTION_KEYS)).toHaveLength(8);
      expect(SECTION_KEYS.sellOut).toBe('hp:sections:sell-out');
      expect(SECTION_KEYS.topRated).toBe('hp:sections:top-rated');
      expect(SECTION_KEYS.trending).toBe('hp:sections:trending');
      expect(SECTION_KEYS.recommended).toBe('hp:sections:recommended');
      expect(SECTION_KEYS.new).toBe('hp:sections:new');
      expect(SECTION_KEYS.attractions).toBe('hp:sections:attractions');
      expect(SECTION_KEYS.mood).toBe('hp:sections:mood');
      expect(SECTION_KEYS.destinations).toBe('hp:sections:destinations');
    });
  });

  describe('SECTION_TTLS', () => {
    it('has TTLs for all 8 sections', () => {
      expect(Object.keys(SECTION_TTLS)).toHaveLength(8);
      expect(SECTION_TTLS.sellOut).toBe(300);
      expect(SECTION_TTLS.new).toBe(600);
      expect(SECTION_TTLS.destinations).toBe(3600);
    });
  });
});
