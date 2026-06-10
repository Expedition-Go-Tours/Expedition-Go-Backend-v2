jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() },
}));

jest.mock('../../utils/cloudinaryHelper', () => ({ deleteCloudinaryImage: jest.fn() }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`) }));
jest.mock('../../config/firebaseAdmin', () => ({ auth: () => ({ getUser: jest.fn() }) }));

let mockStripeCustomersCreate;
jest.mock('stripe', () => jest.fn(() => ({
  customers: { create: jest.fn((...args) => mockStripeCustomersCreate(...args)) },
})));

const prisma = require('../../utils/prismaClient');
const { deleteCloudinaryImage } = require('../../utils/cloudinaryHelper');
const { logActivity } = require('../../utils/auditLogger');
const { cloudinaryUrl } = require('../../utils/imageOptimizer');
const admin = require('../../config/firebaseAdmin');
const controller = require('../../controllers/userController');

describe('userController', () => {
  let req, res, next;

  const mockUser = {
    id: 'u-1',
    firebaseUid: 'fb-1',
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
    req = { query: {}, params: {}, body: {}, user: { id: 'u-1', ...mockUser }, file: null, firebaseUser: null };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.user.update.mockResolvedValue(mockUser);
    prisma.user.create.mockResolvedValue(mockUser);
    prisma.user.delete.mockResolvedValue(mockUser);
    deleteCloudinaryImage.mockResolvedValue();
    logActivity.mockResolvedValue();
    cloudinaryUrl.mockImplementation((url, size) => `https://cdn.example.com/${size}/${url}`);
    admin.auth = () => ({ getUser: jest.fn().mockResolvedValue({ photoURL: 'fb-photo.jpg' }) });
    mockStripeCustomersCreate = jest.fn().mockResolvedValue({ id: 'cus_123' });
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
      req.file = { path: '/new/photo.jpg' };

      await controller.updateMe(req, res, next);

      expect(deleteCloudinaryImage).toHaveBeenCalledWith('photo.jpg');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ photoURL: '/new/photo.jpg' }) })
      );
    });

    it('skips deleteCloudinaryImage when no existing photo', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...mockUser, photoURL: null });
      req.file = { path: '/new/photo.jpg' };

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
  // toggleWishlist
  // ============================
  describe('toggleWishlist', () => {
    it('adds tour to wishlist', async () => {
      req.params = { tourId: 't1' };
      prisma.user.findUnique.mockResolvedValue({ ...mockUser, wishlist: [] });
      prisma.user.update.mockResolvedValue({ ...mockUser, wishlist: ['t1'] });

      await controller.toggleWishlist(req, res, next);

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
    const firebaseUser = { uid: 'fb-1', email: 'john@test.com', name: 'John Doe', picture: 'pic.jpg' };

    it('returns 400 when no firebase user', async () => {
      await controller.createMe(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns existing user if already in db', async () => {
      req.firebaseUser = firebaseUser;
      await controller.createMe(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates new user with Stripe customer', async () => {
      req.firebaseUser = firebaseUser;
      prisma.user.findUnique.mockResolvedValue(null);

      await controller.createMe(req, res, next);

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            firebaseUid: 'fb-1',
            email: 'john@test.com',
            roles: ['customer'],
            stripeCustomerId: 'cus_123',
          }),
        })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.created' }));
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('creates user without Stripe customer on failure', async () => {
      req.firebaseUser = firebaseUser;
      prisma.user.findUnique.mockResolvedValue(null);
      mockStripeCustomersCreate = jest.fn().mockRejectedValue(new Error('Stripe error'));

      await controller.createMe(req, res, next);

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ stripeCustomerId: undefined }) })
      );
    });

    it('uses fallback name when name not provided', async () => {
      req.firebaseUser = { uid: 'fb-2', email: 'user@test.com', name: null };
      prisma.user.findUnique.mockResolvedValue(null);

      await controller.createMe(req, res, next);

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'user' }) })
      );
    });
  });

  // ============================
  // syncMe
  // ============================
  describe('syncMe', () => {
    it('returns 404 when user not found', async () => {
      req.firebaseUser = { uid: 'fb-none' };
      prisma.user.findUnique.mockResolvedValue(null);

      await controller.syncMe(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, message: expect.stringContaining('User not found') }));
    });

    it('syncs user data from Firebase', async () => {
      req.firebaseUser = { uid: 'fb-1', email: 'john@test.com', name: 'John Updated', picture: 'new-pic.jpg' };

      await controller.syncMe(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'John Updated',
            email: 'john@test.com',
            photoURL: 'new-pic.jpg',
            lastLoginAt: expect.any(Date),
          }),
        })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.synced' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('fetches photo from Firebase when picture is empty', async () => {
      req.firebaseUser = { uid: 'fb-1', email: 'john@test.com', name: 'John', picture: '' };

      await controller.syncMe(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ photoURL: 'fb-photo.jpg' }) })
      );
    });

    it('handles firebase fetch failure gracefully', async () => {
      req.firebaseUser = { uid: 'fb-1', email: 'john@test.com', name: 'John', picture: '' };
      admin.auth = () => ({ getUser: jest.fn().mockRejectedValue(new Error('FB error')) });

      await controller.syncMe(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ photoURL: '' }) })
      );
    });
  });
});
