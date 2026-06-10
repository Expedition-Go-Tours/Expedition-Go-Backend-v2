const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

exports.getPermissions = catchAsync(async (req, res, next) => {
  const permissions = await prisma.adminPermission.findMany({
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    include: {
      roles: {
        include: {
          role: { select: { id: true, name: true } },
        },
      },
    },
  });

  const grouped = {};
  for (const perm of permissions) {
    if (!grouped[perm.category]) {
      grouped[perm.category] = [];
    }
    grouped[perm.category].push({
      id: perm.id,
      key: perm.key,
      name: perm.name,
      description: perm.description,
      isSystem: perm.isSystem,
    });
  }

  res.status(200).json({
    status: 'success',
    data: { permissions, grouped },
  });
});

exports.getRoles = catchAsync(async (req, res, next) => {
  const roles = await prisma.adminRole.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { users: true } },
      permissions: {
        include: { permission: true },
        orderBy: { permission: { category: 'asc' } },
      },
    },
  });

  res.status(200).json({
    status: 'success',
    data: roles,
  });
});

exports.getRole = catchAsync(async (req, res, next) => {
  const role = await prisma.adminRole.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { users: true } },
      permissions: {
        include: { permission: true },
        orderBy: { permission: { category: 'asc' } },
      },
    },
  });

  if (!role) {
    return next(new AppError('Role not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: role,
  });
});

exports.createRole = catchAsync(async (req, res, next) => {
  const { name, description, permissionIds } = req.body;

  if (!name || !name.trim()) {
    return next(new AppError('Role name is required', 400));
  }

  const existing = await prisma.adminRole.findUnique({
    where: { name: name.toLowerCase().replace(/\s+/g, '_') },
  });

  if (existing) {
    return next(new AppError('A role with this name already exists', 400));
  }

  const roleName = name.toLowerCase().replace(/\s+/g, '_');

  const role = await prisma.adminRole.create({
    data: {
      name: roleName,
      description: description || '',
      permissions: permissionIds && permissionIds.length > 0
        ? {
            create: permissionIds.map((pid) => ({
              permission: { connect: { id: pid } },
            })),
          }
        : undefined,
    },
    include: {
      _count: { select: { users: true } },
      permissions: {
        include: { permission: true },
      },
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'admin_role.created',
      resource: 'AdminRole',
      resourceId: role.id,
      newValues: { name: roleName, description, permissionIds },
    },
  });

  res.status(201).json({
    status: 'success',
    data: role,
  });
});

exports.updateRole = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name, description, permissionIds } = req.body;

  const role = await prisma.adminRole.findUnique({ where: { id } });

  if (!role) {
    return next(new AppError('Role not found', 404));
  }

  if (role.isSystem) {
    return next(new AppError('System roles cannot be modified', 403));
  }

  const updateData = {};
  if (name && name.trim()) {
    updateData.name = name.toLowerCase().replace(/\s+/g, '_');
  }
  if (description !== undefined) {
    updateData.description = description;
  }

  if (permissionIds) {
    await prisma.adminRolePermission.deleteMany({
      where: { roleId: id },
    });

    if (permissionIds.length > 0) {
      await prisma.adminRolePermission.createMany({
        data: permissionIds.map((pid) => ({
          roleId: id,
          permissionId: pid,
        })),
      });
    }
  }

  const updated = await prisma.adminRole.update({
    where: { id },
    data: updateData,
    include: {
      _count: { select: { users: true } },
      permissions: {
        include: { permission: true },
      },
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'admin_role.updated',
      resource: 'AdminRole',
      resourceId: id,
      oldValues: { name: role.name },
      newValues: updateData,
    },
  });

  res.status(200).json({
    status: 'success',
    data: updated,
  });
});

exports.deleteRole = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const role = await prisma.adminRole.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  });

  if (!role) {
    return next(new AppError('Role not found', 404));
  }

  if (role.isSystem) {
    return next(new AppError('System roles cannot be deleted', 403));
  }

  if (role._count.users > 0) {
    return next(
      new AppError(
        `Cannot delete "${role.name}" — ${role._count.users} admin(s) are assigned to it. Reassign them first.`,
        400,
      ),
    );
  }

  await prisma.adminRolePermission.deleteMany({ where: { roleId: id } });
  await prisma.adminRole.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'admin_role.deleted',
      resource: 'AdminRole',
      resourceId: id,
      oldValues: { name: role.name },
    },
  });

  res.status(200).json({
    status: 'success',
    message: `Role "${role.name}" deleted`,
  });
});
