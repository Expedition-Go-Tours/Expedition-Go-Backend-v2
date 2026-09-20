const { combineExternalStats, combineTourStats, COUNTED_SOURCES } = require('../../src/core/services/externalReviewCombine');

describe('externalReviewCombine', () => {
  describe('COUNTED_SOURCES', () => {
    it('counts TripAdvisor and GetYourGuide only', () => {
      expect(COUNTED_SOURCES).toEqual(['TRIPADVISOR', 'GETYOURGUIDE']);
    });
  });

  describe('combineExternalStats', () => {
    it('returns zeros for an empty set', () => {
      expect(combineExternalStats([])).toEqual({ rating: 0, reviewCount: 0 });
    });

    it('weighted-averages multiple platforms by review count', () => {
      const result = combineExternalStats([
        { source: 'TRIPADVISOR', rating: 5.0, reviewCount: 100 },
        { source: 'GETYOURGUIDE', rating: 4.0, reviewCount: 100 },
      ]);
      expect(result.rating).toBe(4.5);
      expect(result.reviewCount).toBe(200);
    });

    it('never counts Google rows', () => {
      const result = combineExternalStats([
        { source: 'GOOGLE', rating: 4.9, reviewCount: 1000 },
        { source: 'TRIPADVISOR', rating: 4.0, reviewCount: 10 },
      ]);
      expect(result.reviewCount).toBe(10);
      expect(result.rating).toBe(4);
    });

    it('removes the 1★ bucket from a product total defensively', () => {
      // 100 reviews at 4.9 with ten 1★ included => 90 reviews, sum 490 - 10
      const result = combineExternalStats([
        { source: 'TRIPADVISOR', rating: 4.9, reviewCount: 100, distribution: { 1: 10 } },
      ]);
      expect(result.reviewCount).toBe(90);
      expect(result.rating).toBe(Math.round((490 - 10) / 90 * 10) / 10);
    });

    it('skips rows with no usable totals', () => {
      const result = combineExternalStats([
        { source: 'TRIPADVISOR', rating: 0, reviewCount: 50 },
        { source: 'GETYOURGUIDE', rating: 4.5, reviewCount: 0 },
      ]);
      expect(result).toEqual({ rating: 0, reviewCount: 0 });
    });
  });

  describe('combineTourStats', () => {
    it('merges in-app and external into one weighted figure', () => {
      const result = combineTourStats(4.0, 10, { rating: 4.9, reviewCount: 595 });
      expect(result.reviewCount).toBe(605);
      expect(result.rating).toBe(Math.round((40 + 4.9 * 595) / 605 * 10) / 10);
    });

    it('falls back to in-app only when there is no external data', () => {
      expect(combineTourStats(4.3, 7, { rating: 0, reviewCount: 0 })).toEqual({ rating: 4.3, reviewCount: 7 });
    });

    it('counts external only when a tour has no in-app reviews', () => {
      expect(combineTourStats(null, 0, { rating: 4.8, reviewCount: 50 })).toEqual({ rating: 4.8, reviewCount: 50 });
    });

    it('returns zeros when there is nothing to count', () => {
      expect(combineTourStats(null, 0, { rating: 0, reviewCount: 0 })).toEqual({ rating: 0, reviewCount: 0 });
    });

    it('caps the rating at 5', () => {
      const result = combineTourStats(5, 1000, { rating: 5, reviewCount: 1000 });
      expect(result.rating).toBeLessThanOrEqual(5);
    });
  });
});
