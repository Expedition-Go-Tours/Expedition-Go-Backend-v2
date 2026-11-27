/**
 * Owner photo library.
 *
 * The public gallery is a projection, so the tests that matter are the ones
 * about what lands in `RestaurantVenue.photos`: only PUBLISHED rows, in gallery
 * order, with a cover that still exists.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  $transaction: jest.fn(),
  restaurantVenuePhoto: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  restaurantVenue: { findUnique: jest.fn(), update: jest.fn() },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  invalidateRestaurantVenueCaches: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/queue', () => ({ enqueueEvent: jest.fn() }));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/cloudinaryHelper', () => ({
  isValidCloudinaryUrl: jest.fn((url) => String(url).includes('res.cloudinary.com')),
}));

jest.mock('../../src/core/services/restaurantVenueAccess', () => ({
  assertPermission: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const photos = require('../../src/core/services/restaurantVenuePhotoService');

const CONTEXT = {
  venue: { id: 'v1', slug: 'buka-accra', name: 'Buka', coverPhoto: null },
  membership: { id: 'm1', userId: 'u1', role: 'OWNER' },
  permissions: ['photos.manage'],
};

describe('restaurantVenuePhotoService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((fn) => fn(prisma));
    prisma.restaurantVenue.update.mockResolvedValue({});
    prisma.restaurantVenue.findUnique.mockResolvedValue({ coverPhoto: null });
  });

  it('projects only published photos, in gallery order', async () => {
    prisma.restaurantVenuePhoto.findMany.mockResolvedValue([
      { url: 'https://res.cloudinary.com/x/1.jpg' },
      { url: 'https://res.cloudinary.com/x/2.jpg' },
    ]);

    const result = await photos.syncPublishedPhotos(prisma, 'v1');

    expect(result.photos).toEqual([
      'https://res.cloudinary.com/x/1.jpg',
      'https://res.cloudinary.com/x/2.jpg',
    ]);
    expect(result.coverPhoto).toBe('https://res.cloudinary.com/x/1.jpg');
    expect(prisma.restaurantVenuePhoto.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', status: 'PUBLISHED' } }),
    );
  });

  it('keeps the current cover when it is still published', async () => {
    prisma.restaurantVenuePhoto.findMany.mockResolvedValue([
      { url: 'https://res.cloudinary.com/x/1.jpg' },
      { url: 'https://res.cloudinary.com/x/2.jpg' },
    ]);
    prisma.restaurantVenue.findUnique.mockResolvedValue({
      coverPhoto: 'https://res.cloudinary.com/x/2.jpg',
    });

    const result = await photos.syncPublishedPhotos(prisma, 'v1');

    expect(result.coverPhoto).toBe('https://res.cloudinary.com/x/2.jpg');
  });

  it('drops a cover that is no longer published', async () => {
    prisma.restaurantVenuePhoto.findMany.mockResolvedValue([
      { url: 'https://res.cloudinary.com/x/1.jpg' },
    ]);
    prisma.restaurantVenue.findUnique.mockResolvedValue({
      coverPhoto: 'https://res.cloudinary.com/x/gone.jpg',
    });

    const result = await photos.syncPublishedPhotos(prisma, 'v1');

    expect(result.coverPhoto).toBe('https://res.cloudinary.com/x/1.jpg');
  });

  it('refuses a URL that was not uploaded to Travio', async () => {
    await expect(
      photos.addPhotos(CONTEXT, { urls: ['https://example.com/hotlink.jpg'] }, { headers: {} }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_IMAGE_URL', statusCode: 400 });
  });

  it('enforces the gallery limit', async () => {
    prisma.restaurantVenuePhoto.count.mockResolvedValue(39);

    await expect(
      photos.addPhotos(
        CONTEXT,
        {
          urls: [
            'https://res.cloudinary.com/x/1.jpg',
            'https://res.cloudinary.com/x/2.jpg',
          ],
        },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'PHOTO_LIMIT_REACHED' });
  });

  it('queues an owner upload as PENDING and not public', async () => {
    prisma.restaurantVenuePhoto.count.mockResolvedValue(0);
    prisma.restaurantVenuePhoto.findFirst.mockResolvedValue(null);
    prisma.restaurantVenuePhoto.upsert.mockImplementation((args) =>
      Promise.resolve({ id: 'p1', createdAt: new Date(), ...args.create }),
    );

    const result = await photos.addPhotos(
      CONTEXT,
      { urls: ['https://res.cloudinary.com/x/1.jpg'] },
      { headers: {} },
    );

    expect(result.photos[0]).toMatchObject({ status: 'PENDING', position: 1 });
    expect(prisma.restaurantVenue.update).not.toHaveBeenCalled();
  });

  it('rejects an order that does not list every photo exactly once', async () => {
    prisma.restaurantVenuePhoto.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);

    await expect(
      photos.reorderPhotos(CONTEXT, { photoIds: ['p1'] }),
    ).rejects.toMatchObject({ errorCode: 'INCOMPLETE_ORDER' });
  });

  it('refuses to make an unpublished photo the cover', async () => {
    prisma.restaurantVenuePhoto.findFirst.mockResolvedValue({
      id: 'p1',
      url: 'https://res.cloudinary.com/x/1.jpg',
      status: 'PENDING',
    });

    await expect(
      photos.setCoverPhoto(CONTEXT, { photoId: 'p1' }),
    ).rejects.toMatchObject({ errorCode: 'PHOTO_NOT_PUBLISHED', statusCode: 409 });
  });

  it('publishes a photo through moderation and refreshes the projection', async () => {
    prisma.restaurantVenuePhoto.findUnique.mockResolvedValue({
      id: 'p1',
      venueId: 'v1',
      status: 'PENDING',
      venue: { id: 'v1', slug: 'buka-accra', name: 'Buka' },
    });
    prisma.restaurantVenuePhoto.update.mockResolvedValue({ id: 'p1', status: 'PUBLISHED' });
    prisma.restaurantVenuePhoto.findMany.mockResolvedValue([
      { url: 'https://res.cloudinary.com/x/1.jpg' },
    ]);

    const result = await photos.moderatePhoto({
      photoId: 'p1',
      adminId: 'admin1',
      action: 'publish',
      req: { headers: {} },
    });

    expect(prisma.restaurantVenuePhoto.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PUBLISHED', moderatedBy: 'admin1' }),
      }),
    );
    expect(result.photos).toEqual(['https://res.cloudinary.com/x/1.jpg']);
  });
});
