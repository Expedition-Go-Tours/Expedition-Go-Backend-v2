const prisma = require('../src/core/services/prismaClient');
const catchAsync = require('../src/core/services/catchAsync');
const AppError = require('../src/core/services/appError');
const cache = require('../src/core/services/cacheHelper');
const { toRoleArray } = require('../config/teamPermissions');
const {
  NOTIFICATION_CATEGORY_KEYS,
  normalizeNotificationCategories,
  permissionsForMember,
  roleNamesForMember,
  hasPermissionInSet,
} = require('../config/permissions');

const SUPPLIER_CACHE_TTL = 30;

function memberRolesOf(teamMember) {
  const roles = toRoleArray(teamMember?.roles);
  if (roles.length) return roles;
  return toRoleArray(teamMember?.role);
}

function mergeUiPreferences(rolePrefs, memberPrefs) {
  const base = rolePrefs && typeof rolePrefs === 'object' ? rolePrefs : {};
  const override = memberPrefs && typeof memberPrefs === 'object' ? memberPrefs : {};
  const merged = { ...base, ...override };
  for (const section of ['dashboard', 'bookings']) {
    if (base[section] || override[section]) {
      merged[section] = { ...(base[section] || {}), ...(override[section] || {}) };
    }
  }
  return merged;
}

function contextForOwner(user, supplierId, supplierProfileId = null) {
  return {
    supplierProfileId,
    isOwner: true,
    isPlatformAdmin: false,
    supplierId,
    systemRoles: ['admin'],
    customRoles: [],
    roleNames: ['Admin'],
    permissions: ['*'],
    landingPath: '/',
    notificationCategories: [...NOTIFICATION_CATEGORY_KEYS],
    uiPreferences: {},
    supplierRoles: Array.isArray(user?.roles) ? user.roles : [],
  };
}

/**
 * Resolve a user's supplier access once per request.
 *
 * Owner → ['*'].
 * Accepted member → system-role permissions ∪ custom-role permissions.
 *
 * The full context is cached for 30s. Role edits and membership changes must
 * invalidate it; teamController does that explicitly.
 */
async function getTeamContextForUser(user) {
  if (!user) return null;

  if (Array.isArray(user.roles) && user.roles.includes('admin')) {
    const profile = await prisma.supplierProfile.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!profile) {
      return {
        isOwner: true,
        isPlatformAdmin: true,
        supplierId: null,
        systemRoles: ['admin'],
        customRoles: [],
        roleNames: ['Admin'],
        permissions: ['*'],
        landingPath: '/',
        notificationCategories: [...NOTIFICATION_CATEGORY_KEYS],
        uiPreferences: {},
        supplierRoles: user.roles,
      };
    }
    return contextForOwner(user, user.id, profile.id);
  }

  const profile = await cache.getOrSet(`supplier:profile:userId:${user.id}`, async () => {
    return prisma.supplierProfile.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
  }, SUPPLIER_CACHE_TTL);

  if (profile) return contextForOwner(user, user.id, profile.id);

  if (!user.email) return null;

  return cache.getOrSet(`team:context:email:${user.email}`, async () => {
    const member = await prisma.teamMember.findFirst({
      where: { email: user.email, status: 'ACCEPTED' },
      select: {
        supplierId: true,
        roles: true,
        role: true,
        landingPath: true,
        notificationCategories: true,
        uiPreferences: true,
        customRoles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
                slug: true,
                permissions: true,
                landingPath: true,
                notificationCategories: true,
                uiPreferences: true,
                isArchived: true,
              },
            },
          },
        },
        supplier: { select: { roles: true } },
      },
    });

    if (!member) return null;

    const systemRoles = memberRolesOf(member);
    const activeCustomRoles = (member.customRoles || [])
      .map((link) => link.role)
      .filter((role) => role && !role.isArchived);

    const permissions = permissionsForMember(
      systemRoles,
      activeCustomRoles.map((role) => role.permissions),
    );

    const memberCategories = normalizeNotificationCategories(member.notificationCategories);
    const roleCategories = activeCustomRoles
      .flatMap((role) => normalizeNotificationCategories(role.notificationCategories));
    const notificationCategories = memberCategories.length
      ? memberCategories
      : (roleCategories.length ? Array.from(new Set(roleCategories)) : [...NOTIFICATION_CATEGORY_KEYS]);

    const rolePrefs = activeCustomRoles.find((role) => role.uiPreferences)?.uiPreferences || null;

    return {
      isOwner: false,
      isPlatformAdmin: false,
      supplierId: member.supplierId,
      supplierProfileId: null,
      systemRoles,
      customRoles: activeCustomRoles.map((role) => ({
        id: role.id,
        name: role.name,
        slug: role.slug,
        permissions: role.permissions,
        landingPath: role.landingPath,
        notificationCategories: role.notificationCategories,
      })),
      roleNames: roleNamesForMember(systemRoles, activeCustomRoles),
      permissions,
      landingPath: member.landingPath || activeCustomRoles.find((role) => role.landingPath)?.landingPath || null,
      notificationCategories,
      uiPreferences: mergeUiPreferences(rolePrefs, member.uiPreferences),
      supplierRoles: Array.isArray(member.supplier?.roles) ? member.supplier.roles : [],
    };
  }, SUPPLIER_CACHE_TTL);
}

