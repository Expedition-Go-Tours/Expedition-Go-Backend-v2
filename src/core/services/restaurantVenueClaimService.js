/**
 * Restaurant claims and the small owner surface they unlock.
 *
 * A claim is a request, not a role. Only an admin can cross the boundary from
 * claim to membership, and every write to a claimed venue checks that
 * membership on the server. Owners may correct presentation fields; they never
 * touch ratings, ranking inputs or external aggregates.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const cache = require('./cacheHelper');
const logger = require('./logger');
const { enqueueEvent, enqueueNotification } = require('./queue');
const { logActivity } = require('./auditLogger');
const { notifyAdmin } = require('./adminNotificationService');
const { isValidCloudinaryUrl } = require('./cloudinaryHelper');
const { BRANDS, decodeReviewCursor, encodeCursor, toPublicVenue } = require('./restaurantVenueService');

async function resolveVenue(slugOrId, brand) {
  if (!BRANDS.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }
  const needle = String(slugOrId || '').trim();
  if (!needle) return null;

  return prisma.restaurantVenue.findFirst({
    where: {
      status: 'ACTIVE',
      listings: { some: { brand, isActive: true } },
      OR: [{ slug: needle }, { id: needle }],
    },
    select: { id: true, slug: true, name: true, city: true },
  });
}

function invalidate(venue) {
  cache
    .invalidateRestaurantVenueCaches(venue.id, venue.slug)
    .catch((err) => logger.warn('[cache] restaurant venue invalidation failed:', err?.message));
}

function toClaim(row) {
  return {
    id: row.id,
    venueId: row.venueId,
    userId: row.userId,
    brand: row.brand,
    businessName: row.businessName ?? null,
    role: row.role ?? null,
    contactEmail: row.contactEmail,
    phone: row.phone ?? null,
    message: row.message ?? null,
    evidenceUrl: row.evidenceUrl ?? null,
    status: row.status,
    reviewNote: row.reviewNote ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function cleanList(value, { lowercase = false, maxLength = 60 } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError('Expected a list of values', 400, { code: 'INVALID_LIST' });
  }
  return [...new Set(
    value
      .map((item) => String(item).trim())
      .filter(Boolean)
      .map((item) => (lowercase ? item.toLowerCase() : item))
      .filter((item) => item.length <= maxLength),
  )];
}

function cleanPhotoUrls(value, field) {
  if (value === undefined) return undefined;
  const urls = Array.isArray(value) ? value : [value];
  const cleaned = [...new Set(urls.filter(Boolean).map((item) => String(item).trim()))];
  if (cleaned.some((url) => !isValidCloudinaryUrl(url))) {
    throw new AppError(`${field} must be a Travio image URL`, 400, { code: 'INVALID_IMAGE_URL' });
  }
  return field === 'coverPhoto' ? (cleaned[0] ?? null) : cleaned;
}

async function submitClaim({ slugOrId, brand, claimant, input, req }) {
  const venue = await resolveVenue(slugOrId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });

  const existing = await prisma.restaurantVenueClaim.findFirst({
    where: {
      venueId: venue.id,
      userId: claimant.id,
      status: { in: ['PENDING', 'APPROVED'] },
    },
    select: { id: true, status: true },
  });
  if (existing) {
    throw new AppError(
      existing.status === 'APPROVED'
        ? 'You already manage this restaurant'
        : 'You already have a pending claim for this restaurant',
      409,
      { code: existing.status === 'APPROVED' ? 'ALREADY_A_MEMBER' : 'CLAIM_ALREADY_PENDING' },
    );
  }

  const claim = await prisma.restaurantVenueClaim.create({
    data: {
      venueId: venue.id,
      userId: claimant.id,
      brand,
      businessName: input.businessName ? String(input.businessName).trim() : null,
      role: input.role ? String(input.role).trim() : null,
      contactEmail: String(input.contactEmail || claimant.email || '').trim().toLowerCase(),
      phone: input.phone ? String(input.phone).trim() : null,
      message: input.message ? String(input.message).trim() : null,
      evidenceUrl: input.evidenceUrl ? String(input.evidenceUrl).trim() : null,
      status: 'PENDING',
    },
  });

  await logActivity({
    userId: claimant.id,
    action: 'restaurantVenueClaim.submitted',
    resource: 'RestaurantVenueClaim',
    resourceId: claim.id,
    metadata: { venueId: venue.id, brand },
  });
  enqueueEvent({
    name: 'restaurant_venue_claim.submitted',
    userId: claimant.id,
    req,
    resource: 'RestaurantVenueClaim',
    resourceId: claim.id,
    properties: { venueId: venue.id, venueName: venue.name, brand },
  });
  notifyAdmin({
    type: 'RESTAURANT_VENUE_CLAIM_PENDING',
    title: 'Restaurant claim needs review',
    message: `Someone asked to manage ${venue.name}. Check their evidence before approving.`,
    data: { claimId: claim.id, venueId: venue.id },
  }).catch((err) => logger.warn('[admin] claim notification failed:', err?.message));

  return toClaim(claim);
}

async function getMyClaim({ slugOrId, brand, claimant }) {
  const venue = await resolveVenue(slugOrId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });

  const [claim, membership] = await Promise.all([
    prisma.restaurantVenueClaim.findFirst({
      where: { venueId: venue.id, userId: claimant.id },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.restaurantVenueMember.findFirst({
      where: { venueId: venue.id, userId: claimant.id, status: 'ACTIVE' },
      select: { id: true, role: true, status: true },
    }),
  ]);

  return {
    claim: claim ? toClaim(claim) : null,
    membership: membership || null,
    venue: { id: venue.id, slug: venue.slug, name: venue.name, city: venue.city },
  };
}

async function listPendingClaims({ limit = 20, cursor } = {}) {
  const decoded = cursor ? decodeReviewCursor(cursor) : null;
  const where = { status: 'PENDING' };
  if (decoded) {
    where.OR = [
      { createdAt: { lt: decoded.at } },
      { AND: [{ createdAt: decoded.at }, { id: { lt: decoded.id } }] },
    ];
  }

  const rows = await prisma.restaurantVenueClaim.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: {
      venue: { select: { name: true, slug: true, city: true } },
      user: { select: { name: true, email: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    claims: page.map((row) => ({
      ...toClaim(row),
      venueName: row.venue ? row.venue.name : null,
      venueSlug: row.venue ? row.venue.slug : null,
      venueCity: row.venue ? row.venue.city : null,
      claimantName: row.user ? row.user.name : null,
      claimantEmail: row.user ? row.user.email : null,
    })),
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ c: last.createdAt.toISOString(), id: last.id })
          : null,
    },
  };
}

async function resolveClaim({ claimId, adminId, action, note, req }) {
  const nextStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
  if (!['approve', 'reject'].includes(action)) {
    throw new AppError('Invalid claim action', 400, { code: 'INVALID_CLAIM_ACTION' });
  }

  const claim = await prisma.restaurantVenueClaim.findUnique({
    where: { id: claimId },
    include: { venue: { select: { id: true, slug: true, name: true, city: true } } },
  });
  if (!claim) throw new AppError('Claim not found', 404, { code: 'CLAIM_NOT_FOUND' });
  if (claim.status !== 'PENDING') {
    throw new AppError('This claim has already been reviewed', 409, {
      code: 'CLAIM_ALREADY_REVIEWED',
    });
  }

  let membership = null;
  await prisma.$transaction(async (tx) => {
    await tx.restaurantVenueClaim.update({
      where: { id: claim.id },
      data: {
        status: nextStatus,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        reviewNote: note ? String(note).trim() : null,
      },
    });

    if (action === 'approve') {
      membership = await tx.restaurantVenueMember.upsert({
        where: { venueId_userId: { venueId: claim.venueId, userId: claim.userId } },
        create: {
          venueId: claim.venueId,
          userId: claim.userId,
          role: 'OWNER',
          status: 'ACTIVE',
          createdById: adminId,
        },
        update: { role: 'OWNER', status: 'ACTIVE' },
      });
    }
  });

  await logActivity({
    userId: adminId,
    action: `restaurantVenueClaim.${action}`,
    resource: 'RestaurantVenueClaim',
    resourceId: claim.id,
    metadata: { venueId: claim.venueId, previousStatus: claim.status, note: note || null },
  });
  enqueueEvent({
    name: `restaurant_venue_claim.${action}`,
    userId: adminId,
    req,
    resource: 'RestaurantVenueClaim',
    resourceId: claim.id,
    properties: { venueId: claim.venueId, brand: claim.brand },
  });
  enqueueNotification({
    userId: claim.userId,
    type: 'RESTAURANT_CLAIM_UPDATE',
    title: action === 'approve' ? 'You can now manage this restaurant' : 'Restaurant claim update',
    message: action === 'approve'
      ? `Your claim for ${claim.venue.name} was approved. You can update its details now.`
      : `We could not verify your claim for ${claim.venue.name}. You can submit more evidence.`,
    data: { claimId: claim.id, venueId: claim.venueId, venueSlug: claim.venue.slug },
  }).catch((err) => logger.warn('[notification] claim update failed:', err?.message));

  return {
    ...toClaim({ ...claim, status: nextStatus }),
    membership: membership
      ? { id: membership.id, role: membership.role, status: membership.status }
      : null,
  };
}

async function listMyVenues({ claimant }) {
  const memberships = await prisma.restaurantVenueMember.findMany({
    where: { userId: claimant.id, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    include: {
      venue: {
        include: {
          listings: { where: { isActive: true }, take: 1 },
          externalStats: true,
        },
      },
    },
  });

  return {
    venues: memberships.map((membership) => ({
      membership: { id: membership.id, role: membership.role, status: membership.status },
      venue: toPublicVenue(membership.venue, { detail: true }),
    })),
  };
}

async function updateOwnVenue({ slugOrId, brand, editor, input, req }) {
  const venue = await resolveVenue(slugOrId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });

  const membership = await prisma.restaurantVenueMember.findFirst({
    where: { venueId: venue.id, userId: editor.id, status: 'ACTIVE' },
    select: { id: true, role: true },
  });
  if (!membership) {
    throw new AppError('You do not manage this restaurant', 403, { code: 'NOT_A_VENUE_MEMBER' });
  }

  const data = {};
  if (input.description !== undefined) data.description = String(input.description).trim() || null;
  if (input.phone !== undefined) data.phone = String(input.phone).trim() || null;
  if (input.website !== undefined) data.website = String(input.website).trim() || null;
  if (input.hours !== undefined) data.hours = input.hours;

  const cuisines = cleanList(input.cuisines);
  const dietary = cleanList(input.dietary, { lowercase: true });
  const amenities = cleanList(input.amenities);
  if (cuisines !== undefined) data.cuisines = cuisines;
  if (dietary !== undefined) data.dietary = dietary;
  if (amenities !== undefined) data.amenities = amenities;

  const photos = cleanPhotoUrls(input.photos, 'photos');
  const coverPhoto = cleanPhotoUrls(input.coverPhoto, 'coverPhoto');
  if (photos !== undefined) data.photos = photos;
  if (coverPhoto !== undefined) {
    data.coverPhoto = coverPhoto;
    if (coverPhoto && photos && !photos.includes(coverPhoto)) {
      throw new AppError('The cover photo must also be in the photo list', 400, {
        code: 'COVER_PHOTO_NOT_IN_PHOTOS',
      });
    }
  }

  if (Object.keys(data).length === 0) {
    throw new AppError('Nothing to update', 400, { code: 'EMPTY_UPDATE' });
  }

  const updated = await prisma.restaurantVenue.update({
    where: { id: venue.id },
    data,
    include: {
      listings: { where: { brand }, take: 1 },
      externalStats: true,
    },
  });

  invalidate(venue);

  await logActivity({
    userId: editor.id,
    action: 'restaurantVenue.updatedByOwner',
    resource: 'RestaurantVenue',
    resourceId: venue.id,
    metadata: { fields: Object.keys(data), membershipId: membership.id },
  });
  enqueueEvent({
    name: 'restaurant_venue.updated_by_owner',
    userId: editor.id,
    req,
    resource: 'RestaurantVenue',
    resourceId: venue.id,
    properties: { fields: Object.keys(data) },
  });

  return { venue: toPublicVenue(updated, { detail: true }) };
}

module.exports = {
  submitClaim,
  getMyClaim,
  listPendingClaims,
  resolveClaim,
  listMyVenues,
  updateOwnVenue,
};
