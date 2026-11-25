jest.mock('../../src/core/services/prismaClient', () => ({
  restaurantVenue: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    groupBy: jest.fn(),
    count: jest.fn(),
  },
  restaurantVenueReview: { findMany: jest.fn() },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn, _ttl, _options) => fn()),
}));

jest.mock('../../src/core/services/locationService', () => ({
  autocomplete: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');
const locationService = require('../../src/core/services/locationService');
const service = require('../../src/core/services/restaurantVenueService');

function venueRow(overrides = {}) {
  return {
    id: 'v1',
    slug: 'buka-restaurant-accra',
    name: 'Buka Restaurant',
    status: 'ACTIVE',
    googlePlaceId: 'ChIJ-internal',
    city: 'Accra',
    region: 'Greater Accra',
    country: 'Ghana',
    neighbourhood: 'Osu',
    addressLine: '10th Ave, Osu',
    latitude: 5.5566,
    longitude: -0.1866,
    cuisines: ['west-african'],
    dietary: ['vegetarian'],
    priceBand: 2,
    amenities: ['outdoor-seating'],
    hours: { mon: [['11:00', '22:00']] },
    timezone: 'Africa/Accra',
    phone: '+233302123456',
    website: 'https://example.com',
    description: 'A long description',
    menuUrl: 'https://example.com/menu',
    mealTypes: ['breakfast', 'lunch'],
    photos: ['https://res.cloudinary.com/a.jpg'],
    coverPhoto: 'https://res.cloudinary.com/a.jpg',
    reviewCount: 10,
    ratingSum: 40,
    averageRating: 4,
    verifiedReviewCount: 6,
    recentRating: 4.2,
    recentReviewCount: 6,
    distribution: { 5: 8, 4: 2 },
    externalSource: 'GOOGLE',
    externalRating: 4.6,
    externalReviewCount: 1204,
    combinedRating: 4.72,
    combinedReviewCount: 100,
    rankingScore: 4.5833,
    demandScore: 12.9448,
    highDemand: true,
    rankInCity: 8,
    cityVenueCount: 143,
    listings: [{ isFeatured: true, displayOrder: 0 }],
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('restaurantVenueService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.restaurantVenue.findMany.mockResolvedValue([]);
    prisma.restaurantVenue.findFirst.mockResolvedValue(null);
    prisma.restaurantVenue.groupBy.mockResolvedValue([]);
    prisma.restaurantVenue.count.mockResolvedValue(0);
    prisma.restaurantVenueReview.findMany.mockResolvedValue([]);
    locationService.autocomplete.mockResolvedValue([]);
  });

  describe('listVenues', () => {
    it('scopes to ACTIVE venues with an active listing for the brand', async () => {
      await service.listVenues({ brand: 'ghana', sort: 'rating', limit: 20 });

      const query = prisma.restaurantVenue.findMany.mock.calls[0][0];
      expect(query.where).toEqual({
        status: 'ACTIVE',
        listings: { some: { brand: 'ghana', isActive: true } },
      });
      expect(query.orderBy).toEqual([
        { rankingScore: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ]);
      // +1 row decides hasMore without a second COUNT.
      expect(query.take).toBe(21);
    });

    it('applies every documented facet filter', async () => {
      await service.listVenues({
        brand: 'ghana',
        q: 'buka',
        city: 'Accra',
        cuisine: 'west-african',
        dietary: ['vegetarian', 'halal'],
        priceBand: 2,
        featured: true,
        minRating: 4,
        minReviews: 10,
        sort: 'rating',
        limit: 20,
      });

      expect(prisma.restaurantVenue.findMany.mock.calls[0][0].where).toEqual({
        status: 'ACTIVE',
        listings: {
          some: { brand: 'ghana', isActive: true, isFeatured: true },
        },
        city: { equals: 'Accra', mode: 'insensitive' },
        cuisines: { has: 'west-african' },
        dietary: { hasEvery: ['vegetarian', 'halal'] },
        priceBand: 2,
        combinedRating: { gte: 4 },
        combinedReviewCount: { gte: 10 },
        AND: [
          {
            OR: [
              { name: { contains: 'buka', mode: 'insensitive' } },
              { city: { contains: 'buka', mode: 'insensitive' } },
              { region: { contains: 'buka', mode: 'insensitive' } },
              { neighbourhood: { contains: 'buka', mode: 'insensitive' } },
              { cuisines: { has: 'buka' } },
            ],
          },
        ],
      });
    });

    it('filters on the stored high-demand flag alongside the brand scope', async () => {
      await service.listVenues({ brand: 'ghana', highDemand: true, limit: 20 });

      expect(prisma.restaurantVenue.findMany.mock.calls[0][0].where).toEqual({
        status: 'ACTIVE',
        listings: { some: { brand: 'ghana', isActive: true } },
        highDemand: true,
      });
    });

    it('filters on offers that are brand-scoped, active and in window', async () => {
      await service.listVenues({ brand: 'ghana', hasOffer: true, limit: 20 });

      const where = prisma.restaurantVenue.findMany.mock.calls[0][0].where;
      expect(where.offers.some.brand).toBe('ghana');
      expect(where.offers.some.isActive).toBe(true);
      expect(where.offers.some.AND).toHaveLength(2);
      expect(where.offers.some.AND[0].OR[0]).toEqual({ startsAt: null });
      expect(where.offers.some.AND[1].OR[0]).toEqual({ endsAt: null });
      // The active Ghana listing is still required, not replaced by the offer.
      expect(where.listings).toEqual({ some: { brand: 'ghana', isActive: true } });
    });

    it('orders by stored demand score and pages on demandScore + id', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        venueRow(),
        venueRow({ id: 'v2', slug: 'second', demandScore: 9 }),
      ]);

      const page = await service.listVenues({ brand: 'ghana', sort: 'demand', limit: 1 });

      const query = prisma.restaurantVenue.findMany.mock.calls[0][0];
      expect(query.orderBy).toEqual([
        { demandScore: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ]);
      expect(service.decodeListCursor(page.pagination.nextCursor, 'demand')).toEqual({
        s: 'demand',
        v: 12.9448,
        id: 'v1',
      });
    });

    it('continues a demand cursor inside the unscored tail', async () => {
      const cursor = service.encodeCursor({ s: 'demand', v: null, id: 'v9' });

      await service.listVenues({ brand: 'ghana', sort: 'demand', cursor, limit: 20 });

      expect(prisma.restaurantVenue.findMany.mock.calls[0][0].where.AND).toContainEqual({
        AND: [{ demandScore: null }, { id: { lt: 'v9' } }],
      });
    });

    it('filters to a map-server place using a coordinate bounding box', async () => {
      await service.listVenues({
        brand: 'ghana',
        lat: 5.56,
        lng: -0.19,
        radiusKm: 5,
        sort: 'rating',
        limit: 20,
      });

      const query = prisma.restaurantVenue.findMany.mock.calls[0][0];
      const near = query.where.AND[0];
      expect(near.latitude.gte).toBeCloseTo(5.514954954954955, 6);
      expect(near.latitude.lte).toBeCloseTo(5.605045045045045, 6);
      expect(near.longitude.gte).toBeCloseTo(-0.2352579709832196, 6);
      expect(near.longitude.lte).toBeCloseTo(-0.1447420290167804, 6);
    });

    it('returns a cursor built from the last row and the active sort', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([
        venueRow(),
        venueRow({ id: 'v2', slug: 'second' }),
      ]);

      const page = await service.listVenues({ brand: 'ghana', sort: 'rating', limit: 1 });

      expect(page.venues).toHaveLength(1);
      expect(page.pagination.hasMore).toBe(true);
      expect(service.decodeListCursor(page.pagination.nextCursor, 'rating')).toEqual({
        s: 'rating',
        v: 4.5833,
        id: 'v1',
      });
    });

    it('ends the list without a cursor when the last page fits', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([venueRow()]);

      const page = await service.listVenues({ brand: 'ghana', sort: 'rating', limit: 20 });

      expect(page.pagination).toEqual({ limit: 20, hasMore: false, nextCursor: null });
    });

    it('continues a rating cursor inside the unrated tail', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([]);
      const cursor = service.encodeCursor({ s: 'rating', v: null, id: 'v9' });

      await service.listVenues({ brand: 'ghana', sort: 'rating', limit: 20, cursor });

      expect(prisma.restaurantVenue.findMany.mock.calls[0][0].where.AND).toContainEqual({
        AND: [{ rankingScore: null }, { id: { lt: 'v9' } }],
      });
    });

    it('orders newest first and pages on createdAt + id', async () => {
      const cursor = service.encodeCursor({
        s: 'newest',
        v: '2026-11-20T10:00:00.000Z',
        id: 'v9',
      });

      await service.listVenues({ brand: 'ghana', sort: 'newest', limit: 20, cursor });

      const query = prisma.restaurantVenue.findMany.mock.calls[0][0];
      expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(query.where.AND).toContainEqual({
        OR: [
          { createdAt: { lt: new Date('2026-11-20T10:00:00.000Z') } },
          {
            AND: [
              { createdAt: new Date('2026-11-20T10:00:00.000Z') },
              { id: { lt: 'v9' } },
            ],
          },
        ],
      });
    });

    it('rejects a cursor minted for a different sort', () => {
      const cursor = service.encodeCursor({ s: 'reviews', v: 5, id: 'v1' });

      expect(() => service.decodeListCursor(cursor, 'rating')).toThrow(
        /does not match the requested sort/,
      );
    });

    it('rejects a malformed cursor', () => {
      expect(() => service.decodeListCursor('not-a-cursor', 'rating')).toThrow(
        /Invalid cursor/,
      );
    });

    it('rejects an unknown brand before querying', async () => {
      await expect(service.listVenues({ brand: 'moon', sort: 'rating', limit: 20 })).rejects.toThrow(
        /Unknown brand/,
      );
      expect(prisma.restaurantVenue.findMany).not.toHaveBeenCalled();
    });
  });

  describe('toPublicVenue offers', () => {
    const now = new Date('2026-11-25T12:00:00.000Z');
    const baseOffer = {
      id: 'o1',
      brand: 'ghana',
      title: '20% off your table',
      discountType: 'PERCENTAGE',
      discountValue: 20,
      promoCode: 'GHANA20',
      startsAt: new Date('2026-11-01T00:00:00.000Z'),
      endsAt: new Date('2026-12-01T00:00:00.000Z'),
      isActive: true,
      terms: 'Internal terms',
    };

    it('exposes only active, brand-scoped, in-window offers and the boolean flag', () => {
      const dto = service.toPublicVenue(
        venueRow({
          offers: [
            baseOffer,
            { ...baseOffer, id: 'o2', isActive: false },
            { ...baseOffer, id: 'o3', brand: 'africa' },
            { ...baseOffer, id: 'o4', startsAt: new Date('2026-12-01T00:00:00.000Z') },
            { ...baseOffer, id: 'o5', endsAt: new Date('2026-11-01T00:00:00.000Z') },
          ],
        }),
        { brand: 'ghana', now },
      );

      expect(dto.highDemand).toBe(true);
      expect(dto.demandScore).toBeUndefined();
      expect(dto.offers).toEqual([
        {
          id: 'o1',
          title: '20% off your table',
          discountType: 'PERCENTAGE',
          discountValue: 20,
          promoCode: 'GHANA20',
          endsAt: '2026-12-01T00:00:00.000Z',
        },
      ]);
      expect(dto.offers[0].terms).toBeUndefined();
      expect(dto.offers[0].brand).toBeUndefined();
    });

    it('keeps open-ended windows and null promo codes', () => {
      const dto = service.toPublicVenue(
        venueRow({
          offers: [{ ...baseOffer, promoCode: null, startsAt: null, endsAt: null }],
        }),
        { brand: 'ghana', now },
      );

      expect(dto.offers[0]).toEqual({
        id: 'o1',
        title: '20% off your table',
        discountType: 'PERCENTAGE',
        discountValue: 20,
        promoCode: null,
        endsAt: null,
      });
    });
  });

  describe('cached offer freshness', () => {
    it('refetches when a cached offer window expires', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-25T12:00:00.000Z'));
      const originalGetOrSet = cache.getOrSet.getMockImplementation();
      try {
        const expiringOffer = {
          id: 'o-exp',
          brand: 'ghana',
          title: 'Expiring deal',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          promoCode: null,
          startsAt: new Date('2026-11-25T11:00:00.000Z'),
          endsAt: new Date('2026-11-25T12:00:05.000Z'),
          isActive: true,
        };
        prisma.restaurantVenue.findMany.mockResolvedValue([
          venueRow({ offers: [expiringOffer] }),
        ]);

        let stored;
        cache.getOrSet.mockImplementation(async (key, loader, _ttl, options) => {
          if (stored && options?.isValid?.(stored)) return stored;
          stored = await loader();
          return stored;
        });

        const first = await service.listVenues({ brand: 'ghana', limit: 20 });
        expect(first.venues[0].offers).toHaveLength(1);
        expect(stored.offerValidUntil).toBe(new Date('2026-11-25T12:00:05.000Z').getTime());

        jest.setSystemTime(new Date('2026-11-25T12:00:06.000Z'));
        expect(cache.getOrSet.mock.calls[0][3].isValid(stored)).toBe(false);
        const second = await service.listVenues({ brand: 'ghana', limit: 20 });
        expect(second.venues[0].offers).toEqual([]);
        expect(prisma.restaurantVenue.findMany).toHaveBeenCalledTimes(2);
      } finally {
        cache.getOrSet.mockImplementation(originalGetOrSet);
        jest.useRealTimers();
      }
    });
  });

  describe('suggestVenues', () => {
    it('returns directory and map places only when restaurants are nearby', async () => {
      prisma.restaurantVenue.findMany.mockResolvedValue([venueRow()]);
      prisma.restaurantVenue.groupBy.mockResolvedValue([
        { city: 'Accra', region: 'Greater Accra', _count: { _all: 2 } },
      ]);
      prisma.restaurantVenue.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);
      locationService.autocomplete.mockResolvedValue([
        {
          formatted: 'La, Osu, Accra, Ghana',
          city: 'Accra',
          region: 'Greater Accra Region',
          countryCode: 'gh',
          latitude: 5.5605929,
          longitude: -0.1824391,
        },
        {
          formatted: 'Osu, Upper Manya Krobo District, Ghana',
          city: 'Osu',
          region: 'Eastern Region',
          countryCode: 'gh',
          latitude: 6.5115749,
          longitude: -0.1095039,
        },
      ]);

      const result = await service.suggestVenues({ brand: 'ghana', q: 'Osu', limit: 6 });

      expect(result.restaurants).toHaveLength(1);
      expect(result.places).toEqual([
        expect.objectContaining({ name: 'Accra', restaurantCount: 2 }),
        expect.objectContaining({
          name: 'Osu',
          restaurantCount: 1,
          latitude: 5.5605929,
          source: 'map',
        }),
      ]);
      expect(prisma.restaurantVenue.count).toHaveBeenCalledTimes(2);
    });
  });

  describe('getVenue', () => {
    it('returns the detail DTO and never leaks the internal place id', async () => {
      prisma.restaurantVenue.findFirst.mockResolvedValue(
        venueRow({
          externalStats: [
            {
              source: 'GOOGLE',
              rating: 4.6,
              reviewCount: 1204,
              distribution: { 5: 900 },
              productUrl: 'https://maps.google.com/?cid=1',
              syncedAt: new Date('2026-11-20T00:00:00.000Z'),
            },
          ],
        }),
      );

      const venue = await service.getVenue('buka-restaurant-accra', 'ghana');

      expect(venue.slug).toBe('buka-restaurant-accra');
      // The displayed rating is ours alone, not a blend with Google.
      expect(venue.rating).toBe(4);
      expect(venue.reviewCount).toBe(10);
      expect(venue.recentRating).toBe(4.2);
      expect(venue.external).toEqual({ source: 'GOOGLE', rating: 4.6, reviewCount: 1204 });
      expect(venue.rank).toEqual({ position: 8, of: 143 });
      expect(venue.description).toBe('A long description');
      expect(venue.menuUrl).toBe('https://example.com/menu');
      expect(venue.mealTypes).toEqual(['breakfast', 'lunch']);
      expect(venue.externalStats).toEqual([
        expect.objectContaining({ source: 'GOOGLE', rating: 4.6, reviewCount: 1204 }),
      ]);
      // Internal ordering inputs never leave the building.
      expect(venue.rankingScore).toBeUndefined();
      expect(venue.combinedRating).toBeUndefined();
      expect(venue.combinedReviewCount).toBeUndefined();
      expect(venue.googlePlaceId).toBeUndefined();
    });

    it('returns null when the venue is not listed for the brand', async () => {
      prisma.restaurantVenue.findFirst.mockResolvedValue(null);

      await expect(service.getVenue('missing', 'ghana')).resolves.toBeNull();
      expect(prisma.restaurantVenue.findFirst.mock.calls[0][0].where.listings).toEqual({
        some: { brand: 'ghana', isActive: true },
      });
    });
  });

  describe('listReviews', () => {
    const reviewRow = {
      id: 'r1',
      rating: 5,
      foodRating: 5,
      serviceRating: 4,
      atmosphereRating: 5,
      valueRating: 4,
      title: 'Excellent',
      body: 'Great food and a calm garden.',
      photos: [],
      companions: ['COUPLES'],
      visitedAt: null,
      source: 'TRAVIO_VERIFIED',
      helpfulCount: 3,
      createdAt: new Date('2026-11-18T00:00:00.000Z'),
      author: { name: 'Ama', photoURL: null },
      // None of the following may appear in the response.
      proofRef: 'secret-token',
      ipHash: 'abc',
      userAgentHash: 'def',
      authorId: 'u1',
    };

    beforeEach(() => {
      prisma.restaurantVenue.findFirst.mockResolvedValue({
        id: 'v1',
        distribution: { 5: 1 },
        combinedRating: 4.7,
        combinedReviewCount: 100,
      });
    });

    it('returns approved reviews only and redacts internal fields', async () => {
      prisma.restaurantVenueReview.findMany.mockResolvedValue([reviewRow]);

      const data = await service.listReviews('v1', { limit: 10 });

      const query = prisma.restaurantVenueReview.findMany.mock.calls[0][0];
      expect(query.where).toEqual({ venueId: 'v1', status: 'APPROVED' });
      expect(query.select.author).toEqual({ select: { name: true, photoURL: true } });

      const review = data.reviews[0];
      expect(review.verified).toBe(true);
      expect(review.companions).toEqual(['COUPLES']);
      expect(review.author).toEqual({ name: 'Ama', photoURL: null });
      expect(review.proofRef).toBeUndefined();
      expect(review.ipHash).toBeUndefined();
      expect(review.userAgentHash).toBeUndefined();
      expect(review.authorId).toBeUndefined();
    });

    it('filters by rating and verification tier', async () => {
      await service.listReviews('v1', { limit: 10, rating: 4, verified: true });

      expect(prisma.restaurantVenueReview.findMany.mock.calls[0][0].where).toEqual({
        venueId: 'v1',
        status: 'APPROVED',
        rating: 4,
        source: 'TRAVIO_VERIFIED',
      });
    });

    it('paginates on createdAt + id', async () => {
      const cursor = service.encodeCursor({
        c: '2026-11-18T00:00:00.000Z',
        id: 'r9',
      });
      prisma.restaurantVenueReview.findMany.mockResolvedValue([reviewRow]);

      await service.listReviews('v1', { limit: 1, cursor });

      const where = prisma.restaurantVenueReview.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { createdAt: { lt: new Date('2026-11-18T00:00:00.000Z') } },
        {
          AND: [
            { createdAt: new Date('2026-11-18T00:00:00.000Z') },
            { id: { lt: 'r9' } },
          ],
        },
      ]);
    });

    it('returns null when the venue disappeared', async () => {
      prisma.restaurantVenue.findFirst.mockResolvedValue(null);

      await expect(service.listReviews('v1', { limit: 10 })).resolves.toBeNull();
      expect(prisma.restaurantVenueReview.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listReviewFeed', () => {
    const feedRow = {
      id: 'r1',
      venueId: 'v1',
      rating: 5,
      title: 'Still thinking about the jollof',
      body: 'Booked on a Friday and the queue was moving before we sat down.',
      source: 'TRAVIO_VERIFIED',
      createdAt: new Date('2026-11-24T00:00:00.000Z'),
      venue: { id: 'v1', name: 'Buka Restaurant', slug: 'buka', city: 'Accra' },
      author: { name: 'Ama', photoURL: 'https://example.com/ama.jpg' },
      proofRef: 'secret',
      ipHash: 'hash',
    };

    beforeEach(() => {
      prisma.restaurantVenueReview.findMany.mockResolvedValue([feedRow]);
    });

    it('reads approved reviews from active venues listed for the brand', async () => {
      const data = await service.listReviewFeed({ brand: 'ghana', limit: 10 });

      const query = prisma.restaurantVenueReview.findMany.mock.calls[0][0];
      expect(query.where.status).toBe('APPROVED');
      expect(query.where.venue).toEqual({
        status: 'ACTIVE',
        listings: { some: { brand: 'ghana', isActive: true } },
      });
      expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);

      expect(data.reviews).toEqual([
        {
          id: 'r1',
          venueId: 'v1',
          venueName: 'Buka Restaurant',
          venueSlug: 'buka',
          venueCity: 'Accra',
          rating: 5,
          title: 'Still thinking about the jollof',
          body: 'Booked on a Friday and the queue was moving before we sat down.',
          createdAt: new Date('2026-11-24T00:00:00.000Z'),
          author: { name: 'Ama', photoURL: 'https://example.com/ama.jpg' },
          verified: true,
        },
      ]);
      expect(data.reviews[0].proofRef).toBeUndefined();
      expect(data.reviews[0].ipHash).toBeUndefined();
      expect(data.pagination).toEqual({
        limit: 10,
        hasMore: false,
        nextCursor: null,
      });
    });

    it('paginates on createdAt + id', async () => {
      const cursor = service.encodeCursor({
        c: '2026-11-24T00:00:00.000Z',
        id: 'r9',
      });

      await service.listReviewFeed({ brand: 'ghana', limit: 1, cursor });

      expect(prisma.restaurantVenueReview.findMany.mock.calls[0][0].where.OR).toEqual([
        { createdAt: { lt: new Date('2026-11-24T00:00:00.000Z') } },
        {
          AND: [
            { createdAt: new Date('2026-11-24T00:00:00.000Z') },
            { id: { lt: 'r9' } },
          ],
        },
      ]);
    });

    it('rejects an unknown brand before querying', async () => {
      await expect(service.listReviewFeed({ brand: 'moon' })).rejects.toThrow(/Unknown brand/);
      expect(prisma.restaurantVenueReview.findMany).not.toHaveBeenCalled();
    });
  });
});
