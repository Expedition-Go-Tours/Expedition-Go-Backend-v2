const prisma = require('../src/core/services/prismaClient');
const catchAsync = require('../src/core/services/catchAsync');
const AppError = require('../src/core/services/appError');
const cache = require('../src/core/services/cacheHelper');
const { hasTeamPermission, toRoleArray } = require('../config/teamPermissions');

const SUPPLIER_CACHE_TTL = 30;

/**
 * A member's roles as an array. `roles` is the source of truth; `role` is the
 * deprecated mirror kept for older rows/deploys.
 */
function memberRolesOf(teamMember) {
  const roles = toRoleArray(teamMember?.roles);
  if (roles.length) return roles;
  return toRoleArray(teamMember?.role);
}

/**
 * Accepted team membership for an email.
 *
 * ALL middleware reads membership through here so the shared cache entry always
 * carries the same fields. Caching a narrower select under this key made a
 * member's permissions depend on which middleware ran first on a route —
 * `resolveSupplier` cached { supplierId } and the role checks then saw no roles.
 */
const TEAM_MEMBER_SELECT = { roles: true, role: true, supplierId: true };

function lookupTeamMember(email) {
  // Membership is keyed by email. Prisma drops `undefined` from a where-clause,
  // so an email-less lookup would match the FIRST accepted member in the table —
  // never fall through to the query without an address to match on.
  if (!email || typeof email !== 'string') return Promise.resolve(null);

  return cache.getOrSet(`team:member:email:${email}`, async () => {
    return prisma.teamMember.findFirst({
      where: { email, status: 'ACCEPTED' },
      select: TEAM_MEMBER_SELECT,
    });
  }, SUPPLIER_CACHE_TTL);
}

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
      req.teamRoles = ['admin'];
      req.teamRole = 'admin';
      req.teamSupplierId = supplierProfile.id;
      req.isOwner = true;
      return next();
    }

    const teamMember = await lookupTeamMember(req.user.email);

    if (!teamMember) {
      return next(new AppError('You are not a team member', 403));
    }

    // Members can hold up to two roles; any one of them can satisfy the route.
    const memberRoles = memberRolesOf(teamMember);
    req.teamRoles = memberRoles;
    req.teamRole = memberRoles[0] || null;
    req.teamSupplierId = teamMember.supplierId;

    if (allowedRoles.length > 0 && !memberRoles.some((role) => allowedRoles.includes(role))) {
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
      req.teamRoles = ['admin'];
      req.teamRole = 'admin';
      req.teamSupplierId = supplierProfile.id;
      req.isOwner = true;
      return next();
    }

    const teamMember = await lookupTeamMember(req.user.email);

    if (!teamMember) {
      return next(new AppError('You are not a team member', 403));
    }

    const memberRoles = memberRolesOf(teamMember);
    req.teamRoles = memberRoles;
    req.teamRole = memberRoles[0] || null;
    req.teamSupplierId = teamMember.supplierId;

    const hasPermission = permissionKeys.some((key) =>
      hasTeamPermission(memberRoles, key)
    );

    if (!hasPermission) {
      return next(new AppError('You do not have permission for this action', 403));
    }

    next();
  });
};

/**
 * The supplier account id behind a user: their own id when they own a supplier
 * profile (or are an admin operating one), the owner's id when they are an
 * accepted team member, and `null` for everyone else (customers, unlinked
 * users). Best-effort and cached, so it is safe to call from non-blocking
 * middleware — `resolveSupplier` turns a `null` into the 403 the guarded
 * routes expect.
 */
async function resolveSupplierIdForUser(user) {
  if (!user) return null;

  const roles = Array.isArray(user.roles) ? user.roles : [];

  if (roles.includes('admin')) {
    const adminProfile = await prisma.supplierProfile.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    return adminProfile ? user.id : null;
  }

  const profile = await cache.getOrSet(`supplier:profile:userId:${user.id}`, async () => {
    return prisma.supplierProfile.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
  }, SUPPLIER_CACHE_TTL);

  if (profile) return user.id;

  const member = await lookupTeamMember(user.email);
  return member ? member.supplierId : null;
}

exports.resolveSupplierIdForUser = resolveSupplierIdForUser;

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

  const supplierId = await resolveSupplierIdForUser(req.user);

  if (!supplierId) {
    if (req.user.roles.includes('admin')) {
      return next(new AppError('No supplier profile linked to this admin account', 403));
    }
    return next(new AppError('Supplier access required', 403));
  }

  req.supplierId = supplierId;
  next();
});
