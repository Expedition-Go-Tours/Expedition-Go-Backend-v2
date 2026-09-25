const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const crypto = require('crypto');
const cache = require('../services/cacheHelper');
const { invalidateUserCache } = require('../../../middleware/authMiddleware');
const { sendTeamInviteEmail, sendTeamInviteRevokedEmail, resolveEmailBrand } = require('../services/emailService');
const emailUrls = require('../../../config/emailUrls');
const { enqueueNotification } = require('../services/queue');
const { logActivity } = require('../services/auditLogger');
const logger = require('../services/logger');
const { VALID_TEAM_ROLES, TEAM_ROLE_PERMISSIONS } = require('../../../config/teamPermissions');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEAM_SIZE = parseInt(process.env.MAX_TEAM_SIZE, 10) || 50;

// Brand roles a team member inherits from the supplier they join, so brand
// context (chat, email identity, dashboard links) matches the owner's.
const BRAND_ROLES = ['ghana', 'africa'];

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
  if (req.user.roles.includes('admin')) {
    return res.status(200).json({
      status: 'success',
      data: {
        role: 'admin',
        permissions: ['*'],
        isOwner: true,
      },
    });
  }

  const supplier = await prisma.supplierProfile.findFirst({
    where: { userId: req.user.id },
    select: { id: true },
  });

  if (supplier) {
    return res.status(200).json({
      status: 'success',
      data: {
        role: 'admin',
        permissions: ['*'],
        isOwner: true,
        supplierId: supplier.id,
      },
    });
  }

  const teamMember = await prisma.teamMember.findFirst({
    where: {
      email: req.user.email,
      status: 'ACCEPTED',
    },
    orderBy: { createdAt: 'desc' },
    select: { role: true, supplierId: true },
  });

  if (!teamMember) {
    return res.status(200).json({
      status: 'success',
      data: {
        role: null,
        permissions: [],
        isOwner: false,
      },
    });
  }

  const roleConfig = TEAM_ROLE_PERMISSIONS[teamMember.role] || { permissions: [] };

  res.status(200).json({
    status: 'success',
    data: {
      role: teamMember.role,
      permissions: roleConfig.permissions,
      isOwner: false,
      supplierId: teamMember.supplierId,
    },
  });
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
        status: true,
        invitedById: true,
        acceptedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.teamMember.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    results: members.length,
    data: {
      members,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        totalCount,
        limit,
      },
    },
  });
});

