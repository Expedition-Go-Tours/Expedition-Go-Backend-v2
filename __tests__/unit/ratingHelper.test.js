const { addApprovedRating, removeApprovedRating, updateApprovedRating, recalculateSupplierRating } = require('../../utils/ratingHelper');

describe('ratingHelper', () => {
  const tourId = 'tour-1';
  const supplierId = 'supplier-1';
  let tx;

  beforeEach(() => {
    tx = {
      tour: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      tourExternalReviewStat: {
        // No external aggregates by default — combined == internal.
        findMany: jest.fn().mockResolvedValue([]),
      },
      review: {
        aggregate: jest.fn(),
      },
      supplierProfile: {
        update: jest.fn(),
      },
    };
  });

  describe('addApprovedRating', () => {
    it('calculates new average rating correctly', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: 4.0, reviewCount: 5 });

      await addApprovedRating(tx, tourId, 5);

      const expectedAvg = Math.round(((4.0 * 5) + 5) / 6 * 100) / 100;
      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: {
          averageRating: expectedAvg,
          reviewCount: 6,
          combinedRating: Math.round(expectedAvg * 10) / 10,
          combinedReviewCount: 6,
        },
      });
    });

    it('handles first review with null averageRating', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: null, reviewCount: 0 });

      await addApprovedRating(tx, tourId, 4);

      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: { averageRating: 4, reviewCount: 1, combinedRating: 4, combinedReviewCount: 1 },
      });
    });

    it('includes external reviews in the combined fields', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: 4.0, reviewCount: 5 });
      tx.tourExternalReviewStat.findMany.mockResolvedValue([
        { source: 'TRIPADVISOR', rating: 4.5, reviewCount: 95, distribution: null },
      ]);

      await addApprovedRating(tx, tourId, 5);

      // internal 4.17 (6 reviews) + external 4.5 (95) => 101 reviews @ 4.5
      const data = tx.tour.update.mock.calls[0][0].data;
      expect(data.reviewCount).toBe(6);
      expect(data.combinedReviewCount).toBe(101);
      expect(data.combinedRating).toBe(4.5);
    });
  });

  describe('removeApprovedRating', () => {
    it('removes rating and decrements count', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: 4.5, reviewCount: 10 });

      await removeApprovedRating(tx, tourId, 5);

      const expectedAvg = Math.round(((4.5 * 10) - 5) / 9 * 100) / 100;
      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: {
          averageRating: expectedAvg,
          reviewCount: 9,
          combinedRating: Math.round(expectedAvg * 10) / 10,
          combinedReviewCount: 9,
        },
      });
    });

    it('resets to null when last review is removed', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: 4.0, reviewCount: 1 });

      await removeApprovedRating(tx, tourId, 4);

      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: { averageRating: null, reviewCount: 0, combinedRating: null, combinedReviewCount: 0 },
      });
    });

    it('handles zero count gracefully', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: null, reviewCount: 0 });

      await removeApprovedRating(tx, tourId, 3);

      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: { averageRating: null, reviewCount: 0, combinedRating: null, combinedReviewCount: 0 },
      });
    });

    it('keeps external reviews in the combined count when the last in-app review goes', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: 4.0, reviewCount: 1 });
      tx.tourExternalReviewStat.findMany.mockResolvedValue([
        { source: 'GETYOURGUIDE', rating: 4.8, reviewCount: 50, distribution: null },
      ]);

      await removeApprovedRating(tx, tourId, 4);

      const data = tx.tour.update.mock.calls[0][0].data;
      expect(data.averageRating).toBeNull();
      expect(data.reviewCount).toBe(0);
      expect(data.combinedRating).toBe(4.8);
      expect(data.combinedReviewCount).toBe(50);
    });
  });

  describe('updateApprovedRating', () => {
    it('replaces old rating with new rating', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: 4.0, reviewCount: 5 });

      await updateApprovedRating(tx, tourId, 4, 5);

      const expectedAvg = Math.round(((4.0 * 5) - 4 + 5) / 5 * 100) / 100;
      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: {
          averageRating: expectedAvg,
          combinedRating: Math.round(expectedAvg * 10) / 10,
          combinedReviewCount: 5,
        },
      });
    });
  });

  describe('recalculateSupplierRating', () => {
    it('updates supplier average rating from approved reviews', async () => {
      tx.review.aggregate.mockResolvedValue({ _avg: { rating: 4.2 } });

      await recalculateSupplierRating(tx, supplierId);

      expect(tx.supplierProfile.update).toHaveBeenCalledWith({
        where: { userId: supplierId },
        data: { averageRating: 4.2 },
      });
    });
  });
});
