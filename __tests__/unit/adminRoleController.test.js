jest.mock('../../utils/prismaClient', () => ({
  adminPermission: { findMany: jest.fn() },
  adminRole: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  adminRolePermission: { deleteMany: jest.fn(), createMany: jest.fn() },
  auditLog: { create: jest.fn(), findFirst: jest.fn() },
  $transaction: jest.fn(),
}));

const prisma = require('../../utils/prismaClient');
const controller = require('../../controllers/adminRoleController');

describe('adminRoleController', () => {
  let req, res, next;

  const mockPermissions = [
    { id: 'p1', key: 'users.manage', name: 'Manage Users', category: 'Users', description: 'desc', isSystem: false, roles: [{ role: { id: 'r1', name: 'admin' } }] },
  ];
  const mockRole = {
    id: 'r1',
    name: 'editor',
    description: 'Editor role',
    isSystem: false,
    _count: { users: 0 },
    permissions: [{ permission: { id: 'p1', key: 'users.manage', name: 'Manage Users', category: 'Users', description: 'desc', isSystem: false } }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'admin-1', email: 'admin@t.com' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    prisma.adminPermission.findMany.mockResolvedValue(mockPermissions);
    prisma.adminRole.findMany.mockResolvedValue([mockRole]);
    prisma.adminRole.findUnique.mockResolvedValue(mockRole);
    prisma.adminRole.create.mockResolvedValue(mockRole);
    prisma.adminRole.update.mockResolvedValue(mockRole);
    prisma.adminRole.delete.mockResolvedValue(mockRole);
    prisma.adminRolePermission.deleteMany.mockResolvedValue({ count: 0 });
    prisma.adminRolePermission.createMany.mockResolvedValue({ count: 0 });
    prisma.auditLog.create.mockResolvedValue({});
    prisma.auditLog.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation((arg) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg({ $executeRaw: jest.fn().mockResolvedValue(undefined), auditLog: prisma.auditLog });
    });
  });

  // ============================
  // getPermissions
  // ============================
  describe('getPermissions', () => {
    it('returns grouped permissions', async () => {
      await controller.getPermissions(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ permissions: expect.any(Array), grouped: expect.any(Object) }),
        })
      );
    });

    it('groups permissions by category', async () => {
      await controller.getPermissions(req, res, next);
      const body = res.json.mock.calls[0][0];
      expect(body.data.grouped.Users).toBeDefined();
      expect(body.data.grouped.Users).toHaveLength(1);
    });
  });

  // ============================
  // getRoles
  // ============================
  describe('getRoles', () => {
    it('returns all roles', async () => {
      await controller.getRoles(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: [mockRole] }));
    });
  });

  // ============================
  // getRole
  // ============================
  describe('getRole', () => {
    it('returns a role by id', async () => {
      req.params = { id: 'r1' };
      await controller.getRole(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: mockRole }));
    });

    it('returns 404 for non-existent role', async () => {
      req.params = { id: 'nonexistent' };
      prisma.adminRole.findUnique.mockResolvedValue(null);
      await controller.getRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ============================
  // createRole
  // ============================
  describe('createRole', () => {
    it('returns 400 if name is missing', async () => {
      await controller.createRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 if role name already exists', async () => {
      req.body = { name: 'editor' };
      prisma.adminRole.findUnique.mockResolvedValue(mockRole);
      await controller.createRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('creates role without permissions', async () => {
      req.body = { name: 'viewer' };
      prisma.adminRole.findUnique.mockResolvedValue(null);
      await controller.createRole(req, res, next);
      expect(prisma.adminRole.create).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'admin_role.created' }) }));
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('creates role with permissions', async () => {
      req.body = { name: 'viewer', permissionIds: ['p1', 'p2'] };
      prisma.adminRole.findUnique.mockResolvedValue(null);
      await controller.createRole(req, res, next);
      expect(prisma.adminRole.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            permissions: expect.objectContaining({
              create: expect.arrayContaining([
                expect.objectContaining({ permission: { connect: { id: 'p1' } } }),
              ]),
            }),
          }),
        })
      );
    });
  });

  // ============================
  // updateRole
  // ============================
  describe('updateRole', () => {
    it('returns 404 for non-existent role', async () => {
      req.params = { id: 'nonexistent' };
      prisma.adminRole.findUnique.mockResolvedValue(null);
      await controller.updateRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 403 for system roles', async () => {
      req.params = { id: 'r1' };
      prisma.adminRole.findUnique.mockResolvedValue({ ...mockRole, isSystem: true });
      await controller.updateRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('updates role name and description', async () => {
      req.params = { id: 'r1' };
      req.body = { name: 'Senior Editor', description: 'Updated', permissionIds: [] };
      await controller.updateRole(req, res, next);
      expect(prisma.adminRole.update).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'admin_role.updated' }) }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('replaces permissions when permissionIds provided', async () => {
      req.params = { id: 'r1' };
      req.body = { permissionIds: ['p1'] };
      await controller.updateRole(req, res, next);
      expect(prisma.adminRolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 'r1' } });
      expect(prisma.adminRolePermission.createMany).toHaveBeenCalled();
    });
  });

  // ============================
  // deleteRole
  // ============================
  describe('deleteRole', () => {
    it('returns 404 for non-existent role', async () => {
      req.params = { id: 'nonexistent' };
      prisma.adminRole.findUnique.mockResolvedValue(null);
      await controller.deleteRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 403 for system roles', async () => {
      req.params = { id: 'r1' };
      prisma.adminRole.findUnique.mockResolvedValue({ ...mockRole, isSystem: true });
      await controller.deleteRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('returns 400 when role has users assigned', async () => {
      req.params = { id: 'r1' };
      prisma.adminRole.findUnique.mockResolvedValue({ ...mockRole, _count: { users: 3 } });
      await controller.deleteRole(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('deletes role successfully', async () => {
      req.params = { id: 'r1' };
      await controller.deleteRole(req, res, next);
      expect(prisma.adminRolePermission.deleteMany).toHaveBeenCalled();
      expect(prisma.adminRole.delete).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'admin_role.deleted' }) }));
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
