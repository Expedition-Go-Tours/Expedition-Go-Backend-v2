const bcrypt = require('bcrypt');
const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const crypto = require('crypto');
const cache = require('../services/cacheHelper');
const { invalidateUserCache } = require('../../../middleware/authMiddleware');
const { signAccessToken, signRefreshToken } = require('../../../config/jwt');
const { storeRefreshToken } = require('../services/refreshTokenHelper');
const { sendTeamInviteEmail, sendTeamInviteRevokedEmail, resolveEmailBrand } = require('../services/emailService');
const emailUrls = require('../../../config/emailUrls');
const { enqueueNotification } = require('../services/queue');
const { logActivity } = require('../services/auditLogger');
const logger = require('../services/logger');
const supplierBookingService = require('../services/supplierBookingService');
const {
  MAX_TEAM_ROLES,
  normalizeTeamRoles,
  permissionsForRoles,
  toRoleArray,
  TEAM_ROLE_LABELS,
  TEAM_ROLE_SUMMARIES,
  TEAM_ROLE_PERMISSIONS,
  VALID_TEAM_ROLES,
} = require('../../../config/teamPermissions');
const {
  PERMISSIONS,
  PERMISSION_GROUPS,
  NOTIFICATION_CATEGORIES,
  normalizePermissions,
  normalizeNotificationCategories,
  canGrantPermissions,
  permissionsForMember,
  roleNamesForMember,
} = require('../../../config/permissions');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEAM_SIZE = parseInt(process.env.MAX_TEAM_SIZE, 10) || 50;
// Seven days. A working week covers holidays and the "I'll do it on Monday"
// gap that made the old 48-hour links expire before people opened them.
const INVITE_TTL_HOURS = 7 * 24;
const PASSWORD_MIN_LENGTH = 8;
// bcrypt silently truncates input beyond 72 bytes. Rejecting it is clearer
// than accepting a passphrase whose tail is ignored.
const PASSWORD_MAX_BYTES = 72;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

function passwordError(password) {
  if (typeof password !== 'string' || password.length === 0) return 'Please choose a password';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return `Password must be ${PASSWORD_MAX_BYTES} bytes or fewer`;
  }
  return null;
}

// Brand roles a team member inherits from the supplier they join, so brand
// context (chat, email identity, dashboard links) matches the owner's.
// 'expedition' is deliberately absent: it means "takes DIRECT bookings on
// Expedition Go" (adminController.toggleSupplierExpeditionRole) and is not a
// label a member should inherit.
const BRAND_ROLES = ['ghana', 'africa'];

// Which storefronts the business is live on, read from the OWNER's brand roles
// (config/brands.js). Never a member's own roles — BRAND_ROLES above does not
// carry 'expedition', so a member's array can say nothing about Expedition.
// Order is the menu order: Travio Ghana first.
const STOREFRONT_ROLE_MAP = { ghana: 'GHANA', expedition: 'EXPEDITION' };
const storefrontsFor = (roles) =>
  Array.isArray(roles)
    ? Object.keys(STOREFRONT_ROLE_MAP)
        .filter((role) => roles.includes(role))
        .map((role) => STOREFRONT_ROLE_MAP[role])
    : [];

/**
 * Whether supplier-created bookings (and offline collection) are switched on
 * for this business.
 *
 * This is the server's own answer, read through the same `isFeatureEnabled` the
 * create path enforces with, so the dashboard cannot advertise a capability
 * that would then be refused at the server. The flag is per brand
 * (`feature.supplierCreatedBookings.<brand>`); a business is only offered the
 * feature when a brand it actually holds is enabled.
 *
 * A team member inherits the owner's brand roles, so they inherit this answer
 * too — a supplier member's own roles carry no brand and must not be read here.
 */
async function supplierCreatedBookingsFor(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return false;
  const enabled = await Promise.all(
    Object.keys(STOREFRONT_ROLE_MAP)
      .filter((role) => roles.includes(role))
      .map((role) => supplierBookingService.isFeatureEnabled(role)),
  );
  return enabled.includes(true);
}

/**
 * Team members accept with a plain account (`roles: ['customer']` is the signup
 * default), so membership must not depend on already holding `supplier`. On
 * accept we mirror the owner's roles onto them. The auth cache is invalidated
 * because the SPA loads the dashboard immediately after accepting.
 */
async function grantMemberRoles({ userId, supplierId, email }) {
  const [owner, user] = await Promise.all([
    prisma.user.findUnique({ where: { id: supplierId }, select: { roles: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { roles: true } }),
  ]);

  const inherited = ['supplier', ...((owner?.roles || []).filter((role) => BRAND_ROLES.includes(role)))];
  const nextRoles = Array.from(new Set([...(user?.roles || []), ...inherited]));

  const changed = nextRoles.length !== (user?.roles || []).length;
  if (changed) {
    await prisma.user.update({ where: { id: userId }, data: { roles: nextRoles } });
    invalidateUserCache(userId);
  }

  // The member lookup is cached per email (teamRoleMiddleware); a stale "no
  // member" entry would keep them locked out for the cache TTL.
  await cache.invalidateKey(`team:member:email:${email}`).catch(() => {});

  return { roles: nextRoles, changed };
}

/** Drop `supplier`/brand roles a removed member inherited, when they are not
 *  a supplier in their own right. */
async function revokeMemberRoles({ userId, email }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { roles: true, supplierProfile: { select: { id: true } } },
  });
  if (!user || user.supplierProfile) return;

  const nextRoles = (user.roles || []).filter((role) => role !== 'supplier' && !BRAND_ROLES.includes(role));
  if (nextRoles.length === (user.roles || []).length) return;

  await prisma.user.update({ where: { id: userId }, data: { roles: nextRoles } });
  invalidateUserCache(userId);
  await cache.invalidateKey(`team:member:email:${email}`).catch(() => {});
}

/**
 * A member's roles as an array. `roles` is the source of truth; `role` is the
 * deprecated single-role mirror kept for older rows and rollbacks.
 */
function rolesOf(member) {
  const roles = toRoleArray(member?.roles);
  return roles.length ? roles : toRoleArray(member?.role);
}

function customRolesOf(member) {
  return (member?.customRoles || [])
    .map((link) => link?.role)
    .filter((role) => role && !role.isArchived);
}

function roleViewsFor(systemRoles, customRoles) {
  return [
    ...toRoleArray(systemRoles).map((role) => ({
      key: role,
      label: TEAM_ROLE_LABELS[role] || role,
      summary: TEAM_ROLE_SUMMARIES[role] || '',
    })),
    ...(customRoles || []).map((role) => ({
      key: `custom:${role.id}`,
      label: role.name,
      summary: role.description || 'Custom access',
    })),
  ];
}

/**
 * The member shape every endpoint returns. `role` stays for older clients that
 * have not shipped multi-role support yet; `roles` and `customRoles` are what
 * new code reads.
 */
