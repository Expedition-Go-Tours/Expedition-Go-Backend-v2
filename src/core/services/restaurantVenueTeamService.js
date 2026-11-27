/**
 * Venue team: members and invitations.
 *
 * Only an OWNER can invite, change roles, remove a member or transfer
 * ownership. A MANAGER sees the team list (so they know who to ask) but cannot
 * change it.
 *
 * Invitations are hashed at rest. The raw token exists only in the email that
 * carries it, so a database dump cannot be replayed into access. The accept
 * endpoint also checks that the signed-in account's email matches the invited
 * address: forwarding the email to a colleague does not grant them the venue.
 *
 * Ownership is never implicit. Removing the last OWNER is refused, and a
 * transfer demotes the previous owner to MANAGER in the same transaction so the
 * venue can never end up ownerless.
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const AppError = require('./appError');
const cache = require('./cacheHelper');
const logger = require('./logger');
const { enqueueEvent, enqueueNotification } = require('./queue');
const { logActivity } = require('./auditLogger');
const { resolveAllowedClientUrl } = require('./clientOrigin');
const { assertOwner, assertPermission } = require('./restaurantVenueAccess');

const INVITE_TTL_DAYS = 7;
const MAX_INVITE_TTL_DAYS = 30;
const INVITABLE_ROLES = ['MANAGER'];

function invalidate(venue) {
  cache
    .invalidateRestaurantVenueCaches(venue.id, venue.slug)
    .catch((err) => logger.warn('[cache] restaurant venue invalidation failed:', err?.message));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function toMember(row) {
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    user: row.user
      ? {
          id: row.user.id,
          name: row.user.name,
          email: row.user.email,
          photo: row.user.photoURL || null,
          lastLoginAt: row.user.lastLoginAt ?? null,
        }
      : null,
  };
}

function toInvite(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    acceptedAt: row.acceptedAt ?? null,
    revokedAt: row.revokedAt ?? null,
  };
}

async function listTeam(context) {
  assertPermission(context, 'team.view');
  const venueId = context.venue.id;
  const isOwner = context.membership.role === 'OWNER';

  const members = await prisma.restaurantVenueMember.findMany({
    where: { venueId, status: 'ACTIVE' },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    include: {
      user: { select: { id: true, name: true, email: true, photoURL: true, lastLoginAt: true } },
    },
  });

  const invites = isOwner
    ? await prisma.restaurantVenueInvite.findMany({
        where: { venueId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      })
    : [];

  return {
    members: members.map(toMember),
    invites: invites.map(toInvite),
    canManage: isOwner,
    ownerCount: members.filter((row) => row.role === 'OWNER').length,
  };
}

function inviteEmail({ venueName, inviterName, role, acceptUrl, expiresAt }) {
  const roleLabel = role === 'OWNER' ? 'an owner' : 'a manager';
  return {
    subject: `You have been invited to manage ${venueName} on Travio`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#101828;">
        <p style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#15803d;margin:0 0 12px;">Travio for restaurants</p>
        <h1 style="font-family:Manrope,-apple-system,sans-serif;font-size:24px;line-height:1.25;margin:0 0 16px;">Help manage ${venueName}</h1>
        <p style="font-size:15px;line-height:1.6;color:#344054;margin:0 0 16px;">
          ${inviterName} invited you to join the team for <strong>${venueName}</strong> as ${roleLabel}.
        </p>
        <p style="font-size:15px;line-height:1.6;color:#344054;margin:0 0 24px;">
          You will be able to reply to reviews, manage photos, update hours and business information, and keep the menu current.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${acceptUrl}" style="display:inline-block;background:#065f46;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:999px;">Accept invitation</a>
        </p>
        <p style="font-size:13px;line-height:1.6;color:#667085;margin:0 0 8px;">
          This link expires on ${expiresAt.toUTCString()}. Sign in with the email address this message was sent to.
        </p>
        <p style="font-size:13px;line-height:1.6;color:#667085;margin:0;">
          If you were not expecting this, you can ignore the email. Nothing changes until you accept.
        </p>
      </div>
    `,
    text: `${inviterName} invited you to manage ${venueName} on Travio. Accept: ${acceptUrl} (expires ${expiresAt.toUTCString()})`,
  };
}

async function inviteMember(context, { email, role = 'MANAGER', expiresInDays }, req) {
  assertOwner(context);
  const venueId = context.venue.id;

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new AppError('Enter a valid email address', 400, { code: 'INVALID_EMAIL' });
  }
  if (!INVITABLE_ROLES.includes(role)) {
    throw new AppError('Invite someone as a manager. Ownership transfer is a separate action.', 400, {
      code: 'INVALID_INVITE_ROLE',
    });
  }

  const days = Number.isInteger(expiresInDays) ? expiresInDays : INVITE_TTL_DAYS;
  if (days < 1 || days > MAX_INVITE_TTL_DAYS) {
    throw new AppError(`Invitations last between 1 and ${MAX_INVITE_TTL_DAYS} days`, 400, {
      code: 'INVALID_INVITE_EXPIRY',
    });
  }

  const existingMember = await prisma.restaurantVenueMember.findFirst({
    where: { venueId, status: 'ACTIVE', user: { email: cleanEmail } },
    select: { id: true },
  });
  if (existingMember) {
    throw new AppError('That person already manages this restaurant', 409, {
      code: 'ALREADY_A_MEMBER',
    });
  }

  const pending = await prisma.restaurantVenueInvite.findFirst({
    where: { venueId, email: cleanEmail, status: 'PENDING' },
    select: { id: true },
  });
  if (pending) {
    throw new AppError('An invitation is already pending for that email', 409, {
      code: 'INVITE_ALREADY_PENDING',
    });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const invite = await prisma.restaurantVenueInvite.create({
    data: {
      venueId,
      email: cleanEmail,
      role,
      status: 'PENDING',
      tokenHash: hashToken(token),
      expiresAt,
      invitedById: context.membership.userId,
    },
  });

  const origin = resolveAllowedClientUrl(req);
  const acceptUrl = `${origin || ''}/restaurants/manage/invite?token=${encodeURIComponent(token)}`;
  const mail = inviteEmail({
    venueName: context.venue.name,
    inviterName: req && req.user ? req.user.name : 'The venue owner',
    role,
    acceptUrl,
    expiresAt,
  });

  // Email failure must not roll back the invitation: the owner can resend, and
  // the row is the record of intent.
  require('./emailService')
    .sendHtml({ to: cleanEmail, subject: mail.subject, html: mail.html, text: mail.text })
    .catch((err) => logger.warn('[invite] email failed:', err?.message));

  const existingUser = await prisma.user.findUnique({
    where: { email: cleanEmail },
    select: { id: true },
  });
  if (existingUser) {
    enqueueNotification({
      userId: existingUser.id,
      type: 'RESTAURANT_TEAM_INVITE',
      title: `Invitation to manage ${context.venue.name}`,
      message: 'Open the invitation in your email to join the team.',
      data: { venueId, inviteId: invite.id },
    }).catch((err) => logger.warn('[notification] invite failed:', err?.message));
  }

  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantVenueInvite.created',
    resource: 'RestaurantVenueInvite',
    resourceId: invite.id,
    metadata: { venueId, role, expiresAt: expiresAt.toISOString() },
  });
  enqueueEvent({
    name: 'restaurant_venue_invite.created',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantVenueInvite',
    resourceId: invite.id,
    properties: { venueId, role },
  });

  return toInvite(invite);
}

async function revokeInvite(context, { inviteId }, req) {
  assertOwner(context);
  const invite = await prisma.restaurantVenueInvite.findFirst({
    where: { id: inviteId, venueId: context.venue.id },
  });
  if (!invite) throw new AppError('Invitation not found', 404, { code: 'INVITE_NOT_FOUND' });
  if (invite.status !== 'PENDING') {
    throw new AppError('This invitation is no longer pending', 409, {
      code: 'INVITE_NOT_PENDING',
    });
  }

  const updated = await prisma.restaurantVenueInvite.update({
    where: { id: invite.id },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });

  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantVenueInvite.revoked',
    resource: 'RestaurantVenueInvite',
    resourceId: invite.id,
    metadata: { venueId: context.venue.id },
  });
  enqueueEvent({
    name: 'restaurant_venue_invite.revoked',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantVenueInvite',
    resourceId: invite.id,
    properties: { venueId: context.venue.id },
  });

  return toInvite(updated);
}

/**
 * Accept an invitation. The venue is derived from the invite, so this is the one
 * dashboard action that does not take a slug.
 */
