const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { logActivity } = require('../utils/auditLogger');
const { invalidateUserCache } = require('../middleware/authMiddleware');

exports.getAdminUsers = catchAsync(async (req, res, next) => {
  const admins = await prisma.user.findMany({
    where: {
      roles: { has: 'admin' },
    },
    select: {
      id: true,
      name: true,
      email: true,
      photoURL: true,
      active: true,
      lastLoginAt: true,
      createdAt: true,
      adminRoleId: true,
      adminRole: {
        select: {
          id: true,
          name: true,
          description: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const optimized = admins.map((a) => ({
    ...a,
    photoURL: a.photoURL,
  }));

  res.status(200).json({
    status: 'success',
    data: optimized,
  });
});

exports.addAdmin = catchAsync(async (req, res, next) => {
  const { userId, adminRoleId } = req.body;

  if (!userId || !adminRoleId) {
    return next(new AppError('userId and adminRoleId are required', 400));
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return next(new AppError('User not found', 404));
  }

  if (user.roles.includes('admin')) {
    return next(new AppError('User is already an admin', 400));
  }

  const role = await prisma.adminRole.findUnique({ where: { id: adminRoleId } });
  if (!role) {
    return next(new AppError('Admin role not found', 404));
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      roles: { push: 'admin' },
      adminRoleId,
    },
    select: {
      id: true,
      name: true,
      email: true,
      photoURL: true,
      active: true,
      roles: true,
      adminRoleId: true,
      adminRole: {
        select: { id: true, name: true, description: true },
      },
    },
  });

  await logActivity({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'admin.granted',
    resource: 'User',
    resourceId: userId,
    newValues: { adminRoleId, roleName: role.name },
  });

  invalidateUserCache(userId);

  res.status(200).json({
    status: 'success',
    data: { ...updated, photoURL: updated.photoURL },
  });
});

exports.updateAdminRole = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { adminRoleId } = req.body;

  if (!adminRoleId) {
    return next(new AppError('adminRoleId is required', 400));
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return next(new AppError('User not found', 404));
  }
  if (!user.roles.includes('admin')) {
    return next(new AppError('User is not an admin', 400));
  }

  const role = await prisma.adminRole.findUnique({ where: { id: adminRoleId } });
  if (!role) {
    return next(new AppError('Admin role not found', 404));
  }

  const oldRoleId = user.adminRoleId;

  const updated = await prisma.user.update({
    where: { id },
    data: { adminRoleId },
    select: {
      id: true,
      name: true,
      email: true,
      photoURL: true,
      active: true,
      roles: true,
      adminRoleId: true,
      adminRole: {
        select: { id: true, name: true, description: true },
      },
    },
  });

  await logActivity({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'admin.role_changed',
    resource: 'User',
    resourceId: id,
    oldValues: { adminRoleId: oldRoleId },
    newValues: { adminRoleId, roleName: role.name },
  });

  invalidateUserCache(id);

  res.status(200).json({
    status: 'success',
    data: updated,
  });
});

exports.revokeAdmin = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (id === req.user.id) {
    return next(new AppError('You cannot revoke your own admin access', 400));
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return next(new AppError('User not found', 404));
  }
  if (!user.roles.includes('admin')) {
    return next(new AppError('User is not an admin', 400));
  }

  const updatedRoles = user.roles.filter((r) => r !== 'admin');

  const updated = await prisma.user.update({
    where: { id },
    data: {
      roles: updatedRoles,
      adminRoleId: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      roles: true,
      adminRoleId: true,
    },
  });

  await logActivity({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'admin.revoked',
    resource: 'User',
    resourceId: id,
    oldValues: { roles: user.roles, adminRoleId: user.adminRoleId },
    newValues: { roles: updatedRoles },
  });

  invalidateUserCache(id);

  res.status(200).json({
    status: 'success',
    data: updated,
  });
});
