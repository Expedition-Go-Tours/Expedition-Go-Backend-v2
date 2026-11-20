const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const bcrypt = require('bcrypt');
const { logActivity } = require('../services/auditLogger');
const { invalidateUserCache } = require('../../../middleware/authMiddleware');

const ADMIN_USER_SELECT = {
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
};

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function nameFromEmail(email) {
  return email
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

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
  const { userId, email: rawEmail, password, name, adminRoleId } = req.body;

  if (!adminRoleId) {
    return next(new AppError('adminRoleId is required', 400));
  }
  if (!userId && !rawEmail) {
    return next(new AppError('Provide a userId or an email address', 400));
  }

  const role = await prisma.adminRole.findUnique({ where: { id: adminRoleId } });
  if (!role) {
    return next(new AppError('Admin role not found', 404));
  }

  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (!userId) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return next(new AppError('Enter a valid email address', 400));
    }
  }

  let user = userId
    ? await prisma.user.findUnique({ where: { id: userId } })
    : await prisma.user.findUnique({ where: { email } });

  if (userId && !user) {
    return next(new AppError('User not found', 404));
  }
  if (user && user.roles.includes('admin')) {
    return next(new AppError('This account is already an admin', 400));
  }
  if (!user && !password) {
    return next(new AppError('A password is required for a new admin', 400));
  }

  let passwordHash;
  if (password !== undefined && password !== null && password !== '') {
    const value = String(password);
    if (value.length < 8) {
      return next(new AppError('Password must be at least 8 characters', 400));
    }
    if (Buffer.byteLength(value, 'utf8') > 72) {
      return next(new AppError('Password must be 72 bytes or fewer', 400));
    }
    passwordHash = await bcrypt.hash(value, 10);
  }

  const created = !user;
  const displayName = String(name || '').trim();

  if (created) {
    user = await prisma.user.create({
      data: {
        name: displayName || nameFromEmail(email),
        email,
        passwordHash,
        roles: ['admin'],
        adminRoleId,
        authProvider: 'local',
        active: true,
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
      select: ADMIN_USER_SELECT,
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(displayName ? { name: displayName } : {}),
        ...(passwordHash ? { passwordHash } : {}),
        roles: { push: 'admin' },
        adminRoleId,
      },
      select: ADMIN_USER_SELECT,
    });
  }

  await logActivity({
    userId: req.user.id,
    userEmail: req.user.email,
    action: created ? 'admin.created' : 'admin.granted',
    resource: 'User',
    resourceId: user.id,
    newValues: { adminRoleId, roleName: role.name, email: user.email },
  });

  invalidateUserCache(user.id);

  res.status(created ? 201 : 200).json({
    status: 'success',
    data: user,
  });
});

exports.updateAdminName = catchAsync(async (req, res, next) => {
  const id = req.params.id || req.params.userId;
  const name = String(req.body?.name || '').trim();

  if (!name) {
    return next(new AppError('Name is required', 400));
  }
  if (name.length > 100) {
    return next(new AppError('Name must be 100 characters or fewer', 400));
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return next(new AppError('User not found', 404));
  }
  if (!user.roles.includes('admin')) {
    return next(new AppError('This account is not an admin', 400));
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { name },
    select: ADMIN_USER_SELECT,
  });

  await logActivity({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'admin.renamed',
    resource: 'User',
    resourceId: id,
    oldValues: { name: user.name },
    newValues: { name },
  });

  invalidateUserCache(id);

  res.status(200).json({
    status: 'success',
    data: updated,
  });
});

exports.updateAdminRole = catchAsync(async (req, res, next) => {
  const id = req.params.id || req.params.userId;
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
  const id = req.params.id || req.params.userId;

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
