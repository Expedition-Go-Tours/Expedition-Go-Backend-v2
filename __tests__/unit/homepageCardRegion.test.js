/**
 * The homepage card mapper must carry the tour's `region` through to the
 * storefront. Expedition's homepage scopes itself by region after a tour click
 * (the same thing a search-suggestion click does), and the only way the client
 * can learn a card's region is from this response.
 *
 * `TOUR_SELECT` already read the column — the mapper was dropping it, so the
 * fix is a regression guard on the mapper, not on the query.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  $queryRaw: jest.fn(),
  tour: { findMany: jest.fn() },
  booking: { groupBy: jest.fn() },
  event: { findMany: jest.fn(), groupBy: jest.fn() },
  attraction: { count: jest.fn(), findMany: jest.fn() },
  wishlistItem: { groupBy: jest.fn() },
}));

jest.mock('../../src/core/services/cacheHelper', () => {
  const actual = jest.requireActual('../../src/core/services/cacheHelper');
  return {
    ...actual,
    getOrSet: jest.fn((_key, fetchFn) => fetchFn()),
    memSet: jest.fn(),
    memGet: jest.fn(),
  };
});

const { mapTourCard } = require('../../src/core/services/homepageRanking');

/** Minimal tour row as TOUR_SELECT projects it. */
function tourRow(overrides = {}) {
  return {
    id: 'tour-1',
    title: 'Cape Coast Castle Walking Tour',
    slug: 'cape-coast-castle-walking-tour',
    coverPhoto: null,
    photos: [],
    category: 'Culture',
    city: 'Cape Coast',
    country: 'Ghana',
    region: 'Central Region',
    averageRating: '4.8',
    reviewCount: 120,
    totalBookings: 40,
    schedulesAndPricing: null,
    durationMinutes: 120,
    difficulty: 'Easy',
    tags: ['History'],
    latitude: null,
    longitude: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    supplier: null,
    ...overrides,
  };
}

describe('mapTourCard — region passthrough', () => {
  it('returns the tour region so the homepage can scope itself to it', () => {
    const card = mapTourCard(tourRow());
    expect(card.region).toBe('Central Region');
  });

  it('keeps region and city independently (a tour in a district keeps both)', () => {
    // Tour.city is often a district/village while region is the admin region,
    // so neither can be derived from the other.
    const card = mapTourCard(tourRow({ city: 'Kakumdo', region: 'Central Region' }));
    expect(card.city).toBe('Kakumdo');
    expect(card.region).toBe('Central Region');
  });

  it('normalizes a missing region to null rather than undefined', () => {
    // `city` is returned raw; region normalizes so a client can rely on
    // `'region' in card` instead of `card.region !== undefined`.
    const card = mapTourCard(tourRow({ region: undefined }));
    expect(card).toHaveProperty('region');
    expect(card.region).toBeNull();
  });

  it('still returns the other location fields (mutation guard)', () => {
    const card = mapTourCard(tourRow());
    expect(card.city).toBe('Cape Coast');
    expect(card.country).toBe('Ghana');
    expect(card.id).toBe('tour-1');
    expect(card.slug).toBe('cape-coast-castle-walking-tour');
  });
});

describe('the offers section carries region too', () => {
  // computeOffersData builds its own card shape rather than reusing
  // mapTourCard, and offer cards are clickable as well — so it needs the same
  // field or an offer click silently loses the region scope. Driven through the
  // exported controller with Prisma mocked, not asserted on source text.
  let homepageController;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../src/core/services/redisClient', () => ({
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(true),
      isRedisAvailable: jest.fn().mockResolvedValue(true),
    }));
    jest.doMock('../../src/core/services/prismaClient', () => ({
      // The city-scoped offers path resolves location tour IDs with a raw SQL
      // lookup before querying offers, so $queryRaw has to exist.
      $queryRaw: jest.fn().mockResolvedValue([]),
      specialOfferTarget: { findMany: jest.fn().mockResolvedValue([]) },
      tour: { findMany: jest.fn() },
    }));
    jest.doMock('../../src/core/services/queue', () => ({
      enqueueHomepagePrecompute: jest.fn().mockResolvedValue(),
    }));
    homepageController = require('../../src/core/domain/homepageController');
  });

  afterEach(() => {
    jest.dontMock('../../src/core/services/redisClient');
    jest.dontMock('../../src/core/services/prismaClient');
    jest.dontMock('../../src/core/services/queue');
  });

  it('returns each offer tour’s region in the response', async () => {
    const prisma = require('../../src/core/services/prismaClient');
    prisma.specialOfferTarget.findMany.mockResolvedValue([
      {
        specialOffer: {
          id: 'off-1', name: 'Save 20%', offerType: 'PERCENTAGE',
          discountType: 'PERCENTAGE', discountPercentage: 20,
          fixedDiscountValue: null, startDate: null, endDate: null,
        },
        tour: {
          id: 'tour-9', title: 'Elmina Castle', slug: 'elmina-castle',
          coverPhoto: null, photos: [], category: 'Culture',
          city: 'Elmina', country: 'Ghana', region: 'Central Region',
          averageRating: '4.6', reviewCount: 80, totalBookings: 20,
          schedulesAndPricing: null, durationMinutes: 90,
          difficulty: 'Easy', tags: [], status: 'ACTIVE',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          supplier: null,
        },
      },
    ]);

    const json = jest.fn();
    await homepageController.getOffers({ query: { city: 'Cape Coast' } }, { json });

    expect(json).toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    expect(body.data.tours[0].region).toBe('Central Region');
  });

  it('reads region in the offers Prisma select (not just the mapper)', async () => {
    const prisma = require('../../src/core/services/prismaClient');
    await homepageController.getOffers({ query: { city: 'Cape Coast' } }, { json: jest.fn() });

    const call = prisma.specialOfferTarget.findMany.mock.calls[0][0];
    expect(call.include.tour.select.region).toBe(true);
  });
});