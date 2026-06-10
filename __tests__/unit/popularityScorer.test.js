const scorer = require('../../utils/popularityScorer');

describe('popularityScorer', () => {
  describe('computePopularScore', () => {
    it('returns empty array for empty input', () => {
      expect(scorer.computePopularScore([])).toEqual([]);
    });

    it('returns empty array for null input', () => {
      expect(scorer.computePopularScore(null)).toEqual([]);
    });

    it('computes scores for tours with all metrics', () => {
      const tours = [
        { id: 't-1', totalBookings: 100, averageRating: 4.5, reviewCount: 20, viewCount: 500 },
        { id: 't-2', totalBookings: 50, averageRating: 3.0, reviewCount: 10, viewCount: 200 },
      ];
      const result = scorer.computePopularScore(tours);
      expect(result).toHaveLength(2);
      expect(result[0].popularityScore).toBeGreaterThan(result[1].popularityScore);
      expect(typeof result[0].popularityScore).toBe('number');
    });

    it('handles tours with all zeros', () => {
      const tours = [
        { id: 't-1', totalBookings: 0, averageRating: 0, reviewCount: 0, viewCount: 0 },
      ];
      const result = scorer.computePopularScore(tours);
      expect(result[0].popularityScore).toBe(0);
    });

    it('handles missing fields as 0', () => {
      const tours = [{ id: 't-1' }];
      const result = scorer.computePopularScore(tours);
      expect(result[0].popularityScore).toBe(0);
    });
  });

  describe('groupByCategory', () => {
    it('groups tours by category', () => {
      const tours = [
        { id: 't-1', category: 'Safari' },
        { id: 't-2', category: 'Beach' },
        { id: 't-3', category: 'Safari' },
      ];
      const result = scorer.groupByCategory(tours);
      expect(result.Safari).toHaveLength(2);
      expect(result.Beach).toHaveLength(1);
    });

    it('uses Uncategorized for tours without category', () => {
      const tours = [{ id: 't-1' }];
      const result = scorer.groupByCategory(tours);
      expect(result.Uncategorized).toHaveLength(1);
    });
  });

  describe('getPopularByCategory', () => {
    it('returns top tours per category sorted by score', () => {
      const tours = [
        { id: 't-1', category: 'Safari', totalBookings: 100, averageRating: 5, reviewCount: 30, viewCount: 1000 },
        { id: 't-2', category: 'Safari', totalBookings: 10, averageRating: 3, reviewCount: 5, viewCount: 100 },
        { id: 't-3', category: 'Beach', totalBookings: 50, averageRating: 4, reviewCount: 15, viewCount: 500 },
      ];
      const result = scorer.getPopularByCategory(tours);
      expect(result.Safari).toHaveLength(2);
      expect(result.Beach).toHaveLength(1);
      expect(result.Safari[0].id).toBe('t-1');
    });

    it('respects perCategory limit', () => {
      const tours = [
        { id: 't-1', category: 'Safari', totalBookings: 10, averageRating: 3, reviewCount: 5, viewCount: 100 },
        { id: 't-2', category: 'Safari', totalBookings: 20, averageRating: 4, reviewCount: 10, viewCount: 200 },
      ];
      const result = scorer.getPopularByCategory(tours, 1);
      expect(result.Safari).toHaveLength(1);
    });
  });
});
