/**
 * Admin offer contract: brand/venue scoping, window validation and cache
 * invalidation. Prisma and the cache are mocked; no database is involved.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  restaurantVenue: { findFirst: jest.fn() },
  restaurantVenueOffer: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateRestaurantVenueCaches: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/logger', () => ({ warn: jest.fn() }));

const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');
const {
  normalizeOfferData,
  listOffers,
  createOffer,
  updateOffer,
  deleteOffer,
} = require('../../src/core/services/restaurantVenueOfferService');

const venue = { id: 'v1', slug: 'buka' };

function offerRow(overrides = {}) {
  return {
    id: 'o1',
    venueId: 'v1',
    brand: 'ghana',
    title: '20% off your table',
    discountType: 'PERCENTAGE',
    discountValue: 20,
    promoCode: 'GHANA20',
    startsAt: new Date('2026-11-01T00:00:00.000Z'),
    endsAt: new Date('2026-12-01T00:00:00.000Z'),
    isActive: true,
    terms: 'Dine-in only',
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  };
}

const validInput = {
  brand: 'ghana',
  title: '20% off your table',
  discountType: 'PERCENTAGE',
  discountValue: 20,
  promoCode: 'GHANA20',
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-12-01T00:00:00.000Z',
  isActive: true,
  terms: 'Dine-in only',
};

describe('restaurantVenueOfferService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.restaurantVenue.findFirst.mockResolvedValue(venue);
    prisma.restaurantVenueOffer.findFirst.mockResolvedValue(null);
    prisma.restaurantVenueOffer.findMany.mockResolvedValue([]);
    prisma.restaurantVenueOffer.create.mockImplementation(({ data }) =>
      Promise.resolve(offerRow(data)),
    );
    prisma.restaurantVenueOffer.update.mockImplementation(({ data }) =>
      Promise.resolve(offerRow(data)),
    );
    prisma.restaurantVenueOffer.delete.mockResolvedValue({ id: 'o1' });
    cache.invalidateRestaurantVenueCaches.mockResolvedValue();
  });

  describe('normalizeOfferData', () => {
    it('normalises dates and rejects an end before the start', () => {
      expect(normalizeOfferData(validInput).startsAt).toEqual(new Date(validInput.startsAt));
      expect(() =>
        normalizeOfferData({
          ...validInput,
          startsAt: '2026-12-01T00:00:00.000Z',
          endsAt: '2026-11-01T00:00:00.000Z',
        }),
      ).toThrow(/endsAt must be after startsAt/);
    });

    it('rejects a non-positive discount and an unknown type', () => {
      expect(() => normalizeOfferData({ ...validInput, discountValue: 0 })).toThrow(
        /discountValue must be positive/,
      );
      expect(() => normalizeOfferData({ ...validInput, discountType: 'FREE' })).toThrow(
        /discountType must be PERCENTAGE or FIXED/,
      );
    });

    it('validates the merged window on a partial update', () => {
      const existing = offerRow();
      expect(() =>
        normalizeOfferData({ endsAt: '2026-09-01T00:00:00.000Z' }, existing, true),
      ).toThrow(/endsAt must be after startsAt/);
      expect(normalizeOfferData({ endsAt: '2027-01-01T00:00:00.000Z' }, existing, true)).toEqual({
        endsAt: new Date('2027-01-01T00:00:00.000Z'),
      });
    });
  });

  describe('listOffers', () => {
    it('scopes to the venue and brand listing', async () => {
      prisma.restaurantVenueOffer.findMany.mockResolvedValue([offerRow()]);

      const offers = await listOffers({ venueId: 'v1', brand: 'ghana' });

      expect(prisma.restaurantVenue.findFirst).toHaveBeenCalledWith({
        where: { id: 'v1', listings: { some: { brand: 'ghana' } } },
        select: { id: true, slug: true },
      });
      expect(prisma.restaurantVenueOffer.findMany).toHaveBeenCalledWith({
        where: { venueId: 'v1', brand: 'ghana' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(offers[0].id).toBe('o1');
    });

    it('returns null rather than an empty list for an unknown venue', async () => {
      prisma.restaurantVenue.findFirst.mockResolvedValue(null);

      await expect(listOffers({ venueId: 'missing', brand: 'ghana' })).resolves.toBeNull();
      expect(prisma.restaurantVenueOffer.findMany).not.toHaveBeenCalled();
    });
  });

  describe('createOffer', () => {
    it('stamps the venue/brand from the route and invalidates caches', async () => {
      const offer = await createOffer({ venueId: 'v1', brand: 'ghana', input: validInput });

      expect(prisma.restaurantVenueOffer.create).toHaveBeenCalledWith({
        data: {
          venueId: 'v1',
          brand: 'ghana',
          title: validInput.title,
          discountType: 'PERCENTAGE',
          discountValue: 20,
          promoCode: 'GHANA20',
          startsAt: new Date(validInput.startsAt),
          endsAt: new Date(validInput.endsAt),
          isActive: true,
          terms: 'Dine-in only',
        },
      });
      expect(cache.invalidateRestaurantVenueCaches).toHaveBeenCalledWith('v1', 'buka');
      expect(offer.id).toBe('o1');
      expect(offer.terms).toBe('Dine-in only');
    });

    it('refuses a brand that does not match the listing', async () => {
      await expect(
        createOffer({ venueId: 'v1', brand: 'ghana', input: { ...validInput, brand: 'africa' } }),
      ).rejects.toThrow(/brand does not match/);
      expect(prisma.restaurantVenueOffer.create).not.toHaveBeenCalled();
    });

    it('404s a venue without the requested brand listing', async () => {
      prisma.restaurantVenue.findFirst.mockResolvedValue(null);

      await expect(
        createOffer({ venueId: 'missing', brand: 'ghana', input: validInput }),
      ).rejects.toThrow(/Venue not found/);
    });
  });

  describe('updateOffer', () => {
    it('updates only the offer on that venue and brand, then invalidates', async () => {
      prisma.restaurantVenueOffer.findFirst.mockResolvedValue(offerRow());

      const offer = await updateOffer({
        venueId: 'v1',
        brand: 'ghana',
        offerId: 'o1',
        input: { discountValue: 25 },
      });

      expect(prisma.restaurantVenueOffer.findFirst).toHaveBeenCalledWith({
        where: { id: 'o1', venueId: 'v1', brand: 'ghana' },
      });
      expect(prisma.restaurantVenueOffer.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { discountValue: 25 },
      });
      expect(cache.invalidateRestaurantVenueCaches).toHaveBeenCalledWith('v1', 'buka');
      expect(offer.discountValue).toBe(25);
    });

    it('404s an offer owned by another venue', async () => {
      prisma.restaurantVenueOffer.findFirst.mockResolvedValue(null);

      await expect(
        updateOffer({ venueId: 'v1', brand: 'ghana', offerId: 'other', input: { title: 'New' } }),
      ).rejects.toThrow(/Offer not found/);
      expect(prisma.restaurantVenueOffer.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteOffer', () => {
    it('deletes the scoped offer and invalidates caches', async () => {
      prisma.restaurantVenueOffer.findFirst.mockResolvedValue(offerRow());

      const result = await deleteOffer({ venueId: 'v1', brand: 'ghana', offerId: 'o1' });

      expect(prisma.restaurantVenueOffer.delete).toHaveBeenCalledWith({ where: { id: 'o1' } });
      expect(cache.invalidateRestaurantVenueCaches).toHaveBeenCalledWith('v1', 'buka');
      expect(result).toEqual({ id: 'o1', deleted: true });
    });
  });
});
