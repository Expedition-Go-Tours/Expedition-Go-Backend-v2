/**
 * The dashboard's permission boundary.
 *
 * These tests pin the two things that must never drift: a manager cannot reach
 * owner-only actions, and a slug in the URL never grants access on its own.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  restaurantVenue: { findFirst: jest.fn() },
  restaurantVenueMember: { findFirst: jest.fn() },
}));

jest.mock('../../src/core/services/restaurantVenueService', () => ({
  BRANDS: ['ghana', 'africa', 'expedition'],
}));

const prisma = require('../../src/core/services/prismaClient');
const access = require('../../src/core/services/restaurantVenueAccess');

const VENUE = {
  id: 'v1',
  slug: 'buka-accra',
  name: 'Buka',
  city: 'Accra',
  status: 'ACTIVE',
  photos: [],
  cuisines: [],
};

describe('restaurantVenueAccess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.restaurantVenue.findFirst.mockResolvedValue(VENUE);
    prisma.restaurantVenueMember.findFirst.mockResolvedValue({ id: 'm1', role: 'OWNER', status: 'ACTIVE' });
  });

  it('gives a manager every editing permission but no team management', () => {
    expect(access.permissionsFor('MANAGER')).toEqual(
      expect.arrayContaining([
        'venue.edit',
        'reviews.reply',
        'reviews.report',
        'photos.manage',
        'menu.manage',
        'team.view',
      ]),
    );
    expect(access.permissionsFor('MANAGER')).not.toContain('team.manage');
    expect(access.permissionsFor('MANAGER')).not.toContain('venue.transfer');
    expect(access.permissionsFor('MANAGER')).not.toContain('integrations.manage');
  });

  it('gives an owner the management permissions on top of editing', () => {
    expect(access.permissionsFor('OWNER')).toEqual(
      expect.arrayContaining(['team.manage', 'venue.transfer', 'integrations.manage', 'venue.delete']),
    );
  });

  it('returns nothing for an unknown role rather than defaulting to access', () => {
    expect(access.permissionsFor('CONTRACTOR')).toEqual([]);
    expect(access.can('CONTRACTOR', 'venue.edit')).toBe(false);
  });

  it('resolves a venue from membership, not from the slug alone', async () => {
    const context = await access.resolveManagedVenue({
      slugOrId: 'buka-accra',
      userId: 'u1',
      brand: 'ghana',
    });

    expect(context.venue.id).toBe('v1');
    expect(context.membership).toMatchObject({ role: 'OWNER', userId: 'u1' });
    expect(context.permissions).toContain('team.manage');
    expect(prisma.restaurantVenueMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', userId: 'u1', status: 'ACTIVE' } }),
    );
  });

  it('refuses a signed-in stranger even when the venue exists', async () => {
    prisma.restaurantVenueMember.findFirst.mockResolvedValue(null);

    await expect(
      access.resolveManagedVenue({ slugOrId: 'buka-accra', userId: 'u2', brand: 'ghana' }),
    ).rejects.toMatchObject({ errorCode: 'NOT_A_VENUE_MEMBER', statusCode: 403 });
  });

  it('refuses an anonymous caller', async () => {
    await expect(
      access.resolveManagedVenue({ slugOrId: 'buka-accra', brand: 'ghana' }),
    ).rejects.toMatchObject({ errorCode: 'AUTH_REQUIRED', statusCode: 401 });
  });

  it('refuses an unknown brand before touching the database', async () => {
    await expect(
      access.resolveManagedVenue({ slugOrId: 'buka-accra', userId: 'u1', brand: 'mars' }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_BRAND', statusCode: 400 });
    expect(prisma.restaurantVenue.findFirst).not.toHaveBeenCalled();
  });

  it('keeps a paused venue editable: the resolver does not require an active listing', async () => {
    prisma.restaurantVenue.findFirst.mockResolvedValue({ ...VENUE, status: 'PAUSED' });

    const context = await access.resolveManagedVenue({
      slugOrId: 'buka-accra',
      userId: 'u1',
      brand: 'ghana',
    });

    expect(context.venue.status).toBe('PAUSED');
    expect(prisma.restaurantVenue.findFirst.mock.calls[0][0].where).toEqual({
      OR: [{ slug: 'buka-accra' }, { id: 'buka-accra' }],
    });
  });

  it('blocks a manager from owner-only actions', () => {
    const context = {
      venue: VENUE,
      membership: { id: 'm1', userId: 'u1', role: 'MANAGER' },
      permissions: access.permissionsFor('MANAGER'),
    };

    expect(() => access.assertOwner(context)).toThrow(
      expect.objectContaining({ errorCode: 'VENUE_OWNER_ONLY', statusCode: 403 }),
    );
    expect(() => access.assertPermission(context, 'team.manage')).toThrow(
      expect.objectContaining({ errorCode: 'VENUE_PERMISSION_DENIED' }),
    );
    expect(() => access.assertPermission(context, 'reviews.reply')).not.toThrow();
  });
});
