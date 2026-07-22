const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const cache = require('../utils/cacheHelper');

const ROLE_CACHE_TTL = 60;

exports.requirePermission = (...permissionKeys) => {
  return catchAsync(async (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Not authenticated', 401));
    }

    // Non-admin users pass through (e.g. suppliers/customers on shared routes like chat)
    if (!req.user.roles?.includes('admin')) {
      return next();
    }

    if (!req.user.adminRoleId) {
      return next(new AppError('No admin role assigned. Contact super admin.', 403));
    }

    const role = await cache.getOrSet(`admin:role:${req.user.adminRoleId}`, async () => {
      return prisma.adminRole.findUnique({
        where: { id: req.user.adminRoleId },
        include: {
          permissions: {
            include: { permission: true },
          },
        },
      });
    }, ROLE_CACHE_TTL);

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

    req.user.permissionKeys = role.permissions.map((rp) => rp.permission.key);
    next();
  });
};

exports.requireSuperAdmin = catchAsync(async (req, res, next) => {
  if (!req.user || !req.user.adminRoleId) {
    return next(new AppError('Super admin access required', 403));
  }

  const role = await cache.getOrSet(`admin:role:name:${req.user.adminRoleId}`, async () => {
    return prisma.adminRole.findUnique({
      where: { id: req.user.adminRoleId },
    });
  }, ROLE_CACHE_TTL);

  if (!role || role.name !== 'super_admin') {
    return next(new AppError('Super admin access required', 403));
  }

  next();
});
