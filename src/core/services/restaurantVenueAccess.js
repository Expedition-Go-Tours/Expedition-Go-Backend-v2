/**
 * Restaurant venue access control for the owner dashboard.
 *
 * Two rules decide everything here:
 *
 *   - membership is resolved on the server from the authenticated user, never
 *     from a slug, a body field or a client-supplied role;
 *   - the dashboard resolves a venue by slug/id + membership only. Unlike the
 *     storefront resolver it does not require an ACTIVE listing, because an
 *     owner must still be able to fix a paused or unpublished listing.
 *
 * The permission list is the single source of truth for both the API and the
 * `permissions` array the dashboard shell renders its navigation from. Adding a
 * page means adding a permission here, not a second `if (role === 'OWNER')`.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const { BRANDS } = require('./restaurantVenueService');

const PERMISSIONS = Object.freeze({
  OWNER: Object.freeze([
    'venue.edit',
    'reviews.reply',
    'reviews.report',
    'photos.manage',
    'menu.manage',
    'team.view',
    'team.manage',
    'integrations.manage',
    'venue.transfer',
    'venue.delete',
  ]),
  MANAGER: Object.freeze([
    'venue.edit',
    'reviews.reply',
    'reviews.report',
    'photos.manage',
    'menu.manage',
    'team.view',
  ]),
});

/** Permission strings a role holds. Unknown roles get nothing, not everything. */
function permissionsFor(role) {
  return [...(PERMISSIONS[role] || [])];
}

function can(role, permission) {
  return (PERMISSIONS[role] || []).includes(permission);
}

const VENUE_SELECT = {
  id: true,
  slug: true,
  name: true,
  city: true,
  region: true,
  status: true,
  timezone: true,
  coverPhoto: true,
  photos: true,
  phone: true,
  website: true,
  description: true,
  menuUrl: true,
  hours: true,
  cuisines: true,
  dietary: true,
  amenities: true,
  mealTypes: true,
  averageRating: true,
  reviewCount: true,
  verifiedReviewCount: true,
  distribution: true,
  lastReviewAt: true,
  rankInCity: true,
  cityVenueCount: true,
  updatedAt: true,
};

/**
 * Resolve the venue the caller manages.
 *
 * @returns {{ venue: object, membership: { id: string, role: string }, permissions: string[] }}
 */
async function resolveManagedVenue({ slugOrId, userId, brand } = {}) {
  if (brand !== undefined && brand !== null && !BRANDS.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }

  const needle = String(slugOrId || '').trim();
  if (!needle) {
    throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });
  }
  if (!userId) {
    throw new AppError('Sign in to manage this restaurant', 401, { code: 'AUTH_REQUIRED' });
  }

  const venue = await prisma.restaurantVenue.findFirst({
    where: { OR: [{ slug: needle }, { id: needle }] },
    select: VENUE_SELECT,
  });
  if (!venue) {
    throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });
  }

  const membership = await prisma.restaurantVenueMember.findFirst({
    where: { venueId: venue.id, userId, status: 'ACTIVE' },
    select: { id: true, role: true, status: true },
  });
  if (!membership) {
    throw new AppError('You do not manage this restaurant', 403, {
      code: 'NOT_A_VENUE_MEMBER',
    });
  }

  return {
    venue,
    membership: {
      id: membership.id,
      userId,
      role: membership.role,
      status: membership.status,
    },
    permissions: permissionsFor(membership.role),
  };
}

/** Throw unless the resolved membership holds `permission`. */
function assertPermission(context, permission) {
  if (!can(context.membership.role, permission)) {
    throw new AppError('You do not have permission to do that', 403, {
      code: 'VENUE_PERMISSION_DENIED',
      details: { permission, role: context.membership.role },
    });
  }
}

/** Owner-only guard used by team, integrations and transfer routes. */
function assertOwner(context) {
  if (context.membership.role !== 'OWNER') {
    throw new AppError('Only the owner can do that', 403, {
      code: 'VENUE_OWNER_ONLY',
    });
  }
}

/** Shape shared by every dashboard response so the shell never guesses. */
function toSession(context) {
  const { venue, membership, permissions } = context;
  return {
    venue: {
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      city: venue.city,
      region: venue.region,
      status: venue.status,
      timezone: venue.timezone,
      coverPhoto: venue.coverPhoto,
      rating: venue.averageRating == null ? null : Math.round(venue.averageRating * 10) / 10,
      reviewCount: venue.reviewCount || 0,
      rank:
        venue.rankInCity != null
          ? { position: venue.rankInCity, of: venue.cityVenueCount || null }
          : null,
      // The editable presentation fields. Kept in the authenticated session so
      // the dashboard never has to fall back to the public detail endpoint,
      // which intentionally hides PAUSED and CLOSED listings.
      details: {
        description: venue.description || null,
        phone: venue.phone || null,
        website: venue.website || null,
        menuUrl: venue.menuUrl || null,
        hours: venue.hours || null,
        cuisines: venue.cuisines || [],
        dietary: venue.dietary || [],
        amenities: venue.amenities || [],
        mealTypes: venue.mealTypes || [],
        photos: venue.photos || [],
        coverPhoto: venue.coverPhoto || null,
      },
    },
    membership: { id: membership.id, role: membership.role },
    permissions,
  };
}

module.exports = {
  PERMISSIONS,
  permissionsFor,
  can,
  assertPermission,
  assertOwner,
  resolveManagedVenue,
  toSession,
  VENUE_SELECT,
};