exports.inviteMember = catchAsync(async (req, res, next) => {
  const { email, role, directAdd } = req.body;

  // Legacy alias for POST /settings/team/direct-add — keep one implementation.
  if (directAdd) {
    return exports.directAddMember(req, res, next);
  }

  if (!email) {
    return next(new AppError('Email is required', 400));
  }

  if (!EMAIL_REGEX.test(email)) {
    return next(new AppError('Please provide a valid email address', 400));
  }

  if (role && !VALID_TEAM_ROLES.includes(role)) {
    return next(new AppError(`Invalid role. Must be one of: ${VALID_TEAM_ROLES.join(', ')}`, 400));
  }

  const member = await prisma.$transaction(async (tx) => {
    const [acceptedCount, pendingCount] = await Promise.all([
      tx.teamMember.count({ where: { supplierId: req.supplierId, status: 'ACCEPTED' } }),
      tx.teamMember.count({ where: { supplierId: req.supplierId, status: 'PENDING' } }),
    ]);

    if (acceptedCount + pendingCount >= MAX_TEAM_SIZE) {
      throw new AppError(`Team size limit of ${MAX_TEAM_SIZE} reached (including pending invitations)`, 400);
    }

    const existing = await tx.teamMember.findUnique({
      where: {
        supplierId_email: { supplierId: req.supplierId, email },
      },
    });

    if (existing) {
      if (existing.status === 'PENDING') {
        throw new AppError('An invitation has already been sent to this email', 400);
      }
      if (existing.status === 'ACCEPTED') {
        throw new AppError('This user is already a team member', 400);
      }
    }

    if (directAdd) {
      const memberData = {
        supplierId: req.supplierId,
        email,
        role: role || 'editor',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        invitedById: req.user.id,
      };
      if (existing) {
        return tx.teamMember.update({
          where: { id: existing.id },
          data: { ...memberData, inviteToken: null, tokenExpiresAt: null },
        });
      }
      return tx.teamMember.create({ data: memberData });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    if (existing) {
      return tx.teamMember.update({
        where: { id: existing.id },
        data: {
          role: role || 'editor',
          status: 'PENDING',
          invitedById: req.user.id,
          inviteToken: token,
          tokenExpiresAt: expiresAt,
        },
      });
    }

    return tx.teamMember.create({
      data: {
        supplierId: req.supplierId,
        email,
        role: role || 'editor',
        invitedById: req.user.id,
        inviteToken: token,
        tokenExpiresAt: expiresAt,
      },
    });
  });

  if (directAdd) {
    await logActivity({
      userId: req.user.id,
      action: 'team.member_added',
      resource: 'TeamMember',
      resourceId: member.id,
      metadata: { email, role: member.role, method: 'direct_add' },
      source: 'web',
    });

    return res.status(201).json({
      status: 'success',
      message: `${email} added as a team member`,
      data: { member: { id: member.id, email: member.email, role: member.role, status: member.status, acceptedAt: member.acceptedAt, createdAt: member.createdAt, updatedAt: member.updatedAt } },
    });
  }

  // Brand-aware invite link: Ghana suppliers' team members accept on the
  // Ghana dashboard, everyone else on the default one.
  const inviteUrl = `${emailUrls.dashboardBaseForUser(req.user)}/team/invite?token=${member.inviteToken}`;

  const supplier = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { name: true },
  });

  // The invitation row already exists, so a mail failure must not 500 the
  // request (which would leave the owner retrying an "already sent" invite).
  // Report it instead and let Resend re-issue a fresh token.
  let emailSent = true;
  try {
    await sendTeamInviteEmail({
      to: email,
      supplierName: supplier?.name || 'A supplier',
      role: role || 'editor',
      inviteUrl,
      invitedBy: req.user.name || 'Your supplier',
      brandKey: resolveEmailBrand({ user: req.user }),
    });
  } catch (error) {
    emailSent = false;
    logger.error(`[team] invite email failed for ${email}:`, error?.message);
  }

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_sent',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: { email, role: member.role, emailSent },
    source: 'web',
  });

  res.status(201).json({
    status: 'success',
    message: emailSent
      ? `Invitation sent to ${email}`
      : `Invitation created for ${email}, but the email could not be sent. Use Resend to try again.`,
    data: {
      emailSent,
      member: { id: member.id, email: member.email, role: member.role, status: member.status, createdAt: member.createdAt, updatedAt: member.updatedAt },
    },
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
    },
  });

  if (!member) {
    return next(new AppError('Invitation not found', 404));
  }

  const stateError = inviteStateError(member);
  if (stateError) return next(stateError);

  res.status(200).json({
    status: 'success',
    data: {
      supplierName: member.supplier.name,
      role: member.role,
      invitedEmail: member.email,
      status: member.status,
    },
  });
});

exports.acceptInvite = catchAsync(async (req, res, next) => {
  const { token } = req.params;

  const member = await prisma.teamMember.findUnique({
    where: { inviteToken: token },
  });

  if (!member) {
    return next(new AppError('Invitation not found', 404));
  }

  const stateError = inviteStateError(member);
  if (stateError) return next(stateError);

  if (req.user.email !== member.email) {
    return next(new AppError(`This invitation was sent to ${member.email}. Please sign in with that email address.`, 403));
  }

  const updated = await prisma.teamMember.update({
    where: { id: member.id },
    data: {
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      inviteToken: null,
      tokenExpiresAt: null,
    },
  });

  // Accepting is what makes the member real, so the roles they need to open the
  // dashboard are granted here (for every role, not just admin) and the auth
  // cache is invalidated — the SPA loads the dashboard immediately after.
  await grantMemberRoles({
    userId: req.user.id,
    supplierId: member.supplierId,
    email: member.email,
  });

  enqueueNotification({
    userId: member.supplierId,
    type: 'TEAM_INVITE_ACCEPTED',
    title: 'Team Invitation Accepted',
    message: `${req.user.email} has accepted their invitation as ${member.role}`,
    data: { memberId: member.id, email: req.user.email, role: member.role },
  }).catch((err) => logger.warn('[team] enqueueNotification failed:', err?.message));

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_accepted',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: { email: member.email, role: member.role },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    message: 'Invitation accepted successfully',
    data: { member: { id: updated.id, email: updated.email, role: updated.role, status: updated.status, acceptedAt: updated.acceptedAt, createdAt: updated.createdAt, updatedAt: updated.updatedAt } },
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

  if (req.user.email !== member.email) {
    return next(new AppError(`This invitation was sent to ${member.email}. Please sign in with that email address.`, 403));
  }

  await prisma.teamMember.update({
    where: { id: member.id },
    data: {
      status: 'REVOKED',
      inviteToken: null,
      tokenExpiresAt: null,
    },
  });

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_declined',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: { email: member.email, role: member.role },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    message: 'Invitation declined',
  });
});

