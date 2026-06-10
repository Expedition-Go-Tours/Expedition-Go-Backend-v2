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
        data: { averageRating: expectedAvg, reviewCount: 6 },
      });
    });

    it('handles first review with null averageRating', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: null, reviewCount: 0 });

      await addApprovedRating(tx, tourId, 4);

      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: { averageRating: 4, reviewCount: 1 },
      });
    });
  });

  describe('removeApprovedRating', () => {
    it('removes rating and decrements count', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: 4.5, reviewCount: 10 });

      await removeApprovedRating(tx, tourId, 5);

      const expectedAvg = Math.round(((4.5 * 10) - 5) / 9 * 100) / 100;
      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: { averageRating: expectedAvg, reviewCount: 9 },
      });
    });

    it('resets to null when last review is removed', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: 4.0, reviewCount: 1 });

      await removeApprovedRating(tx, tourId, 4);

      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: { averageRating: null, reviewCount: 0 },
      });
    });

    it('handles zero count gracefully', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: null, reviewCount: 0 });

      await removeApprovedRating(tx, tourId, 3);

      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: { averageRating: null, reviewCount: 0 },
      });
    });
  });

  describe('updateApprovedRating', () => {
    it('replaces old rating with new rating', async () => {
      tx.tour.findUnique.mockResolvedValue({ averageRating: 4.0, reviewCount: 5 });

      await updateApprovedRating(tx, tourId, 4, 5);

      const expectedAvg = Math.round(((4.0 * 5) - 4 + 5) / 5 * 100) / 100;
      expect(tx.tour.update).toHaveBeenCalledWith({
        where: { id: tourId },
        data: { averageRating: expectedAvg },
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
