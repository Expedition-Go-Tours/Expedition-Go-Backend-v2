const { computeFeatures } = require('../../src/core/services/xgboostService');

describe('xgboostService.computeFeatures — brand-scoped review stats', () => {
  // Feature [0] is the Bayesian rating normalized to 0–1.
  const C = 5;
  const M = 3.0;
  const bayesian = (n, avg) => (C * M + n * avg) / (C + n);

  const tour = {
    id: 't1',
    averageRating: 4.0,
    reviewCount: 5,
    combinedRating: 4.9,
    combinedReviewCount: 300,
    totalBookings: 0,
  };

  it('uses the in-app stats by default (non-Expedition)', () => {
    const features = computeFeatures(tour, {});
    expect(features[0]).toBeCloseTo(bayesian(5, 4.0) / 5, 5);
  });

  it('uses the combined stats when useCombined is set (Expedition)', () => {
    const features = computeFeatures(tour, { useCombined: true });
    expect(features[0]).toBeCloseTo(bayesian(300, 4.9) / 5, 5);
  });

  it('falls back to in-app stats when combined is absent', () => {
    const noCombined = { id: 't2', averageRating: 4.2, reviewCount: 8, totalBookings: 0 };
    const features = computeFeatures(noCombined, { useCombined: true });
    expect(features[0]).toBeCloseTo(bayesian(8, 4.2) / 5, 5);
  });
});