async function acceptInvite({ token, user }, req) {
  const raw = String(token || '').trim();
  if (!raw) throw new AppError('Invitation token is missing', 400, { code: 'INVALID_INVITE' });

  const invite = await prisma.restaurantVenueInvite.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { venue: { select: { id: true, slug: true, name: true } } },
  });
  if (!invite) throw new AppError('This invitation link is not valid', 404, {
    code: 'INVITE_NOT_FOUND',
  });
  if (invite.status !== 'PENDING') {
    throw new AppError('This invitation has already been used or revoked', 409, {
      code: 'INVITE_NOT_PENDING',
    });
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    await prisma.restaurantVenueInvite.update({
      where: { id: invite.id },
      data: { status: 'EXPIRED' },
    });
    throw new AppError('This invitation has expired. Ask the owner to send a new one.', 410, {
      code: 'INVITE_EXPIRED',
    });
  }
  if (String(user.email || '').toLowerCase() !== invite.email.toLowerCase()) {
    throw new AppError(
      'Sign in with the email address this invitation was sent to',
      403,
      { code: 'INVITE_EMAIL_MISMATCH' },
    );
  }

  const membership = await prisma.$transaction(async (tx) => {
    const row = await tx.restaurantVenueMember.upsert({
      where: { venueId_userId: { venueId: invite.venueId, userId: user.id } },
      create: {
        venueId: invite.venueId,
        userId: user.id,
        role: invite.role,
        status: 'ACTIVE',
        createdById: invite.invitedById,
      },
      update: { role: invite.role, status: 'ACTIVE' },
    });
    await tx.restaurantVenueInvite.update({
      where: { id: invite.id },
      data: { status: 'ACCEPTED', acceptedById: user.id, acceptedAt: new Date() },
    });
    return row;
  });

  invalidate(invite.venue);
  await logActivity({
    userId: user.id,
    action: 'restaurantVenueInvite.accepted',
    resource: 'RestaurantVenueInvite',
    resourceId: invite.id,
    metadata: { venueId: invite.venueId, role: invite.role },
  });
  enqueueEvent({
    name: 'restaurant_venue_invite.accepted',
    userId: user.id,
    req,
    resource: 'RestaurantVenueInvite',
    resourceId: invite.id,
    properties: { venueId: invite.venueId, role: invite.role },
  });

  return {
    membership: { id: membership.id, role: membership.role, status: membership.status },
    venue: invite.venue,
  };
}

