/**
 * Unit tests for the location-aware homepage ranking helpers.
 * Pure logic + getLocationTourIds query shape (prisma/cache mocked).
 */

jest.mock('../../utils/prismaClient', () => ({
  $queryRaw: jest.fn(),
  tour: { findMany: jest.fn() },
  booking: { groupBy: jest.fn() },
  event: { findMany: jest.fn(), groupBy: jest.fn() },
  attraction: { count: jest.fn(), findMany: jest.fn() },
  wishlistItem: { groupBy: jest.fn() },
}));

jest.mock('../../utils/cacheHelper', () => {
  const actual = jest.requireActual('../../utils/cacheHelper');
  return {
    ...actual,
    // Execute the fetcher directly (no Redis/memory) so tests hit prisma mocks.
    getOrSet: jest.fn((_key, fetchFn) => fetchFn()),
    memSet: jest.fn(),
    memGet: jest.fn(),
  };
});

const prisma = require('../../utils/prismaClient');
const cache = require('../../utils/cacheHelper');
const ranking = require('../../utils/homepageRanking');

const { escapeLike, locationTier, mergeLocationFirst, getLocationTourIds } = ranking;

describe('escapeLike', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLike('100%_off\\')).toBe('100\\%\\_off\\\\');
  });

  it('leaves normal city names untouched', () => {
    expect(escapeLike('Cape Coast')).toBe('Cape Coast');
  });
});

describe('locationTier', () => {
  const base = { city: null, attractions: [], tags: [] };

  it('returns 1 when the tour city matches (case-insensitive)', () => {
    expect(locationTier({ ...base, city: 'Cape Coast' }, 'cape coast')).toBe(1);
  });

  it('returns 2 when an attraction word-matches', () => {
    expect(locationTier({ ...base, attractions: ['Cape Coast Castle'] }, 'Cape Coast')).toBe(2);
  });

  it('returns 3 when a tag word-matches', () => {
    expect(locationTier({ ...base, tags: ['things to do in accra'] }, 'Accra')).toBe(3);
  });

  it('does not match a city as a substring of another word', () => {
    expect(locationTier({ ...base, attractions: ['Hotel'] }, 'Ho')).toBeNull();
  });

  it('prefers city over attraction over tag', () => {
    expect(locationTier({ city: 'Accra', attractions: ['Accra Mall'], tags: ['accra'] }, 'Accra')).toBe(1);
  });

  it('returns null for missing city or blank target', () => {
    expect(locationTier(base, null)).toBeNull();
    expect(locationTier(base, '   ')).toBeNull();
  });
});

describe('mergeLocationFirst', () => {
  it('ranks location tours by score, then backfill, sliced to limit', () => {
    const local = [
      { id: 'l1', _score: 0.2, _locationTier: 1 },
      { id: 'l2', _score: 0.9, _locationTier: 1 },
    ];
    const backfill = [
      { id: 'b1', _score: 0.99, _locationTier: null },
      { id: 'b2', _score: 0.5, _locationTier: null },
    ];

    const result = mergeLocationFirst(local, backfill, 3);
    // Location first (sorted by score), then the highest backfill.
    expect(result.map(t => t.id)).toEqual(['l2', 'l1', 'b1']);
  });

  it('breaks score ties toward the stronger location tier', () => {
    const local = [
      { id: 'tag', _score: 0.5, _locationTier: 3 },
      { id: 'city', _score: 0.5, _locationTier: 1 },
    ];
    const result = mergeLocationFirst(local, [], 2);
    expect(result.map(t => t.id)).toEqual(['city', 'tag']);
  });
});

describe('getLocationTourIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns [] for a too-short query without hitting the database', async () => {
    const ids = await getLocationTourIds('A');
    expect(ids).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns tour ids from the raw query and caches by normalized city', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);

    const ids = await getLocationTourIds('  Cape Coast ', false, true);

    expect(ids).toEqual(['t1', 't2']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(cache.getOrSet).toHaveBeenCalledWith(
      'hp:loctier:cape coast:exp',
      expect.any(Function),
      300,
    );
  });
});