function memberPayload(member) {
  const roles = rolesOf(member);
  const customRoles = customRolesOf(member);
  const permissions = permissionsForMember(
    roles,
    customRoles.map((role) => role.permissions),
  );
  return {
    id: member.id,
    email: member.email,
    role: roles[0] || customRoles[0]?.slug || null,
    roles,
    customRoles: customRoles.map((role) => ({
      id: role.id,
      name: role.name,
      slug: role.slug,
      description: role.description || null,
    })),
    roleNames: roleNamesForMember(roles, customRoles),
    permissions,
    landingPath: member.landingPath || customRoles.find((role) => role.landingPath)?.landingPath || null,
    notificationCategories: normalizeNotificationCategories(member.notificationCategories),
    uiPreferences: member.uiPreferences || null,
    status: member.status,
    acceptedAt: member.acceptedAt ?? null,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

/**
 * Distinct account states for an invitation. Kept in one place so the invite
 * endpoints report the same thing whether the link is opened before or after
 * the expiry cleanup ran (which nulls the token).
 */
function inviteStateError(member) {
  if (member.status === 'EXPIRED') {
    return new AppError('Invitation has expired', 410);
  }
  if (member.tokenExpiresAt && member.tokenExpiresAt < new Date()) {
    return new AppError('Invitation has expired', 410);
  }
  if (member.status === 'ACCEPTED') {
    return new AppError('Invitation has already been accepted', 409);
  }
  if (member.status === 'REVOKED') {
    return new AppError('Invitation has been revoked', 410);
  }
  return null;
}

/**
 * A login can belong to one business, and a supplier owner is never a member
 * of somebody else's business. Both rules are enforced here so the invite,
 * accept and register paths cannot drift apart.
 *
 * Skipping the supplier-owner check is the subtle bug: the owner's dashboard
 * resolves the supplier profile before membership, so an owner who accepted an
 * invitation would silently land on their own dashboard and never see the team
 * they supposedly joined.
 */
async function assertEmailCanJoinTeam({ email, supplierId }) {
  const account = await prisma.user.findUnique({
    where: { email },
    select: { id: true, supplierProfile: { select: { id: true } } },
  });

  if (account?.supplierProfile) {
    throw new AppError(
      'That email belongs to a supplier account. A supplier owner cannot join another business as a team member.',
      409,
      { code: 'SUPPLIER_ACCOUNT' },
    );
  }

  const otherMembership = await prisma.teamMember.findFirst({
    where: { email, status: 'ACCEPTED', supplierId: { not: supplierId } },
    select: { supplier: { select: { name: true } } },
  });

  if (otherMembership) {
    const business = otherMembership.supplier?.name || 'another business';
    throw new AppError(
      `That email is already a team member at ${business}. A login can belong to one business at a time.`,
      409,
      { code: 'MEMBER_OF_ANOTHER_SUPPLIER' },
    );
  }

  return account;
}

/** The atomic part of accepting: only a still-pending, still-valid token wins. */
async function consumeInviteToken({ memberId, token }) {
  return prisma.teamMember.updateMany({
    where: {
      id: memberId,
      inviteToken: token,
      status: 'PENDING',
      OR: [{ tokenExpiresAt: { gt: new Date() } }, { tokenExpiresAt: null }],
    },
    data: {
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      inviteToken: null,
      tokenExpiresAt: null,
    },
  });
}

/** Re-read the row so a failed race reports the real state, not a guess. */
async function inviteRaceError(memberId) {
  const current = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: { status: true, tokenExpiresAt: true },
  });
  if (!current) {
    return new AppError(
      'This invitation is no longer available. Ask the business owner to send a new one.',
      410,
      { code: 'INVITE_UNAVAILABLE' },
    );
  }
  return inviteStateError(current) || new AppError(
    'This invitation is no longer available. Ask the business owner to send a new one.',
    409,
    { code: 'INVITE_ALREADY_USED' },
  );
}

/** Shared shape for the two responses that sign a new member straight in. */
function memberSessionPayload({ user, accessToken, refreshToken, member }) {
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      photoURL: user.photoURL || '',
      roles: user.roles,
      hasPassword: Boolean(user.passwordHash),
    },
    accessToken,
    refreshToken,
    member: memberPayload(member),
    landingPath: member.landingPath || null,
  };
}

exports.cleanupExpiredInvites = catchAsync(async (req, res) => {
  const { count } = await prisma.teamMember.updateMany({
    where: {
      status: 'PENDING',
      tokenExpiresAt: { lt: new Date() },
    },
    data: {
      status: 'EXPIRED',
      inviteToken: null,
      tokenExpiresAt: null,
    },
  });

  res.status(200).json({
    status: 'success',
    message: `${count} expired invitation(s) cleaned up`,
    data: { cleanedCount: count },
  });
});

exports.getMyTeamRole = catchAsync(async (req, res) => {
  const context = await require('../../../middleware/teamRoleMiddleware').getTeamContextForUser(req.user);

  if (!context) {
    return res.status(200).json({
      status: 'success',
      data: {
        role: null,
        roles: [],
        customRoles: [],
        roleNames: [],
        permissions: [],
        isOwner: false,
        storefronts: [],
        supplierCreatedBookings: false,
        landingPath: null,
        notificationCategories: [],
        uiPreferences: {},
      },
    });
  }

  const data = {
    role: context.systemRoles[0] || context.customRoles[0]?.slug || null,
    roles: context.systemRoles,
    customRoles: context.customRoles,
    roleNames: context.roleNames,
    permissions: context.permissions,
    isOwner: context.isOwner,
    supplierId: context.supplierId,
    landingPath: context.landingPath,
    notificationCategories: context.notificationCategories,
    uiPreferences: context.uiPreferences,
    storefronts: storefrontsFor(context.supplierRoles),
    supplierCreatedBookings: await supplierCreatedBookingsFor(context.supplierRoles),
  };

  res.status(200).json({ status: 'success', data });
});

exports.getMembers = catchAsync(async (req, res) => {
  const { status } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 50), 200);
  const where = { supplierId: req.supplierId };
  if (status) where.status = status;

  const skip = (page - 1) * limit;

  const [members, totalCount] = await Promise.all([
    prisma.teamMember.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        email: true,
        role: true,
        roles: true,
        status: true,
        invitedById: true,
        acceptedAt: true,
        landingPath: true,
        notificationCategories: true,
        uiPreferences: true,
        createdAt: true,
        updatedAt: true,
        customRoles: {
          select: {
            role: {
              select: { id: true, name: true, slug: true, description: true, permissions: true, landingPath: true, notificationCategories: true, uiPreferences: true, isArchived: true },
            },
          },
        },
      },
    }),
    prisma.teamMember.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    results: members.length,
    data: {
      members: members.map(memberPayload),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        totalCount,
        limit,
      },
    },
  });
});

const RESERVED_ROLE_SLUGS = new Set([...VALID_TEAM_ROLES, 'owner', 'system', 'member', 'custom']);

function slugifyRoleName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)));
}

