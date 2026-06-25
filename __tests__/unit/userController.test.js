jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() },
  tour: { findUnique: jest.fn(), findMany: jest.fn() },
}));

jest.mock('../../utils/cloudinaryHelper', () => ({ deleteCloudinaryImage: jest.fn(), isValidCloudinaryUrl: jest.fn((url) => typeof url === 'string' && url.startsWith('https://res.cloudinary.com/')) }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`) }));
const prisma = require('../../utils/prismaClient');
const { deleteCloudinaryImage, isValidCloudinaryUrl } = require('../../utils/cloudinaryHelper');
const { logActivity } = require('../../utils/auditLogger');
const { cloudinaryUrl } = require('../../utils/imageOptimizer');
const controller = require('../../controllers/userController');

describe('userController', () => {
  let req, res, next;

  const mockUser = {
    id: 'u-1',
    name: 'John Doe',
    email: 'john@test.com',
    photoURL: 'photo.jpg',
    phone: '+1234567890',
    language: 'en',
    timezone: 'UTC',
    roles: ['customer'],
    wishlist: [],
    likes: [],
    active: true,
    logoUrl: null,
    lastLoginAt: new Date(),
    createdAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'u-1', ...mockUser }, file: null };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.user.update.mockResolvedValue(mockUser);
    prisma.user.create.mockResolvedValue(mockUser);
    prisma.user.delete.mockResolvedValue(mockUser);
    deleteCloudinaryImage.mockResolvedValue();
    logActivity.mockResolvedValue();
    cloudinaryUrl.mockImplementation((url, size) => `https://cdn.example.com/${size}/${url}`);
  });

  // ============================
  // getMe
  // ============================
  describe('getMe', () => {
    it('returns optimized user', async () => {
      await controller.getMe(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.user.photoURL).toBe('https://cdn.example.com/300/photo.jpg');
    });

    it('returns 404 when no user', async () => {
      req.user = null;
      await controller.getMe(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('handles null photoURL', async () => {
      req.user = { ...mockUser, photoURL: null };
      await controller.getMe(req, res, next);
      const body = res.json.mock.calls[0][0];
      expect(body.data.user.photoURL).toBeNull();
    });
  });

  // ============================
  // updateMe
  // ============================
  describe('updateMe', () => {
    it('returns 400 when trying to update email', async () => {
      req.body = { email: 'new@email.com' };
      await controller.updateMe(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns existing user when no updates provided', async () => {
      await controller.updateMe(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: { user: expect.any(Object) } })
      );
    });

    it('updates text fields', async () => {
      const updated = { ...mockUser, name: 'Jane', phone: '+1111111111' };
      prisma.user.update.mockResolvedValue(updated);
      req.body = { name: 'Jane', phone: '+1111111111', language: 'fr', timezone: 'Europe/Paris', logoUrl: '/logo.png' };

      await controller.updateMe(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'Jane', phone: '+1111111111', language: 'fr', timezone: 'Europe/Paris', logoUrl: '/logo.png' }),
        })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.profile_updated' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handles file upload and deletes old photo', async () => {
      req.file = { path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/new-photo.jpg' };

      await controller.updateMe(req, res, next);

      expect(deleteCloudinaryImage).toHaveBeenCalledWith('photo.jpg');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ photoURL: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/new-photo.jpg' }) })
      );
    });

    it('skips deleteCloudinaryImage when no existing photo', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...mockUser, photoURL: null });
      req.file = { path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/user-photos/new-photo.jpg' };

      await controller.updateMe(req, res, next);

      expect(deleteCloudinaryImage).not.toHaveBeenCalled();
    });
  });

  // ============================
  // deleteMe
  // ============================
  describe('deleteMe', () => {
    it('soft-deletes user and returns 204', async () => {
      await controller.deleteMe(req, res, next);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u-1' }, data: { active: false } })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.account_deleted' }));
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });

  // ============================
  // deleteUser (admin)
  // ============================
  describe('deleteUser', () => {
    it('deletes user by id and returns 204', async () => {
      req.params = { id: 'u-2' };
      await controller.deleteUser(req, res, next);
      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u-2' } });
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.deleted_by_admin' }));
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('returns 404 when user not found', async () => {
      req.params = { id: 'nonexistent' };
      prisma.user.delete.mockRejectedValue(new Error('Not found'));
      await controller.deleteUser(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // getWishlist
  // ============================
  describe('getWishlist', () => {
    it('returns wishlisted tours with full details', async () => {
      prisma.user.findUnique.mockResolvedValue({ wishlist: ['t1', 't2'] });
      const mockTours = [
        { id: 't1', title: 'Tour A', slug: 'tour-a', coverPhoto: 'a.jpg', city: 'Accra', country: 'Ghana', averageRating: 4.5, reviewCount: 10, totalBookings: 50, schedulesAndPricing: {}, createdAt: new Date(), supplier: { id: 's1', name: 'Supplier 1', photoURL: 's.jpg' } },
        { id: 't2', title: 'Tour B', slug: 'tour-b', coverPhoto: 'b.jpg', city: 'Kumasi', country: 'Ghana', averageRating: 4.0, reviewCount: 5, totalBookings: 20, schedulesAndPricing: {}, createdAt: new Date(), supplier: { id: 's2', name: 'Supplier 2', photoURL: null } },
      ];
      prisma.tour.findMany.mockResolvedValue(mockTours);

      await controller.getWishlist(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: ['t1', 't2'] } }) })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: 'success',
        results: 2,
        data: { tours: mockTours }
      });
    });

    it('returns empty array when wishlist is empty', async () => {
      prisma.user.findUnique.mockResolvedValue({ wishlist: [] });

      await controller.getWishlist(req, res, next);

      expect(prisma.tour.findMany).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        status: 'success',
        results: 0,
        data: { tours: [] }
      });
    });

    it('returns 404 when user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await controller.getWishlist(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // toggleWishlist
  // ============================
  describe('toggleWishlist', () => {
    beforeEach(() => {
      prisma.tour.findUnique.mockResolvedValue({ id: 't1', status: 'ACTIVE' });
    });

    it('adds tour to wishlist', async () => {
      req.params = { tourId: 't1' };
      prisma.user.findUnique.mockResolvedValue({ ...mockUser, wishlist: [] });
      prisma.user.update.mockResolvedValue({ ...mockUser, wishlist: ['t1'] });

      await controller.toggleWishlist(req, res, next);

      expect(prisma.tour.findUnique).toHaveBeenCalledWith({ where: { id: 't1' }, select: { id: true, status: true } });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { wishlist: ['t1'] } })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.wishlist_added' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('removes tour from wishlist', async () => {
      req.params = { tourId: 't1' };
      prisma.user.findUnique.mockResolvedValue({ ...mockUser, wishlist: ['t1', 't2'] });
      prisma.user.update.mockResolvedValue({ ...mockUser, wishlist: ['t2'] });

      await controller.toggleWishlist(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { wishlist: ['t2'] } })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.wishlist_removed' }));
    });

    it('returns 404 when user not found', async () => {
      req.params = { tourId: 't1' };
      prisma.user.findUnique.mockResolvedValue(null);
      await controller.toggleWishlist(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 404 when tour not found', async () => {
      req.params = { tourId: 'nonexistent' };
      prisma.tour.findUnique.mockResolvedValue(null);
      await controller.toggleWishlist(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, message: 'Tour not found' }));
    });
  });

  // ============================
  // toggleLike
  // ============================
  describe('toggleLike', () => {
    it('adds like to tour', async () => {
      req.params = { tourId: 't1' };
      prisma.user.findUnique.mockResolvedValue({ ...mockUser, likes: [] });
      prisma.user.update.mockResolvedValue({ ...mockUser, likes: ['t1'] });

      await controller.toggleLike(req, res, next);

      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.like_added' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('removes like from tour', async () => {
      req.params = { tourId: 't1' };
      prisma.user.findUnique.mockResolvedValue({ ...mockUser, likes: ['t1'] });
      prisma.user.update.mockResolvedValue({ ...mockUser, likes: [] });

      await controller.toggleLike(req, res, next);

      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.like_removed' }));
    });

    it('returns 404 when user not found', async () => {
      req.params = { tourId: 't1' };
      prisma.user.findUnique.mockResolvedValue(null);
      await controller.toggleLike(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // createMe
  // ============================
  describe('createMe', () => {
    it('returns the authenticated user', async () => {
      await controller.createMe(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: { user: expect.objectContaining({ id: 'u-1' }) },
        })
      );
    });
  });

  // ============================
  // syncMe
  // ============================
  describe('syncMe', () => {
    it('updates lastLoginAt and returns user', async () => {
      await controller.syncMe(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u-1' },
          data: { lastLoginAt: expect.any(Date) },
        })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.synced' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
