jest.mock('../../utils/prismaClient', () => ({
  user: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  adminRole: { findUnique: jest.fn() },
  auditLog: { create: jest.fn() },
}));

jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`) }));
jest.mock('../../middleware/authMiddleware', () => ({ invalidateUserCache: jest.fn() }));

const prisma = require('../../utils/prismaClient');
const { cloudinaryUrl } = require('../../utils/imageOptimizer');
const controller = require('../../controllers/adminUserController');

describe('adminUserController', () => {
  let req, res, next;

  const mockAdmin = { id: 'u1', name: 'Admin', email: 'a@t.com', photoURL: 'p.jpg', active: true, lastLoginAt: new Date(), createdAt: new Date(), adminRoleId: 'r1', adminRole: { id: 'r1', name: 'super_admin', description: 'SA' }, roles: ['admin'] };
  const mockRole = { id: 'r1', name: 'super_admin', description: 'Super Admin' };
  const mockUser = { id: 'u2', name: 'User', email: 'u@t.com', roles: ['customer'], adminRoleId: null, photoURL: 'up.jpg', active: true, lastLoginAt: new Date(), createdAt: new Date() };

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'admin-1', email: 'admin@t.com' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    prisma.user.findMany.mockResolvedValue([mockAdmin]);
    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.user.update.mockResolvedValue({ ...mockUser, adminRoleId: 'r1', roles: ['customer', 'admin'], adminRole: mockRole });
    prisma.adminRole.findUnique.mockResolvedValue(mockRole);
    prisma.auditLog.create.mockResolvedValue({});
    cloudinaryUrl.mockImplementation((url, size) => `https://cdn.example.com/${size}/${url}`);
  });

  // ============================
  // getAdminUsers
  // ============================
  describe('getAdminUsers', () => {
    it('returns admin users optimized with cloudinary URLs', async () => {
      await controller.getAdminUsers(req, res, next);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { roles: { has: 'admin' } } })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data[0].photoURL).toBe('https://cdn.example.com/64/p.jpg');
    });
  });

  // ============================
  // addAdmin
  // ============================
  describe('addAdmin', () => {
    it('returns 400 when userId or adminRoleId missing', async () => {
      await controller.addAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when user not found', async () => {
      req.body = { userId: 'nonexistent', adminRoleId: 'r1' };
      prisma.user.findUnique.mockResolvedValue(null);
      await controller.addAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when user is already admin', async () => {
      req.body = { userId: 'u1', adminRoleId: 'r1' };
      prisma.user.findUnique.mockResolvedValue(mockAdmin);
      await controller.addAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when role not found', async () => {
      req.body = { userId: 'u2', adminRoleId: 'nonexistent' };
      prisma.adminRole.findUnique.mockResolvedValue(null);
      await controller.addAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('adds admin role to user', async () => {
      req.body = { userId: 'u2', adminRoleId: 'r1' };
      await controller.addAdmin(req, res, next);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u2' },
          data: expect.objectContaining({ roles: { push: 'admin' }, adminRoleId: 'r1' }),
        })
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'admin.granted' }) }));
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // updateAdminRole
  // ============================
  describe('updateAdminRole', () => {
    it('returns 400 when adminRoleId missing', async () => {
      req.params = { id: 'u1' };
      await controller.updateAdminRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when user not found', async () => {
      req.params = { id: 'nonexistent' };
      req.body = { adminRoleId: 'r1' };
      prisma.user.findUnique.mockResolvedValue(null);
      await controller.updateAdminRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when user is not an admin', async () => {
      req.params = { id: 'u2' };
      req.body = { adminRoleId: 'r2' };
      await controller.updateAdminRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when role not found', async () => {
      req.params = { id: 'u1' };
      req.body = { adminRoleId: 'nonexistent' };
      prisma.user.findUnique.mockResolvedValue(mockAdmin);
      prisma.adminRole.findUnique.mockResolvedValue(null);
      await controller.updateAdminRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('updates admin role', async () => {
      req.params = { id: 'u1' };
      req.body = { adminRoleId: 'r2' };
      prisma.user.findUnique.mockResolvedValue(mockAdmin);
      await controller.updateAdminRole(req, res, next);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1' }, data: { adminRoleId: 'r2' } })
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'admin.role_changed' }) }));
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // revokeAdmin
  // ============================
  describe('revokeAdmin', () => {
    it('returns 400 when revoking own access', async () => {
      req.params = { id: 'admin-1' };
      await controller.revokeAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when user not found', async () => {
      req.params = { id: 'nonexistent' };
      prisma.user.findUnique.mockResolvedValue(null);
      await controller.revokeAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when user is not an admin', async () => {
      req.params = { id: 'u2' };
      await controller.revokeAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('revokes admin access', async () => {
      req.params = { id: 'u1' };
      prisma.user.findUnique.mockResolvedValue(mockAdmin);
      await controller.revokeAdmin(req, res, next);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1' }, data: expect.objectContaining({ roles: [], adminRoleId: null }) })
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'admin.revoked' }) }));
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