async function loadCustomRoles(supplierId, ids) {
  const unique = uniqueStrings(ids);
  if (!unique.length) return [];
  return prisma.teamRole.findMany({
    where: { supplierId, id: { in: unique }, isArchived: false },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      permissions: true,
      landingPath: true,
      notificationCategories: true,
      uiPreferences: true,
    },
  });
}

/**
 * Validate a system-role + custom-role assignment.
 *
 * The union of every role must be grantable by the actor. Owners bypass the
 * subset check; delegated managers may not hand out access they do not hold.
 */
async function normalizeAssignment({ supplierId, body, actorContext, allowEmpty = false }) {
  const rawRoles = toRoleArray(body?.roles !== undefined && body?.roles !== null ? body.roles : body?.role);
  const customRoleIds = uniqueStrings(body?.customRoleIds);

  if (!allowEmpty && rawRoles.length === 0 && customRoleIds.length === 0) {
    return { error: 'Select at least one role' };
  }
  if (rawRoles.length + customRoleIds.length > MAX_TEAM_ROLES) {
    return { error: `A team member can hold at most ${MAX_TEAM_ROLES} roles` };
  }

  let systemRoles = [];
  if (rawRoles.length) {
    const normalized = normalizeTeamRoles({ roles: rawRoles });
    if (normalized.error) return { error: normalized.error };
    systemRoles = normalized.roles;
  }

  if (systemRoles.includes('admin') && customRoleIds.length) {
    return { error: 'Admin already includes every permission, so it cannot be combined with a custom role' };
  }

  const customRoles = await loadCustomRoles(supplierId, customRoleIds);
  if (customRoles.length !== customRoleIds.length) {
    return { error: 'One or more selected roles no longer exist. Refresh the page and try again.' };
  }

  const requestedPermissions = [
    ...systemRoles.flatMap((role) => permissionsForRoles([role])),
    ...customRoles.flatMap((role) => role.permissions || []),
  ];

  const grant = canGrantPermissions(actorContext?.permissions || [], requestedPermissions, {
    isOwner: Boolean(actorContext?.isOwner),
  });
  if (!grant.ok) return { error: grant.error };

  return { systemRoles, customRoles, customRoleIds };
}

async function syncMemberCustomRoles(tx, memberId, customRoleIds) {
  await tx.teamMemberRole.deleteMany({ where: { memberId } });
  if (customRoleIds.length) {
    await tx.teamMemberRole.createMany({
      data: customRoleIds.map((roleId) => ({ memberId, roleId })),
    });
  }
}

const MEMBER_PAYLOAD_SELECT = {
  id: true,
  email: true,
  role: true,
  roles: true,
  status: true,
  invitedById: true,
  acceptedAt: true,
  landingPath: true,
  notificationCategories: true,
  uiPreferences: true,
  createdAt: true,
  updatedAt: true,
  customRoles: {
    select: {
      role: {
        select: {
          id: true, name: true, slug: true, description: true, permissions: true,
          landingPath: true, notificationCategories: true, uiPreferences: true, isArchived: true,
        },
      },
    },
  },
};

async function reloadMember(memberId) {
  return prisma.teamMember.findUnique({ where: { id: memberId }, select: MEMBER_PAYLOAD_SELECT });
}

async function invalidateMemberContext(email) {
  if (!email) return;
  await Promise.all([
    cache.invalidateKey(`team:context:email:${email}`).catch(() => {}),
    cache.invalidateKey(`team:member:email:${email}`).catch(() => {}),
  ]);
}

function emitTeamSocketEvent(userIds, event) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  try {
    const app = require('../../../app');
    const io = app.get('io');
    if (!io) return;
    for (const userId of userIds) {
      io.to(`user:${userId}`).emit(event);
    }
  } catch {
    // Socket is best-effort; the next focus/visibility refetch still applies.
  }
}

async function userIdsForSupplierMembers(supplierId) {
  const members = await prisma.teamMember.findMany({
    where: { supplierId, status: 'ACCEPTED' },
    select: { email: true },
  });
  const emails = members.map((member) => member.email).filter(Boolean);
  if (!emails.length) return [];
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  return users.map((user) => user.id);
}

async function invalidateSupplierContexts(supplierId) {
  const members = await prisma.teamMember.findMany({
    where: { supplierId },
    select: { email: true },
  });
  await Promise.all(members.map((member) => invalidateMemberContext(member.email)));
}

exports.inviteMember = catchAsync(async (req, res, next) => {
  const { directAdd } = req.body;
  const email = normalizeEmail(req.body.email);

  // Legacy alias for POST /settings/team/direct-add — keep one implementation.
  if (directAdd) {
    return exports.directAddMember(req, res, next);
  }

  if (!email) return next(new AppError('Email is required', 400));
  if (!EMAIL_REGEX.test(email)) return next(new AppError('Please provide a valid email address', 400));

  if (email === normalizeEmail(req.user.email)) {
    return next(new AppError('You cannot invite yourself to your own team.', 400, { code: 'SELF_INVITE' }));
  }

  // Reject up front instead of letting the invitee discover the problem after
  // they have clicked the link and chosen a password.
  await assertEmailCanJoinTeam({ email, supplierId: req.supplierId });

  const assignment = await normalizeAssignment({
    supplierId: req.supplierId,
    body: req.body,
    actorContext: req.teamContext,
  });
  if (assignment.error) return next(new AppError(assignment.error, 400));

  const { systemRoles, customRoles, customRoleIds } = assignment;

  const member = await prisma.$transaction(async (tx) => {
    const [acceptedCount, pendingCount] = await Promise.all([
      tx.teamMember.count({ where: { supplierId: req.supplierId, status: 'ACCEPTED' } }),
      tx.teamMember.count({ where: { supplierId: req.supplierId, status: 'PENDING' } }),
    ]);

    if (acceptedCount + pendingCount >= MAX_TEAM_SIZE) {
      throw new AppError(`Team size limit of ${MAX_TEAM_SIZE} reached (including pending invitations)`, 400);
    }

    const existing = await tx.teamMember.findUnique({
      where: { supplierId_email: { supplierId: req.supplierId, email } },
    });

    if (existing) {
      if (existing.status === 'PENDING') throw new AppError('An invitation has already been sent to this email', 400);
      if (existing.status === 'ACCEPTED') throw new AppError('This user is already a team member', 400);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    const row = existing
      ? await tx.teamMember.update({
        where: { id: existing.id },
        data: {
          roles: systemRoles,
          role: systemRoles[0] || customRoles[0]?.slug || 'custom',
          status: 'PENDING',
          invitedById: req.user.id,
          inviteToken: token,
          tokenExpiresAt: expiresAt,
        },
      })
      : await tx.teamMember.create({
        data: {
          supplierId: req.supplierId,
          email,
          roles: systemRoles,
          role: systemRoles[0] || customRoles[0]?.slug || 'custom',
          invitedById: req.user.id,
          inviteToken: token,
          tokenExpiresAt: expiresAt,
        },
      });

    await syncMemberCustomRoles(tx, row.id, customRoleIds);
    return row;
  });

  const saved = await reloadMember(member.id);
  const inviteUrl = `${emailUrls.dashboardBaseForUser(req.user)}/team/invite?token=${member.inviteToken}`;
  const supplier = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { name: true },
  });

  let emailSent = true;
  try {
    await sendTeamInviteEmail({
      to: email,
      supplierName: supplier?.name || 'A supplier',
      roles: roleViewsFor(systemRoles, customRoles),
      inviteUrl,
      invitedBy: req.user.name || 'Your supplier',
      invitedByEmail: req.user.email,
      expiresInHours: INVITE_TTL_HOURS,
      brandKey: resolveEmailBrand({ user: req.user }),
    });
  } catch (error) {
    emailSent = false;
    logger.error(`[team] invite email failed for ${email}:`, error?.message);
  }

  await invalidateMemberContext(email);

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_sent',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: {
      email,
      roles: systemRoles,
      customRoles: customRoles.map((role) => ({ id: role.id, name: role.name })),
      emailSent,
    },
    source: 'web',
  });

  res.status(201).json({
    status: 'success',
    message: emailSent
      ? `Invitation sent to ${email}`
      : `Invitation created for ${email}, but the email could not be sent. Use Resend to try again.`,
    data: { emailSent, member: memberPayload(saved || member) },
  });
});

