jest.mock('../../utils/prismaClient', () => ({
  booking: { findFirst: jest.fn() },
  review: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  tour: { findMany: jest.fn() },
  $transaction: jest.fn((cb) => cb({
    review: { create: jest.fn(), update: jest.fn(), delete: jest.fn(), aggregate: jest.fn() },
    tour: { update: jest.fn(), findUnique: jest.fn() },
    supplierProfile: { update: jest.fn() },
  })),
}));

jest.mock('../../utils/queue', () => ({ enqueueNotification: jest.fn() }));
jest.mock('../../utils/adminNotificationService', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/cloudinaryHelper', () => ({ deleteCloudinaryImage: jest.fn() }));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`) }));
jest.mock('../../utils/ratingHelper', () => ({ addApprovedRating: jest.fn(), removeApprovedRating: jest.fn(), recalculateSupplierRating: jest.fn() }));
jest.mock('../../utils/cacheHelper', () => ({ getOrSet: jest.fn((key, fn) => fn()), invalidateReviewCaches: jest.fn(), invalidateTourCaches: jest.fn() }));
jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn() }));

const prisma = require('../../utils/prismaClient');
const { enqueueNotification } = require('../../utils/queue');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const { logActivity } = require('../../utils/auditLogger');
const { deleteCloudinaryImage } = require('../../utils/cloudinaryHelper');
const { addApprovedRating, removeApprovedRating, recalculateSupplierRating } = require('../../utils/ratingHelper');
const cache = require('../../utils/cacheHelper');
const event = require('../../utils/eventEmitter');
const controller = require('../../controllers/reviewController');

