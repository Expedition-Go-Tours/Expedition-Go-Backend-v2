jest.mock('../../utils/prismaClient', () => ({
  adminRole: { findUnique: jest.fn() },
}));

jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  _clearMemory: jest.fn(),
}));

const prisma = require('../../utils/prismaClient');
const middleware = require('../../middleware/permissionMiddleware');

describe('permissionMiddleware', () => {
  let req, res, next;
  const mockRole = {
    id: 'role-1',
    name: 'admin',
    permissions: [
      { permission: { key: 'tours.create' } },
      { permission: { key: 'tours.edit' } },
      { permission: { key: 'users.manage' } },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    req = { user: { id: 'admin-1', roles: ['admin'], adminRoleId: 'role-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    prisma.adminRole.findUnique.mockResolvedValue(mockRole);
  });

  describe('requirePermission', () => {
    it('calls next when user has required permission', async () => {
      const handler = middleware.requirePermission('tours.create');
      await handler(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user.permissionKeys).toEqual(['tours.create', 'tours.edit', 'users.manage']);
    });

    it('matches wildcard permission keys', async () => {
      const handler = middleware.requirePermission('tours.*');
      await handler(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 403 when user lacks required permission', async () => {
      const handler = middleware.requirePermission('settings.manage');
      await handler(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, message: 'You do not have permission to perform this action' }));
    });

    it('passes through when user is not admin', async () => {
      req.user = { id: 'u-1', roles: ['supplier'] };
      const handler = middleware.requirePermission('tours.create');
      await handler(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ statusCode: expect.any(Number) }));
    });

    it('returns 403 when admin role not assigned', async () => {
      req.user = { id: 'admin-1', roles: ['admin'] };
      const handler = middleware.requirePermission('tours.create');
      await handler(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, message: 'No admin role assigned. Contact super admin.' }));
    });

    it('returns 403 when admin role not found in DB', async () => {
      prisma.adminRole.findUnique.mockResolvedValue(null);
      const handler = middleware.requirePermission('tours.create');
      await handler(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, message: 'Admin role not found. Contact super admin.' }));
    });
  });

  describe('requireSuperAdmin', () => {
    it('calls next when role is super_admin', async () => {
      prisma.adminRole.findUnique.mockResolvedValue({ id: 'role-1', name: 'super_admin' });
      await middleware.requireSuperAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 403 when role is not super_admin', async () => {
      await middleware.requireSuperAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('returns 403 when no adminRoleId', async () => {
      req.user = { id: 'admin-1' };
      await middleware.requireSuperAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });
  });
});