exports.resendInvite = catchAsync(async (req, res, next) => {
  const { email } = req.body;

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

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

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
      role: existing.role,
      inviteUrl,
      invitedBy: req.user.name || 'Your supplier',
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
    metadata: { email, role: existing.role, emailSent },
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
    role: member.role,
    invitedBy: req.user.name || 'Your supplier',
    brandKey: resolveEmailBrand({ user: req.user }),
  }).catch((err) => logger.warn('[team] sendTeamInviteRevokedEmail failed:', err?.message));

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_revoked',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: { email: member.email, role: member.role },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    message: 'Invitation revoked successfully',
  });
});

exports.directAddMember = catchAsync(async (req, res, next) => {
  const { email, role } = req.body;

  if (!email) {
    return next(new AppError('Email is required', 400));
  }

  if (!EMAIL_REGEX.test(email)) {
    return next(new AppError('Please provide a valid email address', 400));
  }
  if (!role || !VALID_TEAM_ROLES.includes(role)) {
    return next(new AppError(`Invalid role. Must be one of: ${VALID_TEAM_ROLES.join(', ')}`, 400));
  }

  // Direct add bypasses the accept step, so it only makes sense for someone who
  // already has an account. Without this check the owner could create an
  // "Active" member that has no login and therefore no access to anything.
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
      where: {
        supplierId_email: { supplierId: req.supplierId, email },
      },
    });

    if (existing) {
      if (existing.status === 'ACCEPTED') {
        throw new AppError('This user is already a team member', 400);
      }

      return tx.teamMember.update({
        where: { id: existing.id },
        data: {
          role,
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          invitedById: req.user.id,
          inviteToken: null,
          tokenExpiresAt: null,
        },
      });
    }

    return tx.teamMember.create({
      data: {
        supplierId: req.supplierId,
        email,
        role,
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        invitedById: req.user.id,
      },
    });
  });

  // They skipped the accept step, so grant the dashboard roles here.
  await grantMemberRoles({ userId: user.id, supplierId: req.supplierId, email });

  await logActivity({
    userId: req.user.id,
    action: 'team.member_added',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: { email, role, method: 'direct_add' },
    source: 'web',
  });

  res.status(201).json({
    status: 'success',
    message: `${email} added as a team member`,
    data: { member: { id: member.id, email: member.email, role: member.role, status: member.status, acceptedAt: member.acceptedAt, createdAt: member.createdAt, updatedAt: member.updatedAt } },
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
  await cache.invalidateKey(`team:member:email:${member.email}`).catch(() => {});

  await logActivity({
    userId: req.user.id,
    action: 'team.member_removed',
    resource: 'TeamMember',
    resourceId: id,
    metadata: { email: member.email, role: member.role },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    message: 'Team member removed successfully',
  });
});

exports.updateMemberRole = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!role || !VALID_TEAM_ROLES.includes(role)) {
    return next(new AppError(`Invalid role. Must be one of: ${VALID_TEAM_ROLES.join(', ')}`, 400));
  }

  const member = await prisma.teamMember.findFirst({
    where: { id, supplierId: req.supplierId },
  });

  if (!member) {
    return next(new AppError('Team member not found', 404));
  }

  if (member.email === req.user.email) {
    return next(new AppError('You cannot change your own role', 403));
  }

  const previousRole = member.role;
  const updated = await prisma.teamMember.update({
    where: { id },
    data: { role },
  });

  // requireTeamRole/requireTeamPermission cache the member row per email.
  await cache.invalidateKey(`team:member:email:${member.email}`).catch(() => {});

  await logActivity({
    userId: req.user.id,
    action: 'team.role_changed',
    resource: 'TeamMember',
    resourceId: id,
    metadata: { email: member.email, previousRole, newRole: role },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    data: { member: { id: updated.id, email: updated.email, role: updated.role, status: updated.status, acceptedAt: updated.acceptedAt, createdAt: updated.createdAt, updatedAt: updated.updatedAt } },
  });
});

exports.getMemberById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const member = await prisma.teamMember.findFirst({
    where: { id, supplierId: req.supplierId },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      invitedById: true,
      acceptedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!member) {
    return next(new AppError('Team member not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: { member },
  });
});
