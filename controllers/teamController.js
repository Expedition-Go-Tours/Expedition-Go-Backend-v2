const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const crypto = require('crypto');
const { sendTeamInviteEmail, sendTeamInviteRevokedEmail } = require('../utils/emailService');
const { enqueueNotification } = require('../utils/queue');
const { logActivity } = require('../utils/auditLogger');
const { VALID_TEAM_ROLES, TEAM_ROLE_PERMISSIONS } = require('../config/teamPermissions');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEAM_SIZE = parseInt(process.env.MAX_TEAM_SIZE, 10) || 50;

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
  const { status, page = 1, limit = 50 } = req.query;
  const where = { supplierId: req.supplierId };
  if (status) where.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [members, totalCount] = await Promise.all([
    prisma.teamMember.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
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
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        totalCount,
        limit: parseInt(limit),
      },
    },
  });
});

exports.inviteMember = catchAsync(async (req, res, next) => {
  const { email, role, directAdd } = req.body;

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
      if (existing.status === 'PENDING') {
        throw new AppError('An invitation has already been sent to this email', 400);
      }
      if (existing.status === 'ACCEPTED') {
        throw new AppError('This user is already a team member', 400);
      }
    }

    if (directAdd) {
      return tx.teamMember.create({
        data: {
          supplierId: req.supplierId,
          email,
          role: role || 'editor',
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          invitedById: req.user.id,
        },
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

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

  const frontendUrl = process.env.SUPPLIER_DASHBOARD_URL || process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:5173';
  const inviteUrl = `${frontendUrl}/team/invite?token=${member.inviteToken}`;

  const supplier = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { name: true },
  });

  await sendTeamInviteEmail({
    to: email,
    supplierName: supplier?.name || 'A supplier',
    role: role || 'editor',
    inviteUrl,
    invitedBy: req.user.name || 'Your supplier',
  });

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_sent',
    resource: 'TeamMember',
    resourceId: member.id,
    metadata: { email, role: member.role },
    source: 'web',
  });

  res.status(201).json({
    status: 'success',
    message: `Invitation sent to ${email}`,
    data: { member: { id: member.id, email: member.email, role: member.role, status: member.status, createdAt: member.createdAt, updatedAt: member.updatedAt } },
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

  if (member.tokenExpiresAt && member.tokenExpiresAt < new Date()) {
    return next(new AppError('Invitation has expired', 410));
  }

  if (member.status === 'ACCEPTED') {
    return next(new AppError('Invitation has already been accepted', 409));
  }

  if (member.status === 'REVOKED') {
    return next(new AppError('Invitation has been revoked', 410));
  }

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

  if (member.tokenExpiresAt && member.tokenExpiresAt < new Date()) {
    return next(new AppError('Invitation has expired', 410));
  }

  if (member.status === 'ACCEPTED') {
    return next(new AppError('Invitation has already been accepted', 409));
  }

  if (member.status === 'REVOKED') {
    return next(new AppError('Invitation has been revoked', 410));
  }

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

  const acceptedUser = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { roles: true },
  });

  if (acceptedUser && member.role === 'admin' && !acceptedUser.roles.includes('supplier')) {
    acceptedUser.roles.push('supplier');
    await prisma.user.update({
      where: { id: req.user.id },
      data: { roles: acceptedUser.roles },
    });
  }

  enqueueNotification({
    userId: member.supplierId,
    type: 'TEAM_INVITE_ACCEPTED',
    title: 'Team Invitation Accepted',
    message: `${req.user.email} has accepted their invitation as ${member.role}`,
    data: { memberId: member.id, email: req.user.email, role: member.role },
  }).catch(() => {});

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

  const frontendUrl = process.env.SUPPLIER_DASHBOARD_URL || process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:5173';
  const inviteUrl = `${frontendUrl}/team/invite?token=${token}`;

  await sendTeamInviteEmail({
    to: email,
    supplierName: existing.supplier.name || 'A supplier',
    role: existing.role,
    inviteUrl,
    invitedBy: req.user.name || 'Your supplier',
  });

  await logActivity({
    userId: req.user.id,
    action: 'team.invite_resend',
    resource: 'TeamMember',
    resourceId: existing.id,
    metadata: { email, role: existing.role },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    message: `Invitation resent to ${email}`,
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
  }).catch(() => {});

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

    if (existing && existing.status === 'PENDING') {
      const acceptedCountNow = await tx.teamMember.count({
        where: { supplierId: req.supplierId, status: 'ACCEPTED' },
      });
      if (acceptedCountNow >= MAX_TEAM_SIZE) {
        throw new AppError(`Team size limit of ${MAX_TEAM_SIZE} reached`, 400);
      }
    }

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
