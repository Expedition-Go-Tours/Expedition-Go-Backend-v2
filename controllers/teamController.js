const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const crypto = require('crypto');
const { sendTeamInviteEmail } = require('../utils/emailService');

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

  const validRoles = ['admin', 'editor', 'finance', 'support'];
  if (role && !validRoles.includes(role)) {
    return next(new AppError(`Invalid role. Must be one of: ${validRoles.join(', ')}`, 400));
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

  const frontendUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:5173';
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

  const validRoles = ['admin', 'editor', 'finance', 'support'];
  if (!role || !validRoles.includes(role)) {
    return next(new AppError(`Invalid role. Must be one of: ${validRoles.join(', ')}`, 400));
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

  res.status(200).json({
    status: 'success',
    message: 'Team member removed successfully',
  });
});

exports.updateMemberRole = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { role } = req.body;

  const validRoles = ['admin', 'editor', 'finance', 'support'];
  if (!role || !validRoles.includes(role)) {
    return next(new AppError(`Invalid role. Must be one of: ${validRoles.join(', ')}`, 400));
  }

  const member = await prisma.teamMember.findFirst({
    where: { id, supplierId: req.user.id },
  });

  if (!member) {
    return next(new AppError('Team member not found', 404));
  }

  const updated = await prisma.teamMember.update({
    where: { id },
    data: { role },
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