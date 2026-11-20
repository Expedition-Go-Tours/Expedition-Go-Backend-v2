jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  adminRole: { findUnique: jest.fn() },
  auditLog: { create: jest.fn(), findFirst: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('bcrypt', () => ({ hash: jest.fn(() => Promise.resolve('hashed-password')) }));

jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`) }));
jest.mock('../../middleware/authMiddleware', () => ({ invalidateUserCache: jest.fn() }));

const prisma = require('../../src/core/services/prismaClient');
const { cloudinaryUrl } = require('../../src/core/services/imageOptimizer');
const controller = require('../../src/core/domain/adminUserController');

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
    prisma.user.create.mockResolvedValue({ id: 'u3', name: 'New Admin', email: 'new@t.com', photoURL: '', active: true, roles: ['admin'], adminRoleId: 'r1', adminRole: mockRole });
    prisma.adminRole.findUnique.mockResolvedValue(mockRole);
    prisma.auditLog.create.mockResolvedValue({});
    prisma.auditLog.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation((arg) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg({ $executeRaw: jest.fn().mockResolvedValue(undefined), auditLog: prisma.auditLog });
    });
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
      expect(body.data[0].photoURL).toBe('p.jpg');
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

    it('creates a new admin from an email and password', async () => {
      req.body = { email: 'New.Admin@t.com', name: 'New Admin', password: 'secret123', adminRoleId: 'r1' };
      prisma.user.findUnique.mockResolvedValue(null);

      await controller.addAdmin(req, res, next);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'new.admin@t.com' } });
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'new.admin@t.com',
            name: 'New Admin',
            passwordHash: 'hashed-password',
            roles: ['admin'],
            adminRoleId: 'r1',
            authProvider: 'local',
            emailVerified: true,
          }),
        })
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'admin.created' }) })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('derives a display name when none is supplied', async () => {
      req.body = { email: 'marketing.team@t.com', password: 'secret123', adminRoleId: 'r1' };
      prisma.user.findUnique.mockResolvedValue(null);

      await controller.addAdmin(req, res, next);

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Marketing Team' }) })
      );
    });

    it('requires a password for a new email address', async () => {
      req.body = { email: 'new@t.com', adminRoleId: 'r1' };
      prisma.user.findUnique.mockResolvedValue(null);

      await controller.addAdmin(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid email address', async () => {
      req.body = { email: 'not-an-email', password: 'secret123', adminRoleId: 'r1' };

      await controller.addAdmin(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('rejects a password shorter than eight characters', async () => {
      req.body = { email: 'new@t.com', password: 'short', adminRoleId: 'r1' };
      prisma.user.findUnique.mockResolvedValue(null);

      await controller.addAdmin(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('promotes an existing user by email and replaces the password', async () => {
      req.body = { email: 'u@t.com', password: 'secret123', adminRoleId: 'r1' };
      prisma.user.findUnique.mockResolvedValue(mockUser);

      await controller.addAdmin(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u2' },
          data: expect.objectContaining({
            passwordHash: 'hashed-password',
            roles: { push: 'admin' },
            adminRoleId: 'r1',
          }),
        })
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'admin.granted' }) })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('refuses to add an account that is already an admin', async () => {
      req.body = { email: 'a@t.com', password: 'secret123', adminRoleId: 'r1' };
      prisma.user.findUnique.mockResolvedValue(mockAdmin);

      await controller.addAdmin(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  // ============================
  // updateAdminName
  // ============================
  describe('updateAdminName', () => {
    it('returns 400 when the name is empty', async () => {
      req.params = { id: 'u1' };
      req.body = { name: '   ' };

      await controller.updateAdminName(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('returns 400 when the name is longer than 100 characters', async () => {
      req.params = { id: 'u1' };
      req.body = { name: 'x'.repeat(101) };

      await controller.updateAdminName(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when the user does not exist', async () => {
      req.params = { id: 'nonexistent' };
      req.body = { name: 'New Name' };
      prisma.user.findUnique.mockResolvedValue(null);

      await controller.updateAdminName(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when the account is not an admin', async () => {
      req.params = { id: 'u2' };
      req.body = { name: 'New Name' };
      prisma.user.findUnique.mockResolvedValue(mockUser);

      await controller.updateAdminName(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('renames the admin and records the old and new name', async () => {
      req.params = { id: 'u1' };
      req.body = { name: '  New Name  ' };
      prisma.user.findUnique.mockResolvedValue(mockAdmin);
      prisma.user.update.mockResolvedValue({ ...mockAdmin, name: 'New Name' });

      await controller.updateAdminName(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1' }, data: { name: 'New Name' } })
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'admin.renamed' }) })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('accepts the brand-route parameter name', async () => {
      req.params = { userId: 'u1' };
      req.body = { name: 'Brand Route Name' };
      prisma.user.findUnique.mockResolvedValue(mockAdmin);
      prisma.user.update.mockResolvedValue({ ...mockAdmin, name: 'Brand Route Name' });

      await controller.updateAdminName(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1' }, data: { name: 'Brand Route Name' } })
      );
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