describe('reviewController', () => {
  let req, res, next;
  const mockTx = () => ({
    review: { create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    tour: { update: jest.fn(), findUnique: jest.fn() },
    supplierProfile: { update: jest.fn() },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      query: {}, params: {}, body: {},
      user: { id: 'user-1', roles: ['customer'] },
      headers: {}, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1',
    };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
    enqueueNotification.mockResolvedValue();
    notifyAdmin.mockResolvedValue();
    logActivity.mockResolvedValue();
    deleteCloudinaryImage.mockResolvedValue();
    addApprovedRating.mockResolvedValue();
    removeApprovedRating.mockResolvedValue();
    recalculateSupplierRating.mockResolvedValue();
    cache.getOrSet.mockImplementation((key, fn) => fn());
    cache.invalidateReviewCaches.mockResolvedValue();
    cache.invalidateTourCaches.mockResolvedValue();
    event.emit.mockReturnValue();
    prisma.$transaction.mockImplementation((cb) => cb(mockTx()));
  });

  // ============================
  // createReview
  // ============================
  describe('createReview', () => {
    const mockBooking = {
      id: 'b1', tourId: 't1', status: 'COMPLETED', paymentStatus: 'SUCCEEDED',
      selectedDate: new Date('2024-01-01'), tour: { id: 't1', title: 'Tour', supplierId: 's1', supplier: { id: 's1' } },
      review: null,
    };
    const mockReview = {
      id: 'r1', rating: 5, title: 'Great!', comment: 'Amazing', photos: [],
      customer: { id: 'u1', name: 'User', photoURL: null },
      tour: { id: 't1', title: 'Tour' },
    };

    beforeEach(() => {
      prisma.booking.findFirst.mockResolvedValue(mockBooking);
      prisma.$transaction.mockImplementation(async (cb) => {
        const tx = mockTx();
        tx.review.create.mockResolvedValue(mockReview);
        return cb(tx);
      });
    });

    it('creates a review successfully', async () => {
      req.body = { bookingId: 'b1', rating: 5, title: 'Great!', comment: 'Amazing' };

      await controller.createReview(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'success', data: expect.objectContaining({ review: mockReview }),
      }));
    });

    it('returns 404 when booking not found', async () => {
      prisma.booking.findFirst.mockResolvedValue(null);
      req.body = { bookingId: 'b1', rating: 5 };

      await controller.createReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when review already exists', async () => {
      prisma.booking.findFirst.mockResolvedValue({ ...mockBooking, review: { id: 'existing' } });

      await controller.createReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 for invalid rating', async () => {
      req.body = { bookingId: 'b1', rating: 6, title: 'Great!', comment: 'Amazing' };

      await controller.createReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('creates review WITHIN a transaction', async () => {
      req.body = { bookingId: 'b1', rating: 4, title: 'Good', comment: 'Nice' };

      await controller.createReview(req, res, next);

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('calls addApprovedRating and recalculateSupplierRating in transaction', async () => {
      req.body = { bookingId: 'b1', rating: 4, title: 'Good', comment: 'Nice' };

      await controller.createReview(req, res, next);

      expect(addApprovedRating).toHaveBeenCalled();
      expect(recalculateSupplierRating).toHaveBeenCalled();
    });

    it('enqueues notification after creation', async () => {
      req.body = { bookingId: 'b1', rating: 4, title: 'Good', comment: 'Nice' };

      await controller.createReview(req, res, next);

      expect(enqueueNotification).toHaveBeenCalled();
    });

    it('logs activity after creation', async () => {
      req.body = { bookingId: 'b1', rating: 4, title: 'Good', comment: 'Nice' };

      await controller.createReview(req, res, next);

      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'review.created' }));
    });

    it('emits review.submitted event', async () => {
      req.body = { bookingId: 'b1', rating: 4, title: 'Good', comment: 'Nice' };

      await controller.createReview(req, res, next);

      expect(event.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'review.submitted' }));
    });

    it('handles rating of 1 (minimum)', async () => {
      req.body = { bookingId: 'b1', rating: 1, title: 'Bad', comment: 'Terrible' };

      await controller.createReview(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  // ============================
  // updateReview
  // ============================
  describe('updateReview', () => {
    const mockExisting = {
      id: 'r1', customerId: 'user-1', rating: 4, title: 'Old', comment: 'Old comment',
      photos: ['p1.jpg'], status: 'APPROVED', tourId: 't1',
      tour: { supplierId: 's1' },
    };

    beforeEach(() => {
      req.params = { id: 'r1' };
      prisma.review.findFirst.mockResolvedValue(mockExisting);
      prisma.$transaction.mockImplementation(async (cb) => {
        const tx = mockTx();
        tx.review.update.mockResolvedValue({ ...mockExisting, rating: 5, title: 'Updated', status: 'PENDING' });
        return cb(tx);
      });
    });

    it('updates review successfully', async () => {
      req.body = { rating: 5, title: 'Updated' };

      await controller.updateReview(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 404 when review not found', async () => {
      prisma.review.findFirst.mockResolvedValue(null);

      await controller.updateReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 for invalid rating', async () => {
      req.body = { rating: 6 };

      await controller.updateReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('recalculates ratings when approved review rating changes', async () => {
      req.body = { rating: 5 };

      await controller.updateReview(req, res, next);

      expect(removeApprovedRating).toHaveBeenCalled();
      expect(recalculateSupplierRating).toHaveBeenCalled();
    });

    it('sets status to PENDING when content changes', async () => {
      req.body = { title: 'New Title' };
      prisma.$transaction.mockImplementation(async (cb) => {
        const tx = mockTx();
        tx.review.update.mockResolvedValue({ ...mockExisting, title: 'New Title', status: 'PENDING' });
        return cb(tx);
      });

      await controller.updateReview(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('invalidates caches when approved review rating changes', async () => {
      req.body = { rating: 5 };

      await controller.updateReview(req, res, next);

      expect(cache.invalidateReviewCaches).toHaveBeenCalled();
      expect(cache.invalidateTourCaches).toHaveBeenCalled();
    });
  });

  // ============================
  // deleteReview
  // ============================
  describe('deleteReview', () => {
    const mockReview = {
      id: 'r1', customerId: 'user-1', rating: 4, photos: ['p1.jpg', 'p2.jpg'],
      status: 'APPROVED', tourId: 't1', tour: { supplierId: 's1' },
    };

    beforeEach(() => {
      req.params = { id: 'r1' };
      prisma.review.findFirst.mockResolvedValue(mockReview);
    });

    it('deletes review and associated photos', async () => {
      await controller.deleteReview(req, res, next);

      expect(deleteCloudinaryImage).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('returns 404 when review not found', async () => {
      prisma.review.findFirst.mockResolvedValue(null);

      await controller.deleteReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('removes rating when approved review is deleted', async () => {
      await controller.deleteReview(req, res, next);

      expect(removeApprovedRating).toHaveBeenCalled();
      expect(recalculateSupplierRating).toHaveBeenCalled();
    });

    it('does not remove rating when unapproved review is deleted', async () => {
      prisma.review.findFirst.mockResolvedValue({ ...mockReview, status: 'PENDING' });

      await controller.deleteReview(req, res, next);

      expect(removeApprovedRating).not.toHaveBeenCalled();
    });

    it('invalidates caches after deletion', async () => {
      await controller.deleteReview(req, res, next);

      expect(cache.invalidateReviewCaches).toHaveBeenCalled();
      expect(cache.invalidateTourCaches).toHaveBeenCalled();
    });

    it('logs activity after deletion', async () => {
      await controller.deleteReview(req, res, next);

      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'review.deleted' }));
    });

    it('handles reviews with no photos', async () => {
      prisma.review.findFirst.mockResolvedValue({ ...mockReview, photos: [] });

      await controller.deleteReview(req, res, next);

      expect(deleteCloudinaryImage).not.toHaveBeenCalled();
    });
  });

  // ============================
  // getTourReviews
  // ============================
  describe('getTourReviews', () => {
    const mockReviews = [
      { id: 'r1', rating: 5, comment: 'Great!', photos: ['p1.jpg'], customer: { id: 'u1', name: 'User', photoURL: null } },
    ];
    const mockDist = [{ rating: 5, _count: 1 }];

    beforeEach(() => {
      req.params = { tourId: 't1' };
      prisma.review.findMany.mockResolvedValue(mockReviews);
      prisma.review.count.mockResolvedValue(1);
      prisma.review.groupBy.mockResolvedValue(mockDist);
    });

    it('returns paginated reviews for a tour', async () => {
      await controller.getTourReviews(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({
          reviews: expect.any(Array),
          pagination: expect.any(Object),
          ratingDistribution: expect.any(Array),
        }),
      }));
    });

    it('filters by rating when provided', async () => {
      req.query.rating = '5';

      await controller.getTourReviews(req, res, next);

      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ rating: 5 }),
        })
      );
    });

    it('optimizes photo URLs through cloudinary', async () => {
      await controller.getTourReviews(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.reviews[0].photos[0]).toContain('cdn.example.com');
    });
  });

  // ============================
  // getReview
  // ============================
  describe('getReview', () => {
    const mockReview = {
      id: 'r1', status: 'APPROVED', rating: 5,
      customer: { id: 'u1', name: 'User', photoURL: null },
      tour: { id: 't1', title: 'Tour', supplier: { name: 'Supplier', photoURL: null } },
    };

    beforeEach(() => {
      req.params = { id: 'r1' };
      prisma.review.findFirst.mockResolvedValue(mockReview);
    });

    it('returns single review', async () => {
      await controller.getReview(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ review: mockReview }),
      }));
    });

    it('returns 404 when review not found', async () => {
      prisma.review.findFirst.mockResolvedValue(null);

      await controller.getReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // addSupplierResponse
  // ============================
  describe('addSupplierResponse', () => {
    const mockReview = {
      id: 'r1', status: 'APPROVED', customerId: 'c1', tourId: 't1', supplierResponse: null,
      customer: { id: 'c1', name: 'Customer' },
      tour: { id: 't1', title: 'Tour', supplierId: 's1' },
    };
    const mockUpdated = { ...mockReview, supplierResponse: 'Thank you!', supplierResponseAt: new Date() };

    beforeEach(() => {
      req.params = { id: 'r1' };
      req.body = { response: 'Thank you!' };
      req.user = { id: 's1', roles: ['supplier'] };
      prisma.review.findFirst.mockResolvedValue(mockReview);
      prisma.review.update.mockResolvedValue(mockUpdated);
    });

    it('adds supplier response successfully', async () => {
      await controller.addSupplierResponse(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ review: expect.any(Object) }),
      }));
    });

    it('returns 400 for empty response', async () => {
      req.body = { response: '' };

      await controller.addSupplierResponse(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when review not found for supplier', async () => {
      prisma.review.findFirst.mockResolvedValue(null);

      await controller.addSupplierResponse(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when response already exists', async () => {
      prisma.review.findFirst.mockResolvedValue({ ...mockReview, supplierResponse: 'Existing' });

      await controller.addSupplierResponse(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('sends notification to customer', async () => {
      await controller.addSupplierResponse(req, res, next);

      expect(enqueueNotification).toHaveBeenCalled();
    });
  });

  // ============================
  // updateSupplierResponse
  // ============================
  describe('updateSupplierResponse', () => {
    const mockReview = {
      id: 'r1', status: 'APPROVED', supplierResponse: 'Old response',
      tour: { supplierId: 's1' },
    };

    beforeEach(() => {
      req.params = { id: 'r1' };
      req.body = { response: 'Updated response' };
      req.user = { id: 's1', roles: ['supplier'] };
      prisma.review.findFirst.mockResolvedValue(mockReview);
      prisma.review.update.mockResolvedValue({ ...mockReview, supplierResponse: 'Updated response' });
    });

    it('updates supplier response successfully', async () => {
      await controller.updateSupplierResponse(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 for empty response', async () => {
      req.body = { response: '' };

      await controller.updateSupplierResponse(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when review not found', async () => {
      prisma.review.findFirst.mockResolvedValue(null);

      await controller.updateSupplierResponse(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 404 when no existing response to update', async () => {
      prisma.review.findFirst.mockResolvedValue({ ...mockReview, supplierResponse: null });

      await controller.updateSupplierResponse(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // deleteSupplierResponse
  // ============================
  describe('deleteSupplierResponse', () => {
    const mockReview = {
      id: 'r1', supplierResponse: 'Existing response', supplierResponseAt: new Date(),
      tour: { supplierId: 's1' },
    };

    beforeEach(() => {
      req.params = { id: 'r1' };
      req.user = { id: 's1', roles: ['supplier'] };
      prisma.review.findFirst.mockResolvedValue(mockReview);
      prisma.review.update.mockResolvedValue({ ...mockReview, supplierResponse: null, supplierResponseAt: null });
    });

    it('deletes supplier response successfully', async () => {
      await controller.deleteSupplierResponse(req, res, next);

      expect(prisma.review.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { supplierResponse: null, supplierResponseAt: null },
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 404 when review not found', async () => {
      prisma.review.findFirst.mockResolvedValue(null);

      await controller.deleteSupplierResponse(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 404 when no response to delete', async () => {
      prisma.review.findFirst.mockResolvedValue({ ...mockReview, supplierResponse: null });

      await controller.deleteSupplierResponse(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // getSupplierReviews
  // ============================
  describe('getSupplierReviews', () => {
    const mockReviews = [
      { id: 'r1', rating: 4, comment: 'Nice', customer: { id: 'u1', name: 'User', photoURL: null }, tour: { id: 't1', title: 'Tour' } },
    ];

    beforeEach(() => {
      prisma.review.findMany.mockResolvedValue(mockReviews);
      prisma.review.count.mockResolvedValue(1);
    });

    it('returns reviews for supplier tours', async () => {
      await controller.getSupplierReviews(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          reviews: expect.any(Array),
          pagination: expect.any(Object),
        }),
      }));
    });

    it('filters by tourId when provided', async () => {
      req.query.tourId = 't1';

      await controller.getSupplierReviews(req, res, next);

      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tourId: 't1' }),
        })
      );
    });

    it('filters by rating when provided', async () => {
      req.query.rating = '5';

      await controller.getSupplierReviews(req, res, next);

      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ rating: 5 }),
        })
      );
    });
  });

  // ============================
  // getPendingReviews
  // ============================
  describe('getPendingReviews', () => {
    const mockReviews = [
      { id: 'r1', status: 'PENDING', customer: { id: 'u1', name: 'User', email: 'u@t.com', photoURL: null }, tour: { id: 't1', title: 'Tour', supplier: { name: 'Supplier' } } },
    ];

    beforeEach(() => {
      prisma.review.findMany.mockResolvedValue(mockReviews);
      prisma.review.count.mockResolvedValue(1);
    });

    it('returns pending reviews with counts', async () => {
      await controller.getPendingReviews(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          reviews: expect.any(Array),
          pagination: expect.any(Object),
          counts: expect.objectContaining({
            pending: expect.any(Number),
            flagged: expect.any(Number),
            moderatedToday: expect.any(Number),
          }),
        }),
      }));
    });

    it('filters by status when provided', async () => {
      req.query.status = 'PENDING';

      await controller.getPendingReviews(req, res, next);

      expect(prisma.review.findMany).toHaveBeenCalled();
    });

    it('returns all reviews when status ALL is provided', async () => {
      req.query.status = 'ALL';

      await controller.getPendingReviews(req, res, next);

      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} })
      );
    });
  });

  // ============================
  // moderateReview
  // ============================
  describe('moderateReview', () => {
    const mockReview = {
      id: 'r1', rating: 4, status: 'PENDING', customerId: 'c1', tourId: 't1',
      tour: { supplierId: 's1' },
    };

    beforeEach(() => {
      req.params = { id: 'r1' };
      req.body = { action: 'approve', reason: '' };
      req.user = { id: 'admin-1', roles: ['admin'] };
      prisma.review.findUnique.mockResolvedValue(mockReview);
      prisma.$transaction.mockImplementation(async (cb) => {
        const tx = mockTx();
        tx.review.update.mockResolvedValue({ ...mockReview, status: 'APPROVED', moderatedBy: 'admin-1' });
        return cb(tx);
      });
    });

    it('approves a review', async () => {
      await controller.moderateReview(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 for invalid action', async () => {
      req.body = { action: 'invalid' };

      await controller.moderateReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when review not found', async () => {
      prisma.review.findUnique.mockResolvedValue(null);

      await controller.moderateReview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('adds approved rating when approving a non-approved review', async () => {
      await controller.moderateReview(req, res, next);

      expect(addApprovedRating).toHaveBeenCalled();
      expect(recalculateSupplierRating).toHaveBeenCalled();
    });

    it('removes rating when rejecting an approved review', async () => {
      prisma.review.findUnique.mockResolvedValue({ ...mockReview, status: 'APPROVED' });
      req.body = { action: 'reject', reason: 'Spam' };

      await controller.moderateReview(req, res, next);

      expect(removeApprovedRating).toHaveBeenCalled();
      expect(recalculateSupplierRating).toHaveBeenCalled();
    });

    it('flags a review with reason', async () => {
      prisma.review.findUnique.mockResolvedValue({ ...mockReview, status: 'APPROVED' });
      req.body = { action: 'flag', reason: 'Inappropriate content' };

      await controller.moderateReview(req, res, next);

      expect(removeApprovedRating).toHaveBeenCalled();
    });

    it('notifies customer and admin after moderation', async () => {
      await controller.moderateReview(req, res, next);

      expect(enqueueNotification).toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalled();
    });

    it('logs activity after moderation', async () => {
      await controller.moderateReview(req, res, next);

      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'review.approve' }));
    });

    it('emits moderation event', async () => {
      await controller.moderateReview(req, res, next);

      expect(event.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'review.approve' }));
    });
  });
});
