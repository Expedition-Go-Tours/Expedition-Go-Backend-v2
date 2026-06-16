const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const crypto = require('crypto');
const { sendTeamInviteEmail } = require('../utils/emailService');
const { logActivity } = require('../utils/auditLogger');
const { VALID_TEAM_ROLES, TEAM_ROLE_PERMISSIONS } = require('../config/teamPermissions');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const members = await prisma.teamMember.findMany({
    where: { supplierId: req.user.id },
    orderBy: { createdAt: 'desc' },
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

  res.status(200).json({
    status: 'success',
    results: members.length,
    data: { members },
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

  const existing = await prisma.teamMember.findUnique({
    where: {
      supplierId_email: { supplierId: req.user.id, email },
    },
  });

  if (existing) {
    if (existing.status === 'PENDING') {
      return next(new AppError('An invitation has already been sent to this email', 400));
    }
    if (existing.status === 'ACCEPTED') {
      return next(new AppError('This user is already a team member', 400));
    }
  }

  if (directAdd) {
    const member = await prisma.teamMember.create({
      data: {
        supplierId: req.user.id,
        email,
        role: role || 'editor',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        invitedById: req.user.id,
      },
    });

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

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const member = await prisma.teamMember.create({
    data: {
      supplierId: req.user.id,
      email,
      role: role || 'editor',
      invitedById: req.user.id,
      inviteToken: token,
      tokenExpiresAt: expiresAt,
    },
  });

  const frontendUrl = process.env.SUPPLIER_DASHBOARD_URL || process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:5173';
  const inviteUrl = `${frontendUrl}/team/invite?token=${token}`;

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
      supplierEmail: member.supplier.email,
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

  const existing = await prisma.teamMember.findUnique({
    where: {
      supplierId_email: { supplierId: req.user.id, email },
    },
  });

  if (existing) {
    if (existing.status === 'ACCEPTED') {
      return next(new AppError('This user is already a team member', 400));
    }
  }

  const member = await prisma.teamMember.create({
    data: {
      supplierId: req.user.id,
      email,
      role,
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      invitedById: req.user.id,
    },
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
    where: { id, supplierId: req.user.id },
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
    where: { id, supplierId: req.user.id },
  });

  if (!member) {
    return next(new AppError('Team member not found', 404));
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
    where: { id, supplierId: req.user.id },
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