async function countOwners(venueId, tx = prisma) {
  return tx.restaurantVenueMember.count({ where: { venueId, status: 'ACTIVE', role: 'OWNER' } });
}

async function updateMemberRole(context, { memberId, role }, req) {
  assertOwner(context);
  const venueId = context.venue.id;

  if (!['OWNER', 'MANAGER'].includes(role)) {
    throw new AppError('Role must be owner or manager', 400, { code: 'INVALID_ROLE' });
  }

  const member = await prisma.restaurantVenueMember.findFirst({
    where: { id: memberId, venueId, status: 'ACTIVE' },
    select: { id: true, userId: true, role: true },
  });
  if (!member) throw new AppError('Team member not found', 404, { code: 'MEMBER_NOT_FOUND' });
  if (member.role === role) return { id: member.id, role };

  if (member.role === 'OWNER' && role === 'MANAGER') {
    const owners = await countOwners(venueId);
    if (owners <= 1) {
      throw new AppError('A listing needs at least one owner', 409, {
        code: 'LAST_OWNER',
      });
    }
  }

  const updated = await prisma.restaurantVenueMember.update({
    where: { id: member.id },
    data: { role },
  });

  invalidate(context.venue);
  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantVenueMember.roleChanged',
    resource: 'RestaurantVenueMember',
    resourceId: member.id,
    metadata: { venueId, previousRole: member.role, role },
  });
  enqueueEvent({
    name: 'restaurant_venue_member.role_changed',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantVenueMember',
    resourceId: member.id,
    properties: { venueId, role },
  });
  enqueueNotification({
    userId: member.userId,
    type: 'RESTAURANT_TEAM_ROLE_CHANGED',
    title: 'Your restaurant role changed',
    message: `You are now ${role === 'OWNER' ? 'an owner' : 'a manager'} of ${context.venue.name}.`,
    data: { venueId },
  }).catch((err) => logger.warn('[notification] role change failed:', err?.message));

  return { id: updated.id, role: updated.role };
}

