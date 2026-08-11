const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const cache = require('../utils/cacheHelper');
const { hasTeamPermission } = require('../config/teamPermissions');

const SUPPLIER_CACHE_TTL = 30;

exports.requireTeamRole = (...allowedRoles) => {
  return catchAsync(async (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Not authenticated', 401));
    }

    if (req.user.roles.includes('admin')) {
      return next();
    }

    const supplierProfile = await cache.getOrSet(`supplier:profile:userId:${req.user.id}`, async () => {
      return prisma.supplierProfile.findFirst({
        where: { userId: req.user.id },
        select: { id: true },
      });
    }, SUPPLIER_CACHE_TTL);

    if (supplierProfile) {
      req.teamRole = 'admin';
      req.teamSupplierId = supplierProfile.id;
      req.isOwner = true;
      return next();
    }

    const teamMember = await cache.getOrSet(`team:member:email:${req.user.email}`, async () => {
      return prisma.teamMember.findFirst({
        where: {
          email: req.user.email,
          status: 'ACCEPTED',
        },
        select: { role: true, supplierId: true },
      });
    }, SUPPLIER_CACHE_TTL);

    if (!teamMember) {
      return next(new AppError('You are not a team member', 403));
    }

    req.teamRole = teamMember.role;
    req.teamSupplierId = teamMember.supplierId;

    if (allowedRoles.length > 0 && !allowedRoles.includes(teamMember.role)) {
      return next(new AppError('You do not have permission for this action', 403));
    }

    next();
  });
};

exports.requireTeamPermission = (...permissionKeys) => {
  return catchAsync(async (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Not authenticated', 401));
    }

    if (req.user.roles.includes('admin')) {
      return next();
    }

    const supplierProfile = await cache.getOrSet(`supplier:profile:userId:${req.user.id}`, async () => {
      return prisma.supplierProfile.findFirst({
        where: { userId: req.user.id },
        select: { id: true },
      });
    }, SUPPLIER_CACHE_TTL);

    if (supplierProfile) {
      req.teamRole = 'admin';
      req.teamSupplierId = supplierProfile.id;
      req.isOwner = true;
      return next();
    }

    const teamMember = await cache.getOrSet(`team:member:email:${req.user.email}`, async () => {
      return prisma.teamMember.findFirst({
        where: {
          email: req.user.email,
          status: 'ACCEPTED',
        },
        select: { role: true, supplierId: true },
      });
    }, SUPPLIER_CACHE_TTL);

    if (!teamMember) {
      return next(new AppError('You are not a team member', 403));
    }

    req.teamRole = teamMember.role;
    req.teamSupplierId = teamMember.supplierId;

    const hasPermission = permissionKeys.some((key) =>
      hasTeamPermission(teamMember.role, key)
    );

    if (!hasPermission) {
      return next(new AppError('You do not have permission for this action', 403));
    }

    next();
  });
};

exports.isSupplierOwner = catchAsync(async (req, res, next) => {
  if (!req.user) {
    return next(new AppError('Not authenticated', 401));
  }

  if (req.user.roles.includes('admin')) {
    return next();
  }

  const supplier = await cache.getOrSet(`supplier:profile:userId:${req.user.id}`, async () => {
    return prisma.supplierProfile.findFirst({
      where: { userId: req.user.id },
      select: { id: true },
    });
  }, SUPPLIER_CACHE_TTL);

  if (!supplier) {
    return next(new AppError('No supplier profile found', 403));
  }

  req.isOwner = true;
  req.supplierId = supplier.id;
  next();
});

exports.resolveSupplier = catchAsync(async (req, res, next) => {
  if (!req.user) {
    return next(new AppError('Not authenticated', 401));
  }

  if (req.user.roles.includes('admin')) {
    const profile = await prisma.supplierProfile.findFirst({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!profile) {
      return next(new AppError('No supplier profile linked to this admin account', 403));
    }
    req.supplierId = req.user.id;
    return next();
  }

  const profile = await cache.getOrSet(`supplier:profile:userId:${req.user.id}`, async () => {
    return prisma.supplierProfile.findFirst({
      where: { userId: req.user.id },
      select: { id: true },
    });
  }, SUPPLIER_CACHE_TTL);

  if (profile) {
    req.supplierId = req.user.id;
    return next();
  }

  const member = await cache.getOrSet(`team:member:email:${req.user.email}`, async () => {
    return prisma.teamMember.findFirst({
      where: { email: req.user.email, status: 'ACCEPTED' },
      select: { supplierId: true },
    });
  }, SUPPLIER_CACHE_TTL);

  if (!member) {
    return next(new AppError('Supplier access required', 403));
  }

  req.supplierId = member.supplierId;
  next();
});