exports.getInviteDetails = catchAsync(async (req, res, next) => {
  const { token } = req.params;

  const member = await prisma.teamMember.findUnique({
    where: { inviteToken: token },
    include: {
      supplier: {
        select: { name: true, email: true },
      },
      invitedBy: {
        select: { name: true },
      },
      customRoles: {
        select: {
          role: {
            select: { id: true, name: true, slug: true, description: true, permissions: true, isArchived: true },
          },
        },
      },
    },
  });

  if (!member) {
    return next(new AppError('Invitation not found', 404));
  }

  const stateError = inviteStateError(member);
  if (stateError) return next(stateError);

  const systemRoles = rolesOf(member);
  const customRoles = customRolesOf(member);
  const invitedEmail = normalizeEmail(member.email);

  // The token proves control of this inbox, so telling the holder whether an
  // account already exists leaks nothing they cannot learn by trying to sign
  // in. It lets the page pick the right door before asking for a password.
  const account = await prisma.user.findUnique({
    where: { email: invitedEmail },
    select: { id: true, passwordHash: true },
  });

  res.status(200).json({
    status: 'success',
    data: {
      supplierName: member.supplier.name,
      invitedByName: member.invitedBy?.name || null,
      role: systemRoles[0] || customRoles[0]?.slug || null,
      roles: systemRoles,
      customRoles: customRoles.map((role) => ({
        id: role.id,
        name: role.name,
        slug: role.slug,
        description: role.description || null,
      })),
      roleNames: roleNamesForMember(systemRoles, customRoles),
      roleViews: roleViewsFor(systemRoles, customRoles),
      invitedEmail,
      status: member.status,
      expiresAt: member.tokenExpiresAt,
      accountExists: Boolean(account),
      accountHasPassword: Boolean(account?.passwordHash),
    },
  });
});

exports.acceptInvite = catchAsync(async (req, res, next) => {
  const { token } = req.params;

  const member = await prisma.teamMember.findUnique({
    where: { inviteToken: token },
    include: {
      customRoles: {
        select: {
          role: {
            select: { id: true, name: true, slug: true, description: true, permissions: true, isArchived: true },
          },
        },
      },
    },
  });

  if (!member) {
    return next(new AppError('Invitation not found', 404));
  }

  const stateError = inviteStateError(member);
  if (stateError) return next(stateError);

  const invitedEmail = normalizeEmail(member.email);
  if (normalizeEmail(req.user.email) !== invitedEmail) {
    return next(new AppError(`This invitation was sent to ${invitedEmail}. Please sign in with that email address.`, 403));
  }

  await assertEmailCanJoinTeam({ email: invitedEmail, supplierId: member.supplierId });

  const systemRoles = rolesOf(member);
  const customRoles = customRolesOf(member);
  if (systemRoles.length === 0 && customRoles.length === 0) {
    return next(new AppError('The role assigned to this invitation no longer exists. Ask the business owner to send a new invitation.', 409));
  }
  const archivedCustomRole = (member.customRoles || [])
    .map((link) => link.role)
    .find((role) => role?.isArchived);
  if (archivedCustomRole) {
    return next(new AppError('A role assigned to this invitation has been archived. Ask the business owner to send a new invitation.', 409));
  }

  // Conditional update, not update-by-id: two tabs (or a double click) race
  // here, and the loser must not overwrite anything or grant roles twice.
  const { count } = await consumeInviteToken({ memberId: member.id, token });
  if (count !== 1) {
    return next(await inviteRaceError(member.id));
  }

  // Accepting is what makes the member real, so the roles they need to open the
  // dashboard are granted here (for every role, not just admin) and the auth
  // cache is invalidated — the SPA loads the dashboard immediately after.
  await grantMemberRoles({
    userId: req.user.id,
    supplierId: member.supplierId,
    email: invitedEmail,
  });

  enqueueNotification({
    userId: member.supplierId,
    type: 'TEAM_INVITE_ACCEPTED',
    title: 'Team Invitation Accepted',
    message: `${invitedEmail} has accepted their invitation as ${roleNamesForMember(systemRoles, customRoles).join(' + ')}`,
    data: { memberId: member.id, email: invitedEmail, roles: systemRoles, customRoles: customRoles.map((role) => role.name) },
  }).catch((err) => logger.warn('[team] enqueueNotification failed:', err?.message));

  await invalidateMemberContext(invitedEmail);

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_accepted',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: { email: invitedEmail, roles: systemRoles, customRoles: customRoles.map((role) => role.name) },
    source: 'web',
  });

  const saved = await reloadMember(member.id);
  res.status(200).json({
    status: 'success',
    message: 'Invitation accepted successfully',
    data: {
      member: memberPayload(saved || { ...member, ...{ status: 'ACCEPTED', inviteToken: null, tokenExpiresAt: null } }),
      landingPath: saved?.landingPath || null,
    },
  });
});

/**
 * Public, token-bound sign-up for an invitee who does not have an account.
 *
 * The email is read from the invitation, never from the body: otherwise the
 * link would mint an account for any address the holder typed, and the token
 * would stop proving control of the inbox it was sent to. The user and the
 * membership flip happen in one transaction, so a crash cannot leave a
 * half-accepted invite or an orphan account.
 */
