jest.mock('../../utils/redisClient');
jest.mock('../../utils/homepageRanking');
jest.mock('../../utils/homepagePrecompute', () => ({
  SECTION_KEYS: {
    sellOut: 'hp:sections:sell-out',
    topRated: 'hp:sections:top-rated',
    trending: 'hp:sections:trending',
    recommended: 'hp:sections:recommended',
    new: 'hp:sections:new',
    attractions: 'hp:sections:attractions',
    mood: 'hp:sections:mood',
    destinations: 'hp:sections:destinations',
  },
  SECTION_TTLS: {
    sellOut: 300, topRated: 300, trending: 300, recommended: 300,
    new: 600, attractions: 600, mood: 300, destinations: 3600,
  },
}));
jest.mock('../../utils/queue', () => ({
  enqueueHomepagePrecompute: jest.fn().mockResolvedValue(),
}));

const request = require('supertest');
const app = require('../../app');
const redis = require('../../utils/redisClient');
const ranking = require('../../utils/homepageRanking');
const { enqueueHomepagePrecompute } = require('../../utils/queue');

describe('Homepage API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.isRedisAvailable.mockResolvedValue(true);

    ranking.getLikelySellOut.mockResolvedValue([{ id: 'sellout-1', title: 'Sell Out Tour' }]);
    ranking.getTopRated.mockResolvedValue([{ id: 'rated-1', title: 'Top Rated Tour' }]);
    ranking.getTrending.mockResolvedValue([{ id: 'trending-1', title: 'Trending Tour' }]);
    ranking.getRecommended.mockResolvedValue([{ id: 'rec-1', title: 'Recommended Tour' }]);
    ranking.getNewExperiences.mockResolvedValue([{ id: 'new-1', title: 'New Tour' }]);
    ranking.getAttractions.mockResolvedValue([{ name: 'Cape Coast Castle', tourCount: 5, heroImage: null, avgRating: 4.7, totalBookings: 100, startingPrice: 45, lat: 5.1, lng: -1.2 }]);
    ranking.getMoodKeywords.mockResolvedValue([{ keyword: 'hiking', image: null, tourCount: 5 }]);
    ranking.getPopularDestinations.mockResolvedValue([{ city: 'Nairobi', country: 'Kenya', tourCount: 10, totalBookings: 100, avgRating: 4.5, heroImage: null }]);
  });

  describe('GET /api/homepage (unified)', () => {
    it('returns all sections from pre-computed cache', async () => {
      redis.get
        .mockResolvedValueOnce([{ id: 'sellout-1' }])  // sellOut
        .mockResolvedValueOnce([{ id: 'rated-1' }])     // topRated
        .mockResolvedValueOnce([{ id: 'trending-1' }])  // trending
        .mockResolvedValueOnce([{ id: 'rec-1' }])       // recommended
        .mockResolvedValueOnce([{ id: 'new-1' }])       // new
        .mockResolvedValueOnce([{ id: 'attr-1' }])      // attractions
        .mockResolvedValueOnce([{ keyword: 'hiking' }]) // mood
        .mockResolvedValueOnce([{ city: 'Nairobi' }])   // destinations
        .mockResolvedValueOnce([{ offerId: 'off-1' }]); // offers

      const res = await request(app).get('/api/homepage');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.sellOut).toEqual([{ id: 'sellout-1' }]);
      expect(res.body.data.topRated).toEqual([{ id: 'rated-1' }]);
      expect(res.body.data.destinations).toEqual([{ city: 'Nairobi' }]);
    });

    it('falls back to live computation when cache is empty', async () => {
      // Mock offers cache miss — computeOffersData needs prisma which isn't mocked,
      // so pre-seed the offers cache to avoid a real DB call
      redis.get
        .mockResolvedValueOnce(null)  // sellOut
        .mockResolvedValueOnce(null)  // topRated
        .mockResolvedValueOnce(null)  // trending
        .mockResolvedValueOnce(null)  // recommended
        .mockResolvedValueOnce(null)  // new
        .mockResolvedValueOnce(null)  // attractions
        .mockResolvedValueOnce(null)  // mood
        .mockResolvedValueOnce(null)  // destinations
        .mockResolvedValueOnce([{ offerId: 'off-1', title: 'Offer Tour' }]); // offers

      const res = await request(app).get('/api/homepage');
      expect(res.status).toBe(200);
      expect(res.body.data.sellOut).toEqual([{ id: 'sellout-1', title: 'Sell Out Tour' }]);
      expect(enqueueHomepagePrecompute).toHaveBeenCalled();
    });

    it('computes recommended live when lat/lng provided', async () => {
      redis.get.mockResolvedValue([{ id: 'cached' }]);
      ranking.getRecommended.mockResolvedValue([{ id: 'personalized' }]);

      const res = await request(app).get('/api/homepage?lat=1.2&lng=36.8');

      expect(res.status).toBe(200);
      // recommended should come from live computation
      expect(ranking.getRecommended).toHaveBeenCalled();
    });
  });

  describe('GET /api/homepage/sell-out', () => {
    it('returns pre-computed data from Redis', async () => {
      redis.get.mockResolvedValueOnce([{ id: 'cached-tour' }]);

      const res = await request(app).get('/api/homepage/sell-out');
      expect(res.status).toBe(200);
      expect(res.body.data.tours).toEqual([{ id: 'cached-tour' }]);
    });

    it('falls back to live computation on cache miss', async () => {
      const res = await request(app).get('/api/homepage/sell-out');
      expect(res.status).toBe(200);
      expect(res.body.data.tours).toEqual([{ id: 'sellout-1', title: 'Sell Out Tour' }]);
      expect(ranking.getLikelySellOut).toHaveBeenCalled();
    });

    it('respects limit parameter', async () => {
      const res = await request(app).get('/api/homepage/sell-out?limit=5');
      expect(res.status).toBe(200);
      expect(ranking.getLikelySellOut).toHaveBeenCalledWith(5, null, false, true);
    });

    it('caps limit at 20', async () => {
      const res = await request(app).get('/api/homepage/sell-out?limit=50');
      expect(res.status).toBe(200);
      expect(ranking.getLikelySellOut).toHaveBeenCalledWith(20, null, false, true);
    });
  });

  describe('GET /api/homepage/top-rated', () => {
    it('returns pre-computed data', async () => {
      redis.get.mockResolvedValueOnce([{ id: 'cached' }]);
      const res = await request(app).get('/api/homepage/top-rated');
      expect(res.status).toBe(200);
      expect(res.body.data.tours).toEqual([{ id: 'cached' }]);
    });
  });

  describe('GET /api/homepage/trending', () => {
    it('returns pre-computed data', async () => {
      redis.get.mockResolvedValueOnce([{ id: 'cached' }]);
      const res = await request(app).get('/api/homepage/trending');
      expect(res.status).toBe(200);
      expect(res.body.data.tours).toEqual([{ id: 'cached' }]);
    });
  });

  describe('GET /api/homepage/recommended', () => {
    it('returns pre-computed data for anonymous users', async () => {
      redis.get.mockResolvedValueOnce([{ id: 'cached' }]);
      const res = await request(app).get('/api/homepage/recommended');
      expect(res.status).toBe(200);
      expect(res.body.data.tours).toEqual([{ id: 'cached' }]);
    });

    it('computes live when lat/lng provided', async () => {
      const res = await request(app).get('/api/homepage/recommended?lat=1.2&lng=36.8');
      expect(res.status).toBe(200);
      expect(ranking.getRecommended).toHaveBeenCalledWith(null, 1.2, 36.8, 12, false, true);
    });
  });

  describe('GET /api/homepage/new', () => {
    it('returns pre-computed data', async () => {
      redis.get.mockResolvedValueOnce([{ id: 'cached' }]);
      const res = await request(app).get('/api/homepage/new');
      expect(res.status).toBe(200);
      expect(res.body.data.tours).toEqual([{ id: 'cached' }]);
    });
  });

  describe('GET /api/homepage/attractions', () => {
    it('returns pre-computed data when available', async () => {
      redis.get.mockResolvedValueOnce([{ name: 'Cached Attraction' }]);
      const res = await request(app).get('/api/homepage/attractions');
      expect(res.status).toBe(200);
      expect(res.body.data.attractions).toEqual([{ name: 'Cached Attraction' }]);
    });

    it('falls back to live computation on cache miss', async () => {
      const res = await request(app).get('/api/homepage/attractions');
      expect(res.status).toBe(200);
      expect(ranking.getAttractions).toHaveBeenCalled();
    });
  });

  describe('GET /api/homepage/attractions/tours', () => {
    it('returns 400 when name is missing', async () => {
      const res = await request(app).get('/api/homepage/attractions/tours');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/homepage/mood', () => {
    it('returns pre-computed data for anonymous users', async () => {
      redis.get.mockResolvedValueOnce([{ keyword: 'cached' }]);
      const res = await request(app).get('/api/homepage/mood');
      expect(res.status).toBe(200);
      expect(res.body.data.keywords).toEqual([{ keyword: 'cached' }]);
    });

    it('falls back to live computation on cache miss', async () => {
      const res = await request(app).get('/api/homepage/mood');
      expect(res.status).toBe(200);
      expect(ranking.getMoodKeywords).toHaveBeenCalled();
    });
  });

  describe('GET /api/homepage/destinations', () => {
    it('returns pre-computed data', async () => {
      redis.get.mockResolvedValueOnce([{ city: 'cached' }]);
      const res = await request(app).get('/api/homepage/destinations');
      expect(res.status).toBe(200);
      expect(res.body.data.destinations).toEqual([{ city: 'cached' }]);
    });
  });
});
