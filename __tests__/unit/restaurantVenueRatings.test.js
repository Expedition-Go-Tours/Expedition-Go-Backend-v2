jest.mock('../../src/core/services/restaurantVenueStats', () => ({
  recomputeRecentStats: jest.fn(() => Promise.resolve(1)),
  recomputeVenueStats: jest.fn(() => Promise.resolve(1)),
  round4: (value) => Math.round(value * 10000) / 10000,
}));

const {
  recomputeRecentStats,
  recomputeVenueStats,
} = require('../../src/core/services/restaurantVenueStats');
const {
  storedSum,
  distributionWith,
  addApprovedRating,
  removeApprovedRating,
  rebuildVenueRating,
} = require('../../src/core/services/restaurantVenueRatings');

function makeTx(venue) {
  return {
    restaurantVenue: {
      findUnique: jest.fn(() => Promise.resolve(venue)),
      update: jest.fn(() => Promise.resolve({})),
    },
    restaurantVenueReview: {
      groupBy: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
  };
}

describe('restaurantVenueRatings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('recovers a missing rating sum from the stored average', () => {
    expect(storedSum({ ratingSum: 0, averageRating: 4.2, reviewCount: 10 })).toBe(42);
    expect(storedSum({ ratingSum: 13, averageRating: 4.2, reviewCount: 10 })).toBe(13);
  });

  it('keeps all five buckets in the distribution', () => {
    expect(distributionWith({ 5: 2 }, 4, 1)).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 });
    expect(distributionWith({ 3: 1 }, 3, -1)).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it('adds an approved review and refreshes the ranking in the same transaction', async () => {
    const tx = makeTx({
      reviewCount: 3,
      ratingSum: 12,
      averageRating: 4,
      verifiedReviewCount: 1,
      distribution: { 1: 0, 2: 0, 3: 1, 4: 2, 5: 0 },
      lastReviewAt: new Date('2026-01-01'),
    });

    const count = await addApprovedRating(tx, 'v1', { rating: 5, verified: true });

    expect(count).toBe(4);
    expect(tx.restaurantVenue.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: expect.objectContaining({
        reviewCount: 4,
        ratingSum: 17,
        averageRating: 4.25,
        verifiedReviewCount: 2,
      }),
    });
    expect(tx.restaurantVenue.update.mock.calls[0][0].data.distribution).toEqual({
      1: 0,
      2: 0,
      3: 1,
      4: 2,
      5: 1,
    });
    // Recency first: the ranking score sorts on the window it just wrote.
    expect(recomputeRecentStats).toHaveBeenCalledWith(['v1'], tx);
    expect(recomputeVenueStats).toHaveBeenCalledWith(['v1'], tx);
    expect(recomputeRecentStats.mock.invocationCallOrder[0]).toBeLessThan(
      recomputeVenueStats.mock.invocationCallOrder[0],
    );
  });

  it('clears the average when the last approved review is removed', async () => {
    const tx = makeTx({
      reviewCount: 1,
      ratingSum: 5,
      averageRating: 5,
      verifiedReviewCount: 1,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
      lastReviewAt: new Date('2026-01-01'),
    });

    await removeApprovedRating(tx, 'v1', { rating: 5, verified: true });

    expect(tx.restaurantVenue.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        reviewCount: 0,
        ratingSum: 0,
        averageRating: null,
        verifiedReviewCount: 0,
      }),
    );
    // lastReviewAt is deliberately left alone: it is a fact about history.
    expect(tx.restaurantVenue.update.mock.calls[0][0].data.lastReviewAt).toBeUndefined();
  });

  it('rebuilds the aggregate from review rows after a repair', async () => {
    const tx = makeTx({});
    tx.restaurantVenueReview.groupBy.mockResolvedValue([
      { rating: 5, _count: { _all: 2 } },
      { rating: 3, _count: { _all: 1 } },
    ]);
    tx.restaurantVenueReview.count.mockResolvedValue(1);
    tx.restaurantVenueReview.findFirst.mockResolvedValue({ createdAt: new Date('2026-11-20') });

    const count = await rebuildVenueRating(tx, 'v1');

    expect(count).toBe(3);
    expect(tx.restaurantVenue.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: expect.objectContaining({
        reviewCount: 3,
        ratingSum: 13,
        averageRating: 4.3333,
        verifiedReviewCount: 1,
        lastReviewAt: new Date('2026-11-20'),
      }),
    });
  });
});