async function removeMember(context, { memberId }, req) {
  assertOwner(context);
  const venueId = context.venue.id;

  const member = await prisma.restaurantVenueMember.findFirst({
    where: { id: memberId, venueId, status: 'ACTIVE' },
    select: { id: true, userId: true, role: true },
  });
  if (!member) throw new AppError('Team member not found', 404, { code: 'MEMBER_NOT_FOUND' });

  if (member.role === 'OWNER') {
    const owners = await countOwners(venueId);
    if (owners <= 1) {
      throw new AppError('You cannot remove the only owner', 409, { code: 'LAST_OWNER' });
    }
  }

  // Soft removal: the row stays so replies and audit entries keep an author.
  await prisma.restaurantVenueMember.update({
    where: { id: member.id },
    data: { status: 'REMOVED' },
  });

  invalidate(context.venue);
  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantVenueMember.removed',
    resource: 'RestaurantVenueMember',
    resourceId: member.id,
    metadata: { venueId, role: member.role },
  });
  enqueueEvent({
    name: 'restaurant_venue_member.removed',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantVenueMember',
    resourceId: member.id,
    properties: { venueId },
  });

  return { id: member.id, status: 'REMOVED' };
}

async function transferOwnership(context, { memberId }, req) {
  assertOwner(context);
  const venueId = context.venue.id;

  const target = await prisma.restaurantVenueMember.findFirst({
    where: { id: memberId, venueId, status: 'ACTIVE' },
    select: { id: true, userId: true, role: true },
  });
  if (!target) throw new AppError('Team member not found', 404, { code: 'MEMBER_NOT_FOUND' });
  if (target.userId === context.membership.userId) {
    throw new AppError('You already own this listing', 400, { code: 'ALREADY_OWNER' });
  }

  await prisma.$transaction(async (tx) => {
    await tx.restaurantVenueMember.update({
      where: { id: context.membership.id },
      data: { role: 'MANAGER' },
    });
    await tx.restaurantVenueMember.update({
      where: { id: target.id },
      data: { role: 'OWNER' },
    });
  });

  invalidate(context.venue);
  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantVenue.transferred',
    resource: 'RestaurantVenue',
    resourceId: venueId,
    metadata: { venueId, toMemberId: target.id },
  });
  enqueueEvent({
    name: 'restaurant_venue.ownership_transferred',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantVenue',
    resourceId: venueId,
    properties: { venueId, toMemberId: target.id },
  });
  enqueueNotification({
    userId: target.userId,
    type: 'RESTAURANT_OWNERSHIP_TRANSFERRED',
    title: 'You now own a restaurant listing',
    message: `You are now the owner of ${context.venue.name}.`,
    data: { venueId },
  }).catch((err) => logger.warn('[notification] transfer failed:', err?.message));

  return { venueId, previousOwnerMemberId: context.membership.id, ownerMemberId: target.id };
}

module.exports = {
  INVITE_TTL_DAYS,
  MAX_INVITE_TTL_DAYS,
  hashToken,
  listTeam,
  inviteMember,
  revokeInvite,
  acceptInvite,
  updateMemberRole,
  removeMember,
  transferOwnership,
};