exports.registerInvitee = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { name } = req.body;
  const password = req.body?.password;

  const member = await prisma.teamMember.findUnique({
    where: { inviteToken: token },
    include: {
      customRoles: {
        select: {
          role: {
            select: { id: true, name: true, slug: true, description: true, permissions: true, isArchived: true },
          },
        },
      },
    },
  });

  if (!member) {
    return next(new AppError('Invitation not found', 404));
  }

  const stateError = inviteStateError(member);
  if (stateError) return next(stateError);

  const invitedEmail = normalizeEmail(member.email);
  const cleanName = String(name || '').trim();

  if (cleanName.length < 2) {
    return next(new AppError('Please provide your full name', 400));
  }
  if (cleanName.length > 120) {
    return next(new AppError('Please use 120 characters or fewer for your name', 400));
  }

  const badPassword = passwordError(password);
  if (badPassword) return next(new AppError(badPassword, 400, { code: 'WEAK_PASSWORD' }));

  const existingAccount = await prisma.user.findUnique({
    where: { email: invitedEmail },
    select: { id: true, passwordHash: true },
  });

  if (existingAccount) {
    const message = existingAccount.passwordHash
      ? 'An account already exists for this email. Sign in to accept the invitation.'
      : 'An account already exists for this email. Continue with Google to accept the invitation.';
    return next(new AppError(message, 409, { code: 'ACCOUNT_EXISTS' }));
  }

  await assertEmailCanJoinTeam({ email: invitedEmail, supplierId: member.supplierId });

  const systemRoles = rolesOf(member);
  const customRoles = customRolesOf(member);
  if (systemRoles.length === 0 && customRoles.length === 0) {
    return next(new AppError('The role assigned to this invitation no longer exists. Ask the business owner to send a new invitation.', 409, { code: 'ROLE_REMOVED' }));
  }
  if ((member.customRoles || []).some((link) => link.role?.isArchived)) {
    return next(new AppError('A role assigned to this invitation has been archived. Ask the business owner to send a new invitation.', 409, { code: 'ROLE_ARCHIVED' }));
  }

  const passwordHash = await bcrypt.hash(password, 10);

  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: cleanName,
          email: invitedEmail,
          passwordHash,
          authProvider: 'local',
          roles: ['customer'],
          emailVerified: true, // the invite token already proved inbox control
          lastLoginAt: new Date(),
        },
      });

      const { count } = await tx.teamMember.updateMany({
        where: {
          id: member.id,
          inviteToken: token,
          status: 'PENDING',
          OR: [{ tokenExpiresAt: { gt: new Date() } }, { tokenExpiresAt: null }],
        },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          inviteToken: null,
          tokenExpiresAt: null,
        },
      });

      if (count !== 1) {
        // Throwing rolls the user back too, so a consumed link never leaves
        // behind an account nobody asked for.
        throw new AppError(
          'This invitation has expired or was already used. Ask the business owner for a new one.',
          410,
          { code: 'INVITE_UNAVAILABLE' },
        );
      }

      return created;
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      return next(new AppError('An account already exists for this email. Sign in to accept the invitation.', 409, { code: 'ACCOUNT_EXISTS' }));
    }
    throw error;
  }

  const membership = await grantMemberRoles({
    userId: user.id,
    supplierId: member.supplierId,
    email: invitedEmail,
  });

  enqueueNotification({
    userId: member.supplierId,
    type: 'TEAM_INVITE_ACCEPTED',
    title: 'Team Invitation Accepted',
    message: `${invitedEmail} has joined as ${roleNamesForMember(systemRoles, customRoles).join(' + ')}`,
    data: { memberId: member.id, email: invitedEmail, roles: systemRoles, customRoles: customRoles.map((role) => role.name) },
  }).catch((err) => logger.warn('[team] enqueueNotification failed:', err?.message));

  await invalidateMemberContext(invitedEmail);

  await logActivity({
    userId: user.id,
    action: 'team.invite_accepted',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: {
      email: invitedEmail,
      roles: systemRoles,
      customRoles: customRoles.map((role) => role.name),
      method: 'created_account',
    },
    source: 'web',
  });

  const accessToken = signAccessToken({ userId: user.id });
  const refreshToken = signRefreshToken({ userId: user.id });
  await storeRefreshToken(user.id, refreshToken);

  const saved = await reloadMember(member.id);

  res.status(201).json({
    status: 'success',
    message: 'Your account is ready',
    data: memberSessionPayload({
      user: { ...user, roles: membership.roles },
      accessToken,
      refreshToken,
      member: saved || { ...member, status: 'ACCEPTED' },
    }),
  });
});

/** Owner-side helper: hand a pending invitee's link to the owner to copy. */
exports.getInviteLink = catchAsync(async (req, res, next) => {
  const { memberId } = req.params;

  const member = await prisma.teamMember.findFirst({
    where: { id: memberId, supplierId: req.supplierId },
    select: { id: true, email: true, status: true, inviteToken: true, tokenExpiresAt: true },
  });

  if (!member) {
    return next(new AppError('Team member not found', 404));
  }
  if (member.status !== 'PENDING') {
    return next(new AppError('This invitation is no longer pending.', 409, { code: 'INVITE_NOT_PENDING' }));
  }
  if (!member.inviteToken) {
    return next(new AppError('This invitation link is no longer available. Resend the invitation to create a new one.', 410, { code: 'INVITE_LINK_UNAVAILABLE' }));
  }
  if (member.tokenExpiresAt && member.tokenExpiresAt < new Date()) {
    return next(new AppError('This invitation has expired. Resend it to create a new link.', 410, { code: 'INVITE_EXPIRED' }));
  }

  // Build the brand-correct base from the OWNER's roles, not the caller's: a
  // member with team access may not carry the same brand array.
  const owner = await prisma.user.findUnique({
    where: { id: req.supplierId },
    select: { roles: true },
  });

  res.status(200).json({
    status: 'success',
    data: {
      url: `${emailUrls.dashboardBaseForUser(owner)}/team/invite?token=${member.inviteToken}`,
      email: normalizeEmail(member.email),
      expiresAt: member.tokenExpiresAt,
    },
  });
});

exports.declineInvite = catchAsync(async (req, res, next) => {
  const { token } = req.params;

  const member = await prisma.teamMember.findUnique({
    where: { inviteToken: token },
  });

  if (!member) {
    return next(new AppError('Invitation not found', 404));
  }

  if (member.status !== 'PENDING') {
    return next(new AppError(`Invitation is already ${member.status.toLowerCase()}`, 400));
  }

  const invitedEmail = normalizeEmail(member.email);
  if (normalizeEmail(req.user.email) !== invitedEmail) {
    return next(new AppError(`This invitation was sent to ${invitedEmail}. Please sign in with that email address.`, 403));
  }

  const { count } = await prisma.teamMember.updateMany({
    where: { id: member.id, inviteToken: token, status: 'PENDING' },
    data: {
      status: 'REVOKED',
      inviteToken: null,
      tokenExpiresAt: null,
    },
  });

  if (count !== 1) {
    return next(await inviteRaceError(member.id));
  }

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_declined',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: { email: invitedEmail, roles: rolesOf(member) },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    message: 'Invitation declined',
  });
});

