const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

exports.requirePermission = (...permissionKeys) => {
  return catchAsync(async (req, res, next) => {
    if (!req.user || !req.user.roles || !req.user.roles.includes('admin')) {
      return next(new AppError('Admin access required', 403));
    }

    if (!req.user.adminRoleId) {
      return next(new AppError('No admin role assigned. Contact super admin.', 403));
    }

    const role = await prisma.adminRole.findUnique({
      where: { id: req.user.adminRoleId },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    if (!role) {
      return next(new AppError('Admin role not found. Contact super admin.', 403));
    }

    const hasPermission = permissionKeys.some((key) =>
      role.permissions.some((rp) => {
        if (key.endsWith('*')) {
          const prefix = key.slice(0, -1);
          return rp.permission.key.startsWith(prefix);
        }
        return rp.permission.key === key;
      }),
    );

    if (!hasPermission) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }

    next();
  });
};

exports.requireSuperAdmin = catchAsync(async (req, res, next) => {
  if (!req.user || !req.user.adminRoleId) {
    return next(new AppError('Super admin access required', 403));
  }

  const role = await prisma.adminRole.findUnique({
    where: { id: req.user.adminRoleId },
  });

  if (!role || role.name !== 'super_admin') {
    return next(new AppError('Super admin access required', 403));
  }

  next();
});
