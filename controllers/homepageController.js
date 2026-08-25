/**
 * Homepage Controller
 *
 * Serves pre-computed, algorithmically ranked data for each homepage section.
 * Each endpoint returns a flat array of tour cards (or keyword objects)
 * ready for the frontend to render directly.
 *
 * @version 1.0.0
 */

const catchAsync = require('../utils/catchAsync');
const ranking = require('../utils/homepageRanking');

/**
 * GET /api/homepage/sell-out
 * Tours with booking momentum in the last 14 days.
 */
exports.getSellOut = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await ranking.getLikelySellOut(limit);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/top-rated
 * Tours with highest Bayesian-smoothed quality scores.
 */
exports.getTopRated = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await ranking.getTopRated(limit);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/trending
 * Tours with accelerating view/booking/wishlist velocity.
 */
exports.getTrending = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await ranking.getTrending(limit);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/recommended
 * Personalized recommendations based on user behavior + tour quality.
 * Accepts optional lat/lng for proximity boost.
 */
exports.getRecommended = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const userId = req.user?.id || null;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;
  const tours = await ranking.getRecommended(userId, lat, lng, limit);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/new
 * Tours created in the last 30 days.
 */
exports.getNew = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const tours = await ranking.getNewExperiences(limit);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/attractions
 * Nearby tours sorted by affordability + quality.
 * Accepts lat/lng for proximity, keywords for filtering.
 */
exports.getAttractions = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;
  const keywords = req.query.keywords ? req.query.keywords.split(',').map(k => k.trim()) : [];
  const tours = await ranking.getTopAttractions(lat, lng, keywords, limit);
  res.json({ status: 'success', data: { tours } });
});

/**
 * GET /api/homepage/mood
 * Dynamic keywords for "What do you want to do?" section.
 * Returns keywords with representative tour images.
 */
exports.getMood = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 8, 12);
  const userId = req.user?.id || null;
  const keywords = await ranking.getMoodKeywords(userId, limit);
  res.json({ status: 'success', data: { keywords } });
});

/**
 * GET /api/homepage/destinations
 * Popular cities with aggregated tour/booking stats.
 */
exports.getDestinations = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 15);
  const destinations = await ranking.getPopularDestinations(limit);
  res.json({ status: 'success', data: { destinations } });
});

/**
 * GET /api/homepage
 * Unified endpoint — returns all sections in a single response.
 * Reduces homepage HTTP requests from 7+ to 1.
 */
exports.getHomepage = catchAsync(async (req, res) => {
  const userId = req.user?.id || null;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;

  const [sellOut, topRated, trending, recommended, newExperiences, attractions, mood, destinations] =
    await Promise.all([
      ranking.getLikelySellOut(12),
      ranking.getTopRated(12),
      ranking.getTrending(12),
      ranking.getRecommended(userId, lat, lng, 12),
      ranking.getNewExperiences(10),
      ranking.getTopAttractions(lat, lng, [], 10),
      ranking.getMoodKeywords(userId, 8),
      ranking.getPopularDestinations(10),
    ]);

  res.json({
    status: 'success',
    data: {
      sellOut,
      topRated,
      trending,
      recommended,
      newExperiences,
      attractions,
      mood,
      destinations,
    },
  });
});