exports.resendInvite = catchAsync(async (req, res, next) => {
  const email = normalizeEmail(req.body.email);

  if (!email) {
    return next(new AppError('Email is required', 400));
  }

  if (!EMAIL_REGEX.test(email)) {
    return next(new AppError('Please provide a valid email address', 400));
  }

  const existing = await prisma.teamMember.findUnique({
    where: {
      supplierId_email: { supplierId: req.supplierId, email },
    },
    include: {
      supplier: { select: { name: true, email: true } },
      customRoles: {
        select: {
          role: {
            select: { id: true, name: true, slug: true, description: true, permissions: true, isArchived: true },
          },
        },
      },
    },
  });

  if (!existing) {
    return next(new AppError('No pending invitation found for this email', 404));
  }

  if (existing.status === 'ACCEPTED') {
    return next(new AppError('This user has already accepted their invitation', 400));
  }

  if (existing.status === 'REVOKED') {
    return next(new AppError('This invitation has been revoked. Send a new invitation instead.', 400));
  }

  // The invitee may have created an account since the original send. Re-run the
  // same eligibility rules as the invite so a resend cannot hand a link to a
  // login that now belongs to another business.
  await assertEmailCanJoinTeam({ email, supplierId: req.supplierId });

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

  await prisma.teamMember.update({
    where: { id: existing.id },
    data: {
      inviteToken: token,
      tokenExpiresAt: expiresAt,
      status: 'PENDING',
    },
  });

  const inviteUrl = `${emailUrls.dashboardBaseForUser(req.user)}/team/invite?token=${token}`;

  // Same contract as the initial send: the token is already rotated, so a mail
  // failure is reported instead of 500-ing (which would strand the new link).
  let emailSent = true;
  try {
    await sendTeamInviteEmail({
      to: email,
      supplierName: existing.supplier.name || 'A supplier',
      roles: roleViewsFor(rolesOf(existing), customRolesOf(existing)),
      inviteUrl,
      invitedBy: req.user.name || 'Your supplier',
      invitedByEmail: req.user.email,
      expiresInHours: INVITE_TTL_HOURS,
      brandKey: resolveEmailBrand({ user: req.user }),
    });
  } catch (error) {
    emailSent = false;
    logger.error(`[team] invite resend failed for ${email}:`, error?.message);
  }

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_resend',
    resource: 'TeamMember',
    resourceId: existing.id,
    metadata: { email, roles: rolesOf(existing), customRoles: customRolesOf(existing).map((role) => role.name), emailSent },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    message: emailSent
      ? `Invitation resent to ${email}`
      : `A new invitation link was created for ${email}, but the email could not be sent.`,
    data: { emailSent },
  });
});

exports.revokeInvite = catchAsync(async (req, res, next) => {
  const { memberId } = req.params;

  const member = await prisma.teamMember.findFirst({
    where: { id: memberId, supplierId: req.supplierId },
    include: {
      customRoles: {
        select: {
          role: {
            select: { id: true, name: true, slug: true, description: true, permissions: true, isArchived: true },
          },
        },
      },
    },
  });

  if (!member) {
    return next(new AppError('Team member not found', 404));
  }

  if (member.status !== 'PENDING') {
    return next(new AppError(`Invitation is already ${member.status.toLowerCase()}`, 400));
  }

  await prisma.teamMember.update({
    where: { id: member.id },
    data: {
      status: 'REVOKED',
      inviteToken: null,
      tokenExpiresAt: null,
    },
  });

  const supplier = await prisma.user.findUnique({
    where: { id: req.supplierId },
    select: { name: true },
  });

  sendTeamInviteRevokedEmail({
    to: member.email,
    supplierName: supplier?.name || 'A supplier',
    roles: roleViewsFor(rolesOf(member), customRolesOf(member)),
    invitedBy: req.user.name || 'Your supplier',
    brandKey: resolveEmailBrand({ user: req.user }),
  }).catch((err) => logger.warn('[team] sendTeamInviteRevokedEmail failed:', err?.message));

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_revoked',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: { email: member.email, roles: rolesOf(member), customRoles: customRolesOf(member).map((role) => role.name) },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    message: 'Invitation revoked successfully',
  });
});

exports.directAddMember = catchAsync(async (req, res, next) => {
  const email = normalizeEmail(req.body.email);

  if (!email) return next(new AppError('Email is required', 400));
  if (!EMAIL_REGEX.test(email)) return next(new AppError('Please provide a valid email address', 400));

  if (email === normalizeEmail(req.user.email)) {
    return next(new AppError('You cannot add yourself to your own team.', 400, { code: 'SELF_INVITE' }));
  }

  await assertEmailCanJoinTeam({ email, supplierId: req.supplierId });

  const assignment = await normalizeAssignment({
    supplierId: req.supplierId,
    body: req.body,
    actorContext: req.teamContext,
  });
  if (assignment.error) return next(new AppError(assignment.error, 400));

  const { systemRoles, customRoles, customRoleIds } = assignment;

  // Direct add bypasses the accept step, so the invitee must already have an
  // account. Without this check the owner could create an "Active" member that
  // has no login and therefore no access to anything.
  const user = await prisma.user.findFirst({
    where: { email },
    select: { id: true },
  });

  if (!user) {
    return next(new AppError('No account exists for that email address yet. Send an invitation instead — they can join once they have signed up.', 400));
  }

  const member = await prisma.$transaction(async (tx) => {
    const acceptedCount = await tx.teamMember.count({
      where: { supplierId: req.supplierId, status: 'ACCEPTED' },
    });

    if (acceptedCount >= MAX_TEAM_SIZE) {
      throw new AppError(`Team size limit of ${MAX_TEAM_SIZE} reached`, 400);
    }

    const existing = await tx.teamMember.findUnique({
      where: { supplierId_email: { supplierId: req.supplierId, email } },
    });

    if (existing) {
      if (existing.status === 'ACCEPTED') {
        throw new AppError('This user is already a team member', 400);
      }

      const row = await tx.teamMember.update({
        where: { id: existing.id },
        data: {
          roles: systemRoles,
          role: systemRoles[0] || customRoles[0]?.slug || 'custom',
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          invitedById: req.user.id,
          inviteToken: null,
          tokenExpiresAt: null,
        },
      });
      await syncMemberCustomRoles(tx, row.id, customRoleIds);
      return row;
    }

    const row = await tx.teamMember.create({
      data: {
        supplierId: req.supplierId,
        email,
        roles: systemRoles,
        role: systemRoles[0] || customRoles[0]?.slug || 'custom',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        invitedById: req.user.id,
      },
    });
    await syncMemberCustomRoles(tx, row.id, customRoleIds);
    return row;
  });

  // They skipped the accept step, so grant the dashboard roles here.
  await grantMemberRoles({ userId: user.id, supplierId: req.supplierId, email });
  await invalidateMemberContext(email);

  await logActivity({
    userId: req.user.id,
    action: 'team.member_added',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: {
      email,
      roles: systemRoles,
      customRoles: customRoles.map((role) => ({ id: role.id, name: role.name })),
      method: 'direct_add',
    },
    source: 'web',
  });

  const saved = await reloadMember(member.id);
  res.status(201).json({
    status: 'success',
    message: `${email} added as a team member`,
    data: { member: memberPayload(saved || member) },
  });
});

