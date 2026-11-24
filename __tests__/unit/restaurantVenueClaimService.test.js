/**
 * Claims are requests until an admin approves them. These tests pin that
 * boundary and the owner-write check that follows it.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  $transaction: jest.fn(),
  restaurantVenue: { findFirst: jest.fn(), update: jest.fn() },
  restaurantVenueClaim: { findFirst: jest.fn(), create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  restaurantVenueMember: { findFirst: jest.fn(), upsert: jest.fn(), findMany: jest.fn() },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  invalidateRestaurantVenueCaches: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/cloudinaryHelper', () => ({
  isValidCloudinaryUrl: jest.fn((url) => String(url).includes('res.cloudinary.com')),
}));

jest.mock('../../src/core/services/restaurantVenueService', () => ({
  BRANDS: ['ghana', 'africa', 'expedition'],
  encodeCursor: jest.fn(() => 'next'),
  decodeReviewCursor: jest.fn(() => null),
  toPublicVenue: jest.fn((venue) => ({ id: venue.id, name: venue.name })),
}));

const prisma = require('../../src/core/services/prismaClient');
const claims = require('../../src/core/services/restaurantVenueClaimService');

const VENUE = { id: 'v1', slug: 'buka-accra', name: 'Buka', city: 'Accra' };
const USER = { id: 'u1', email: 'owner@example.com' };
const REQ = { headers: {} };

describe('restaurantVenueClaimService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((fn) => fn(prisma));
    prisma.restaurantVenue.findFirst.mockResolvedValue(VENUE);
    prisma.restaurantVenueClaim.findFirst.mockResolvedValue(null);
    prisma.restaurantVenueClaim.create.mockImplementation((args) =>
      Promise.resolve({ ...args.data, id: 'c1', createdAt: new Date(), updatedAt: new Date() }),
    );
    prisma.restaurantVenueClaim.findUnique.mockResolvedValue(null);
    prisma.restaurantVenueMember.findFirst.mockResolvedValue(null);
    prisma.restaurantVenueMember.upsert.mockImplementation((args) =>
      Promise.resolve({ id: 'm1', ...args.create }),
    );
  });

  it('stores a claim as pending and never grants access on submit', async () => {
    const claim = await claims.submitClaim({
      slugOrId: 'buka-accra',
      brand: 'ghana',
      claimant: USER,
      input: {
        businessName: 'Buka Limited',
        role: 'Manager',
        message: 'I manage this restaurant and can provide the business registration.',
        contactEmail: 'OWNER@EXAMPLE.COM',
      },
      req: REQ,
    });

    expect(claim).toMatchObject({ status: 'PENDING', contactEmail: 'owner@example.com' });
    expect(prisma.restaurantVenueMember.upsert).not.toHaveBeenCalled();
  });

  it('refuses a second pending claim from the same person', async () => {
    prisma.restaurantVenueClaim.findFirst.mockResolvedValue({ id: 'c1', status: 'PENDING' });

    await expect(
      claims.submitClaim({
        slugOrId: 'buka-accra',
        brand: 'ghana',
        claimant: USER,
        input: { message: 'Let me manage this restaurant, please.' },
        req: REQ,
      }),
    ).rejects.toMatchObject({ errorCode: 'CLAIM_ALREADY_PENDING', statusCode: 409 });
    expect(prisma.restaurantVenueClaim.create).not.toHaveBeenCalled();
  });

  it('creates an owner membership only when an admin approves', async () => {
    const claim = {
      id: 'c1',
      venueId: 'v1',
      userId: 'u1',
      brand: 'ghana',
      status: 'PENDING',
      venue: VENUE,
    };
    prisma.restaurantVenueClaim.findUnique.mockResolvedValue(claim);

    const result = await claims.resolveClaim({
      claimId: 'c1',
      adminId: 'admin1',
      action: 'approve',
      req: REQ,
    });

    expect(result.status).toBe('APPROVED');
    expect(result.membership).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
    expect(prisma.restaurantVenueMember.upsert).toHaveBeenCalled();
  });

  it('blocks venue edits until the signed-in user has an active membership', async () => {
    await expect(
      claims.updateOwnVenue({
        slugOrId: 'buka-accra',
        brand: 'ghana',
        editor: USER,
        input: { phone: '+233201234567' },
        req: REQ,
      }),
    ).rejects.toMatchObject({ errorCode: 'NOT_A_VENUE_MEMBER', statusCode: 403 });
    expect(prisma.restaurantVenue.update).not.toHaveBeenCalled();
  });
});
