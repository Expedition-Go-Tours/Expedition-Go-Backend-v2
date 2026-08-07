jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() },
  tour: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  wishlistItem: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  media: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
}));

jest.mock('../../utils/cloudinaryHelper', () => ({ deleteCloudinaryImage: jest.fn(), isValidCloudinaryUrl: jest.fn((url) => typeof url === 'string' && url.startsWith('https://res.cloudinary.com/')) }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`) }));
jest.mock('../../middleware/authMiddleware', () => ({ invalidateUserCache: jest.fn() }));
const prisma = require('../../utils/prismaClient');
const { deleteCloudinaryImage } = require('../../utils/cloudinaryHelper');
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
      expect(body.data.user.photoURL).toBe('photo.jpg');
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

      expect(deleteCloudinaryImage).toHaveBeenCalledWith('photo.jpg', 3, { userId: 'u-1' });
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

    it('refuses to hard-delete a supplier account', async () => {
      req.params = { id: 'supplier-user' };
      prisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        id: 'supplier-user',
        supplierProfile: { id: 'sp-1', status: 'ACTIVE' },
      });
      await controller.deleteUser(req, res, next);
      expect(prisma.user.delete).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    });
  });

  // ============================
  // getWishlist
  // ============================
  describe('getWishlist', () => {
    it('returns wishlisted tours with real addedAt dates', async () => {
      const added1 = new Date('2026-01-02T10:00:00Z');
      const added2 = new Date('2026-01-01T10:00:00Z');
      const mockItems = [
        { id: 'wi1', addedAt: added1, tour: { id: 't1', title: 'Tour A', slug: 'tour-a', status: 'ACTIVE', coverPhoto: 'a.jpg', city: 'Accra', country: 'Ghana', averageRating: 4.5, reviewCount: 10, totalBookings: 50, schedulesAndPricing: {}, productContent: {}, bookingAndTickets: {}, supplier: { id: 's1', name: 'Supplier 1', photoURL: 's.jpg' } } },
        { id: 'wi2', addedAt: added2, tour: { id: 't2', title: 'Tour B', slug: 'tour-b', status: 'ACTIVE', coverPhoto: 'b.jpg', city: 'Kumasi', country: 'Ghana', averageRating: 4.0, reviewCount: 5, totalBookings: 20, schedulesAndPricing: {}, productContent: {}, bookingAndTickets: {}, supplier: { id: 's2', name: 'Supplier 2', photoURL: null } } },
      ];
      prisma.wishlistItem.findMany.mockResolvedValue(mockItems);

      await controller.getWishlist(req, res, next);

      expect(prisma.wishlistItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'u-1', tour: { status: { not: 'DRAFT' } } }),
          orderBy: { addedAt: 'desc' },
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.results).toBe(2);
      expect(body.data.tours[0]).toEqual(expect.objectContaining({ id: 't1', addedAt: added1 }));
      expect(body.data.tours[1]).toEqual(expect.objectContaining({ id: 't2', addedAt: added2 }));
    });

    it('returns empty array when wishlist is empty', async () => {
      prisma.wishlistItem.findMany.mockResolvedValue([]);

      await controller.getWishlist(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        status: 'success',
        results: 0,
        data: { tours: [] }
      });
    });

    it('drops wishlist items whose tour is missing', async () => {
      prisma.wishlistItem.findMany.mockResolvedValue([
        { id: 'wi1', addedAt: new Date(), tour: null },
      ]);

      await controller.getWishlist(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.tours).toEqual([]);
      expect(body.results).toBe(0);
    });
  });

  // ============================
  // toggleWishlist
  // ============================
  describe('toggleWishlist', () => {
    beforeEach(() => {
      prisma.tour.findFirst.mockResolvedValue({ id: 't1' });
    });

    it('adds tour to wishlist when not present', async () => {
      req.params = { tourId: 't1' };
      prisma.wishlistItem.findUnique.mockResolvedValue(null);
      prisma.wishlistItem.create.mockResolvedValue({ id: 'wi1' });

      await controller.toggleWishlist(req, res, next);

      expect(prisma.tour.findFirst).toHaveBeenCalledWith({
        where: { id: 't1', status: { not: 'DRAFT' } },
        select: { id: true },
      });
      expect(prisma.wishlistItem.create).toHaveBeenCalledWith({
        data: { userId: 'u-1', tourId: 't1' },
      });
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.wishlist_added' }));
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ status: 'success', data: { isWishlisted: true } });
    });

    it('removes tour from wishlist when present', async () => {
      req.params = { tourId: 't1' };
      prisma.wishlistItem.findUnique.mockResolvedValue({ id: 'wi1' });
      prisma.wishlistItem.delete.mockResolvedValue({ id: 'wi1' });

      await controller.toggleWishlist(req, res, next);

      expect(prisma.wishlistItem.delete).toHaveBeenCalledWith({ where: { id: 'wi1' } });
      expect(prisma.wishlistItem.create).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.wishlist_removed' }));
      expect(res.json).toHaveBeenCalledWith({ status: 'success', data: { isWishlisted: false } });
    });

    it('returns 404 when tour not found or DRAFT', async () => {
      req.params = { tourId: 'nonexistent' };
      prisma.tour.findFirst.mockResolvedValue(null);
      await controller.toggleWishlist(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, message: 'Tour not found' }));
    });
  });

  // ============================
  // addWishlist
  // ============================
  describe('addWishlist', () => {
    it('creates a wishlist item idempotently', async () => {
      req.params = { tourId: 't1' };
      prisma.tour.findFirst.mockResolvedValue({ id: 't1' });
      prisma.wishlistItem.findUnique.mockResolvedValue({ id: 'wi1' });

      await controller.addWishlist(req, res, next);

      expect(prisma.tour.findFirst).toHaveBeenCalledWith({
        where: { id: 't1', status: { not: 'DRAFT' } },
        select: { id: true },
      });
      expect(prisma.wishlistItem.create).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ status: 'success', data: { isWishlisted: true } });
    });

    it('creates when not already wishlisted', async () => {
      req.params = { tourId: 't1' };
      prisma.tour.findFirst.mockResolvedValue({ id: 't1' });
      prisma.wishlistItem.findUnique.mockResolvedValue(null);
      prisma.wishlistItem.create.mockResolvedValue({ id: 'wi1' });

      await controller.addWishlist(req, res, next);

      expect(prisma.wishlistItem.create).toHaveBeenCalledWith({
        data: { userId: 'u-1', tourId: 't1' },
      });
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.wishlist_added' }));
    });

    it('returns 404 when tour is DRAFT or missing', async () => {
      req.params = { tourId: 'draft-1' };
      prisma.tour.findFirst.mockResolvedValue(null);
      await controller.addWishlist(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // removeWishlist
  // ============================
  describe('removeWishlist', () => {
    it('deletes the wishlist item', async () => {
      req.params = { tourId: 't1' };
      prisma.wishlistItem.deleteMany.mockResolvedValue({ count: 1 });

      await controller.removeWishlist(req, res, next);

      expect(prisma.wishlistItem.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u-1', tourId: 't1' },
      });
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.wishlist_removed' }));
      expect(res.json).toHaveBeenCalledWith({ status: 'success', data: { isWishlisted: false } });
    });

    it('stays idempotent and does not log when nothing was removed', async () => {
      req.params = { tourId: 't1' };
      prisma.wishlistItem.deleteMany.mockResolvedValue({ count: 0 });

      await controller.removeWishlist(req, res, next);

      expect(logActivity).not.toHaveBeenCalled();
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