exports.removeMember = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const member = await prisma.teamMember.findFirst({
    where: { id, supplierId: req.supplierId },
  });

  if (!member) {
    return next(new AppError('Team member not found', 404));
  }

  await prisma.teamMember.delete({ where: { id } });

  // A removed member must lose the roles they inherited, and both the auth and
  // membership caches have to go or they keep access for the cache TTL.
  const removedUser = await prisma.user.findFirst({ where: { email: member.email }, select: { id: true } });
  if (removedUser) {
    await revokeMemberRoles({ userId: removedUser.id, email: member.email });
  }
  await invalidateMemberContext(member.email);
  emitTeamSocketEvent(removedUser ? [removedUser.id] : [], 'team:removed');

  await logActivity({
    userId: req.user.id,
    action: 'team.member_removed',
    resource: 'TeamMember',
    resourceId: id,
    metadata: { email: member.email, roles: rolesOf(member) },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    message: 'Team member removed successfully',
  });
});

exports.updateMemberRole = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const assignment = await normalizeAssignment({
    supplierId: req.supplierId,
    body: req.body,
    actorContext: req.teamContext,
  });
  if (assignment.error) return next(new AppError(assignment.error, 400));

  const member = await prisma.teamMember.findFirst({
    where: { id, supplierId: req.supplierId },
    include: {
      customRoles: {
        select: {
          role: {
            select: { id: true, name: true, slug: true, description: true, permissions: true, isArchived: true },
          },
        },
      },
    },
  });

  if (!member) return next(new AppError('Team member not found', 404));
  if (member.email === req.user.email) {
    return next(new AppError('You cannot change your own roles', 403));
  }

  const previousRoles = rolesOf(member);
  const previousCustomRoles = customRolesOf(member).map((role) => ({ id: role.id, name: role.name }));

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.teamMember.update({
      where: { id },
      data: { roles: assignment.systemRoles, role: assignment.systemRoles[0] || assignment.customRoles[0]?.slug || 'custom' },
    });
    await syncMemberCustomRoles(tx, id, assignment.customRoleIds);
    return row;
  });

  await invalidateMemberContext(member.email);
  const changedUser = await prisma.user.findFirst({ where: { email: member.email }, select: { id: true } });
  emitTeamSocketEvent(changedUser ? [changedUser.id] : [], 'team:access-changed');

  await logActivity({
    userId: req.user.id,
    action: 'team.role_changed',
    resource: 'TeamMember',
    resourceId: id,
    metadata: {
      email: member.email,
      previousRoles,
      newRoles: assignment.systemRoles,
      previousCustomRoles,
      newCustomRoles: assignment.customRoles.map((role) => ({ id: role.id, name: role.name })),
    },
    source: 'web',
  });

  const saved = await reloadMember(id);
  res.status(200).json({
    status: 'success',
    data: { member: memberPayload(saved || updated) },
  });
});

exports.getMemberById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const member = await prisma.teamMember.findFirst({
    where: { id, supplierId: req.supplierId },
    select: MEMBER_PAYLOAD_SELECT,
  });

  if (!member) {
    return next(new AppError('Team member not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: { member: memberPayload(member) },
  });
});

// ---------------------------------------------------------------------------
// Custom roles (Ghana supplier dashboard)
// ---------------------------------------------------------------------------

function normalizeRoleName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Role name is required' };
  if (name.length > 50) return { error: 'Role name must be 50 characters or fewer' };
  return { name };
}

function normalizeLandingPath(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Landing page must be a path' };
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return { error: 'Landing page must be an internal dashboard path' };
  }
  if (path.length > 200) return { error: 'Landing page path is too long' };
  return { value: path };
}

function normalizeUiPreferences(value) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'UI preferences must be an object' };
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 20000) return { error: 'UI preferences are too large' };
  return { value };
}

function assertOwner(req) {
  if (!req.isOwner) {
    const error = new AppError('Only the business owner can manage roles', 403);
    error.code = 'OWNER_ONLY';
    return error;
  }
  return null;
}

exports.getPermissionCatalog = catchAsync(async (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      permissions: PERMISSIONS,
      groups: PERMISSION_GROUPS,
      notificationCategories: NOTIFICATION_CATEGORIES,
      systemRoles: VALID_TEAM_ROLES.map((role) => ({
        key: role,
        label: TEAM_ROLE_LABELS[role] || role,
        summary: TEAM_ROLE_SUMMARIES[role] || '',
        permissions: TEAM_ROLE_PERMISSIONS[role]?.permissions || [],
      })),
      maxRoles: MAX_TEAM_ROLES,
    },
  });
});

exports.getRoles = catchAsync(async (req, res) => {
  const roles = await prisma.teamRole.findMany({
    where: { supplierId: req.supplierId, isArchived: false },
    orderBy: [{ name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      permissions: true,
      landingPath: true,
      notificationCategories: true,
      uiPreferences: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { members: true } },
    },
  });

  res.status(200).json({
    status: 'success',
    data: {
      roles: roles.map((role) => ({
        ...role,
        memberCount: role._count?.members || 0,
        _count: undefined,
      })),
    },
  });
});

exports.createRole = catchAsync(async (req, res, next) => {
  const ownerError = assertOwner(req);
  if (ownerError) return next(ownerError);

  const nameResult = normalizeRoleName(req.body.name);
  if (nameResult.error) return next(new AppError(nameResult.error, 400));

  const slug = slugifyRoleName(nameResult.name);
  if (!slug) return next(new AppError('Role name must contain letters or numbers', 400));
  if (RESERVED_ROLE_SLUGS.has(slug)) {
    return next(new AppError('That role name is reserved. Choose a different name.', 409));
  }

  const permissionResult = normalizePermissions(req.body.permissions, { allowOwnerOnly: false });
  if (permissionResult.error) return next(new AppError(permissionResult.error, 400));
  if (!permissionResult.permissions.length) {
    return next(new AppError('Select at least one permission for this role', 400));
  }

  const landing = normalizeLandingPath(req.body.landingPath);
  if (landing.error) return next(new AppError(landing.error, 400));

  const uiPreferences = normalizeUiPreferences(req.body.uiPreferences);
  if (uiPreferences.error) return next(new AppError(uiPreferences.error, 400));

  const description = req.body.description ? String(req.body.description).trim().slice(0, 200) : null;

  const role = await prisma.teamRole.create({
    data: {
      supplierId: req.supplierId,
      name: nameResult.name,
      slug,
      description,
      permissions: permissionResult.permissions,
      landingPath: landing.value,
      notificationCategories: normalizeNotificationCategories(req.body.notificationCategories),
      uiPreferences: uiPreferences.value,
      createdById: req.user.id,
    },
    select: {
      id: true, name: true, slug: true, description: true, permissions: true,
      landingPath: true, notificationCategories: true, uiPreferences: true, version: true,
      createdAt: true, updatedAt: true,
    },
  }).catch((error) => {
    if (error?.code === 'P2002') throw new AppError('A role with that name already exists', 409);
    throw error;
  });

  await logActivity({
    userId: req.user.id,
    action: 'team.role_created',
    resource: 'TeamRole',
    resourceId: role.id,
    metadata: { name: role.name, permissions: role.permissions },
    source: 'web',
  });

  res.status(201).json({ status: 'success', data: { role: { ...role, memberCount: 0 } } });
});

