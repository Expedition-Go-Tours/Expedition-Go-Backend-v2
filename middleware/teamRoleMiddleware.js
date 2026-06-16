const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { hasTeamPermission } = require('../config/teamPermissions');

exports.requireTeamRole = (...allowedRoles) => {
  return catchAsync(async (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Not authenticated', 401));
    }

    if (req.user.roles.includes('admin')) {
      return next();
    }

    const supplierProfile = await prisma.supplierProfile.findFirst({
      where: { userId: req.user.id },
      select: { id: true },
    });

    if (supplierProfile) {
      req.teamRole = 'admin';
      req.teamSupplierId = supplierProfile.id;
      req.isOwner = true;
      return next();
    }

    const teamMember = await prisma.teamMember.findFirst({
      where: {
        email: req.user.email,
        status: 'ACCEPTED',
      },
      select: { role: true, supplierId: true },
    });

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

    const supplierProfile = await prisma.supplierProfile.findFirst({
      where: { userId: req.user.id },
      select: { id: true },
    });

    if (supplierProfile) {
      req.teamRole = 'admin';
      req.teamSupplierId = supplierProfile.id;
      req.isOwner = true;
      return next();
    }

    const teamMember = await prisma.teamMember.findFirst({
      where: {
        email: req.user.email,
        status: 'ACCEPTED',
      },
      select: { role: true, supplierId: true },
    });

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

  const supplier = await prisma.supplierProfile.findFirst({
    where: { userId: req.user.id },
    select: { id: true },
  });

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
    return next();
  }

  const profile = await prisma.supplierProfile.findFirst({
    where: { userId: req.user.id },
    select: { id: true },
  });

  if (profile) {
    req.supplierId = req.user.id;
    return next();
  }

  const member = await prisma.teamMember.findFirst({
    where: { email: req.user.email, status: 'ACCEPTED' },
    select: { supplierId: true },
  });

  if (!member) {
    return next(new AppError('Supplier access required', 403));
  }

  req.supplierId = member.supplierId;
  next();
});