function attachContext(req, context) {
  req.teamContext = context;
  req.teamPermissions = context.permissions;
  req.teamRoles = context.systemRoles;
  req.customRoles = context.customRoles;
  req.isOwner = context.isOwner;
  if (context.supplierId) {
    req.supplierId = context.supplierId;
    req.teamSupplierId = context.isOwner ? (context.supplierProfileId || context.supplierId) : context.supplierId;
  }
  return context;
}

exports.getTeamContextForUser = getTeamContextForUser;
exports.attachContext = attachContext;

/**
 * The one refusal a member's role produces, so every route answers it the same
 * way. `code: PERMISSION_DENIED` is stable for clients to branch on (the body
 * carries `code`, never a raw error), and the wording matches `restrictTo` so
 * the dashboard can render a single "you don't have permission" notice no
 * matter which guard refused. "Supplier access required" stays distinct — that
 * is membership, not role, and an owner chasing a role bug over a membership
 * bug is a wasted hour.
 */
function deniedByRole() {
  return new AppError('You do not have permission to perform this action', 403, {
    code: 'PERMISSION_DENIED',
  });
}

/**
 * Legacy role-name guard. New code must use requireTeamPermission. Kept for
 * callers that still pass one of the built-in role names.
 */
exports.requireTeamRole = (...allowedRoles) => {
  return catchAsync(async (req, res, next) => {
    if (!req.user) return next(new AppError('Not authenticated', 401));

    const context = req.teamContext || await getTeamContextForUser(req.user);
    if (!context || !context.supplierId) {
      return next(new AppError('You are not a team member', 403));
    }
    attachContext(req, context);

    if (context.isOwner) return next();

    if (allowedRoles.length > 0 && !context.systemRoles.some((role) => allowedRoles.includes(role))) {
      return next(deniedByRole());
    }
    next();
  });
};

exports.requireTeamPermission = (...permissionKeys) => {
  return catchAsync(async (req, res, next) => {
    if (!req.user) return next(new AppError('Not authenticated', 401));

    const context = req.teamContext || await getTeamContextForUser(req.user);
    if (!context || !context.supplierId) {
      return next(new AppError('You are not a team member', 403));
    }
    attachContext(req, context);

    if (permissionKeys.length === 0) return next();

    const allowed = permissionKeys.some((key) => hasPermissionInSet(context.permissions, key));
    if (!allowed) {
      return next(deniedByRole());
    }
    next();
  });
};

/**
 * Attach the supplier id and the full team context. This is the single place
 * that resolves owner/member, so every downstream controller can use
 * req.teamPermissions without another query.
 */
exports.resolveSupplier = catchAsync(async (req, res, next) => {
  if (!req.user) return next(new AppError('Not authenticated', 401));

  const context = await getTeamContextForUser(req.user);

  if (!context || !context.supplierId) {
    if (Array.isArray(req.user.roles) && req.user.roles.includes('admin')) {
      return next(new AppError('No supplier profile linked to this admin account', 403));
    }
    return next(new AppError('Supplier access required', 403));
  }

  attachContext(req, context);
  next();
});

exports.isSupplierOwner = catchAsync(async (req, res, next) => {
  if (!req.user) return next(new AppError('Not authenticated', 401));

  const context = req.teamContext || await getTeamContextForUser(req.user);
  if (!context || !context.isOwner) {
    return next(new AppError('No supplier profile found', 403));
  }

  attachContext(req, context);
  next();
});

async function resolveSupplierIdForUser(user) {
  if (!user) return null;
  const context = await getTeamContextForUser(user);
  return context?.supplierId || null;
}

exports.resolveSupplierIdForUser = resolveSupplierIdForUser;

/**
 * Realtime chat access must use the same context as HTTP. Otherwise a custom
 * role could be denied chat API calls but still subscribe to conversation
 * rooms over the socket.
 */
async function resolveChatAccessForUser(user) {
  const context = await getTeamContextForUser(user);
  if (!context) return { supplierId: null, viaMembership: false, canChat: true };
  if (context.isOwner) {
    return { supplierId: context.supplierId, viaMembership: false, canChat: true };
  }
  return {
    supplierId: context.supplierId,
    viaMembership: true,
    canChat: hasPermissionInSet(context.permissions, 'chat.view'),
  };
}

exports.resolveChatAccessForUser = resolveChatAccessForUser;