exports.updateRole = catchAsync(async (req, res, next) => {
  const ownerError = assertOwner(req);
  if (ownerError) return next(ownerError);

  const { id } = req.params;
  const existing = await prisma.teamRole.findFirst({
    where: { id, supplierId: req.supplierId, isArchived: false },
  });
  if (!existing) return next(new AppError('Role not found', 404));

  if (req.body.version !== undefined && Number(req.body.version) !== existing.version) {
    return next(new AppError('This role changed in another tab. Refresh and try again.', 409));
  }

  const nameResult = normalizeRoleName(req.body.name ?? existing.name);
  if (nameResult.error) return next(new AppError(nameResult.error, 400));
  const slug = slugifyRoleName(nameResult.name);
  if (!slug) return next(new AppError('Role name must contain letters or numbers', 400));
  if (RESERVED_ROLE_SLUGS.has(slug) && slug !== existing.slug) {
    return next(new AppError('That role name is reserved. Choose a different name.', 409));
  }

  const permissionResult = normalizePermissions(
    req.body.permissions !== undefined ? req.body.permissions : existing.permissions,
    { allowOwnerOnly: false },
  );
  if (permissionResult.error) return next(new AppError(permissionResult.error, 400));
  if (!permissionResult.permissions.length) {
    return next(new AppError('Select at least one permission for this role', 400));
  }

  const landing = normalizeLandingPath(req.body.landingPath !== undefined ? req.body.landingPath : existing.landingPath);
  if (landing.error) return next(new AppError(landing.error, 400));

  const uiPreferences = normalizeUiPreferences(
    req.body.uiPreferences !== undefined ? req.body.uiPreferences : existing.uiPreferences,
  );
  if (uiPreferences.error) return next(new AppError(uiPreferences.error, 400));

  const role = await prisma.teamRole.update({
    where: { id },
    data: {
      name: nameResult.name,
      slug,
      description: req.body.description !== undefined
        ? (req.body.description ? String(req.body.description).trim().slice(0, 200) : null)
        : existing.description,
      permissions: permissionResult.permissions,
      landingPath: landing.value,
      notificationCategories: req.body.notificationCategories !== undefined
        ? normalizeNotificationCategories(req.body.notificationCategories)
        : existing.notificationCategories,
      uiPreferences: uiPreferences.value,
      version: { increment: 1 },
    },
    select: {
      id: true, name: true, slug: true, description: true, permissions: true,
      landingPath: true, notificationCategories: true, uiPreferences: true, version: true,
      createdAt: true, updatedAt: true,
      _count: { select: { members: true } },
    },
  }).catch((error) => {
    if (error?.code === 'P2002') throw new AppError('A role with that name already exists', 409);
    throw error;
  });

  // Every member holding this role must re-resolve immediately. The 30s cache
  // otherwise leaves the old permission set live after the owner saves.
  await invalidateSupplierContexts(req.supplierId);
  emitTeamSocketEvent(await userIdsForSupplierMembers(req.supplierId), 'team:access-changed');

  await logActivity({
    userId: req.user.id,
    action: 'team.role_updated',
    resource: 'TeamRole',
    resourceId: role.id,
    metadata: { name: role.name, permissions: role.permissions, version: role.version },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    data: { role: { ...role, memberCount: role._count?.members || 0, _count: undefined } },
  });
});

exports.archiveRole = catchAsync(async (req, res, next) => {
  const ownerError = assertOwner(req);
  if (ownerError) return next(ownerError);

  const { id } = req.params;
  const role = await prisma.teamRole.findFirst({
    where: { id, supplierId: req.supplierId, isArchived: false },
    include: { _count: { select: { members: true } } },
  });
  if (!role) return next(new AppError('Role not found', 404));
  if ((role._count?.members || 0) > 0) {
    return next(new AppError('Reassign the members using this role before archiving it', 409));
  }

  await prisma.teamRole.update({
    where: { id },
    data: { isArchived: true, version: { increment: 1 } },
  });
  await invalidateSupplierContexts(req.supplierId);
  emitTeamSocketEvent(await userIdsForSupplierMembers(req.supplierId), 'team:access-changed');

  await logActivity({
    userId: req.user.id,
    action: 'team.role_deleted',
    resource: 'TeamRole',
    resourceId: id,
    metadata: { name: role.name },
    source: 'web',
  });

  res.status(200).json({ status: 'success', message: 'Role archived' });
});

exports.updateMemberAccess = catchAsync(async (req, res, next) => {
  const ownerError = assertOwner(req);
  if (ownerError) return next(ownerError);

  const { id } = req.params;
  const member = await prisma.teamMember.findFirst({
    where: { id, supplierId: req.supplierId },
    include: {
      customRoles: {
        select: { role: { select: { id: true, name: true, permissions: true, landingPath: true, notificationCategories: true, uiPreferences: true, isArchived: true } } },
      },
    },
  });
  if (!member) return next(new AppError('Team member not found', 404));

  const landing = normalizeLandingPath(req.body.landingPath);
  if (landing.error) return next(new AppError(landing.error, 400));
  const uiPreferences = normalizeUiPreferences(req.body.uiPreferences);
  if (uiPreferences.error) return next(new AppError(uiPreferences.error, 400));

  const updated = await prisma.teamMember.update({
    where: { id },
    data: {
      landingPath: landing.value,
      notificationCategories: req.body.notificationCategories !== undefined
        ? normalizeNotificationCategories(req.body.notificationCategories)
        : member.notificationCategories,
      uiPreferences: uiPreferences.value,
    },
  });

  await invalidateMemberContext(member.email);
  const accessUser = await prisma.user.findFirst({ where: { email: member.email }, select: { id: true } });
  emitTeamSocketEvent(accessUser ? [accessUser.id] : [], 'team:access-changed');

  await logActivity({
    userId: req.user.id,
    action: 'team.access_updated',
    resource: 'TeamMember',
    resourceId: id,
    metadata: {
      email: member.email,
      landingPath: updated.landingPath,
      notificationCategories: updated.notificationCategories,
    },
    source: 'web',
  });

  const saved = await reloadMember(id);
  res.status(200).json({ status: 'success', data: { member: memberPayload(saved || updated) } });
});
