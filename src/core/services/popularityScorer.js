const POPULARITY_WEIGHTS = {
  bookings: 0.40,
  rating: 0.25,
  reviews: 0.20,
  views: 0.15,
};

const DEFAULT_PER_CATEGORY = 6;

function computePopularScore(tours) {
  if (!tours || tours.length === 0) return [];

  const maxBookings = Math.max(...tours.map(t => t.totalBookings || 0));
  const maxRating = Math.max(...tours.map(t => t.averageRating || 0));
  const maxReviews = Math.max(...tours.map(t => t.reviewCount || 0));
  const maxViews = Math.max(...tours.map(t => t.viewCount || 0));

  return tours.map(tour => {
    const nBookings = maxBookings > 0 ? (tour.totalBookings || 0) / maxBookings : 0;
    const nRating = maxRating > 0 ? (tour.averageRating || 0) / maxRating : 0;
    const nReviews = maxReviews > 0 ? (tour.reviewCount || 0) / maxReviews : 0;
    const nViews = maxViews > 0 ? (tour.viewCount || 0) / maxViews : 0;

    const score = (
      POPULARITY_WEIGHTS.bookings * nBookings +
      POPULARITY_WEIGHTS.rating * nRating +
      POPULARITY_WEIGHTS.reviews * nReviews +
      POPULARITY_WEIGHTS.views * nViews
    );

    return { ...tour, popularityScore: Math.round(score * 10000) / 10000 };
  });
}

function groupByCategory(tours) {
  const grouped = {};
  for (const tour of tours) {
    const category = tour.category || 'Uncategorized';
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(tour);
  }
  return grouped;
}

function getPopularByCategory(tours, perCategory = DEFAULT_PER_CATEGORY) {
  const grouped = groupByCategory(tours);
  const result = {};

  for (const [category, categoryTours] of Object.entries(grouped)) {
    const scored = computePopularScore(categoryTours);
    scored.sort((a, b) => b.popularityScore - a.popularityScore);
    result[category] = scored.slice(0, perCategory);
  }

  return result;
}

module.exports = {
  computePopularScore,
  groupByCategory,
  getPopularByCategory,
  POPULARITY_WEIGHTS,
  DEFAULT_PER_CATEGORY,
};
