jest.mock('../../utils/prismaClient', () => {
  const tour = { findMany: jest.fn(), delete: jest.fn() };
  const booking = { findFirst: jest.fn(), deleteMany: jest.fn() };
  const review = { deleteMany: jest.fn() };
  const payout = { deleteMany: jest.fn() };
  return {
    tour,
    booking,
    review,
    payout,
    $transaction: jest.fn((fn) => fn({ payout, review, booking, tour })),
  };
});

jest.mock('../../utils/cloudinaryHelper', () => ({
  deleteCloudinaryImage: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/cacheHelper', () => ({
  invalidateTourCaches: jest.fn(() => Promise.resolve()),
}));

const prisma = require('../../utils/prismaClient');
const { deleteCloudinaryImage } = require('../../utils/cloudinaryHelper');
const { invalidateTourCaches } = require('../../utils/cacheHelper');
const { purgeArchivedTours } = require('../../utils/tourPurge');

const archivedTour = (overrides = {}) => ({
  id: 't1',
  title: 'Purge Me',
  slug: 'purge-me',
  photos: ['https://res.cloudinary.com/demo/image/upload/tours/a.jpg'],
  coverPhoto: 'https://res.cloudinary.com/demo/image/upload/tours/cover.jpg',
  ...overrides,
});

describe('purgeArchivedTours', () => {
  const now = new Date('2026-08-15T00:00:00Z');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    prisma.tour.findMany.mockResolvedValue([]);
    prisma.booking.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns zeros when no archived tours qualify', async () => {
    const result = await purgeArchivedTours({ now });

    expect(prisma.tour.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ARCHIVED',
          updatedAt: { lt: expect.any(Date) },
          supplier: { supplierProfile: { archiveSnapshot: null } },
        }),
      })
    );
    expect(result).toEqual({ scanned: 0, purged: 0, skipped: 0, failed: 0 });
  });

  it('purges an archived tour with no bookings and removes its photos', async () => {
    prisma.tour.findMany.mockResolvedValue([archivedTour()]);

    const result = await purgeArchivedTours({ now });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.payout.deleteMany).toHaveBeenCalledWith({ where: { booking: { tourId: 't1' } } });
    expect(prisma.review.deleteMany).toHaveBeenCalledWith({ where: { tourId: 't1' } });
    expect(prisma.booking.deleteMany).toHaveBeenCalledWith({ where: { tourId: 't1' } });
    expect(prisma.tour.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
    expect(deleteCloudinaryImage).toHaveBeenCalledWith(
      'https://res.cloudinary.com/demo/image/upload/tours/a.jpg',
      3,
      { tourId: 't1' }
    );
    expect(deleteCloudinaryImage).toHaveBeenCalledWith(
      'https://res.cloudinary.com/demo/image/upload/tours/cover.jpg',
      3,
      { tourId: 't1' }
    );
    expect(invalidateTourCaches).toHaveBeenCalledWith('t1', 'purge-me');
    expect(result).toEqual({ scanned: 1, purged: 1, skipped: 0, failed: 0 });
  });

  it('purges a tour whose bookings are all simulated', async () => {
    prisma.tour.findMany.mockResolvedValue([archivedTour()]);
    prisma.booking.findFirst.mockResolvedValue(null);

    await purgeArchivedTours({ now });

    expect(prisma.booking.findFirst).toHaveBeenCalledWith({
      where: { tourId: 't1', isSimulated: false },
      select: { id: true },
    });
    expect(prisma.tour.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
  });

  it('skips tours that still have a real (non-simulated) booking', async () => {
    prisma.tour.findMany.mockResolvedValue([archivedTour()]);
    prisma.booking.findFirst.mockResolvedValue({ id: 'b-real' });

    const result = await purgeArchivedTours({ now });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(deleteCloudinaryImage).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, purged: 0, skipped: 1, failed: 0 });
  });

  it('skips tours still referenced by a related record (P2003) and keeps photos', async () => {
    prisma.tour.findMany.mockResolvedValue([archivedTour()]);
    prisma.tour.delete.mockRejectedValue(Object.assign(new Error('FK violation'), { code: 'P2003', meta: { field_name: 'Review_tourId_fkey' } }));

    const result = await purgeArchivedTours({ now });

    expect(deleteCloudinaryImage).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, purged: 0, skipped: 1, failed: 0 });
  });

  it('counts unexpected errors as failed', async () => {
    prisma.tour.findMany.mockResolvedValue([archivedTour()]);
    prisma.tour.delete.mockRejectedValue(new Error('db exploded'));

    const result = await purgeArchivedTours({ now });

    expect(deleteCloudinaryImage).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, purged: 0, skipped: 0, failed: 1 });
  });
});