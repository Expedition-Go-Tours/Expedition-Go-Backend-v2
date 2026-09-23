jest.mock('../../src/core/services/prismaClient', () => ({
  attraction: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  tour: {
    findMany: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../src/core/services/cacheHelper', () => ({ getOrSet: jest.fn((key, fn) => fn()) }));
jest.mock('../../src/core/services/placeListing', () => ({ placeTourCount: jest.fn().mockResolvedValue(0) }));

const prisma = require('../../src/core/services/prismaClient');
const searchController = require('../../src/core/domain/searchController');

const KUMASI_TOUR = {
  id: 'tour-1',
  title: 'The Kumasi Cultural and Heritage Day Tour',
  slug: 'the-kumasi-cultural-and-heritage-day-tour',
  city: 'Kumasi',
  country: 'Ghana',
  region: 'Ashanti',
  coverPhoto: null,
  averageRating: 5,
  reviewCount: 1,
  totalBookings: 3,
  description: 'Ashanti heritage, royal history and Kente weaving.',
  attractions: ['Bonwire Kente Weaving Center', 'Manhyia Palace', 'Okomfo Anokye Sword Site'],
  itineraryCities: ['Bonwire', 'Kumasi'],
  itineraryRegions: ['Ashanti'],
};

async function search(q) {
  const res = { json: jest.fn() };
  await searchController.unifiedSearch({ query: { q, limit: 14 } }, res, jest.fn());
  return res.json.mock.calls[0][0].data;
}

describe('unifiedSearch — itinerary matching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.attraction.findMany.mockResolvedValue([]);
    prisma.attraction.count.mockResolvedValue(0);
    prisma.tour.groupBy.mockResolvedValue([]);
    prisma.tour.findMany.mockResolvedValue([]);
    prisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  it('surfaces a tour for a mid-word substring of an itinerary stop ("komfo")', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.tour.findMany.mockResolvedValue([KUMASI_TOUR]);

    const data = await search('komfo');

    expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
    expect(
      data.results.some((r) => r.kind === 'tour' && r.name === KUMASI_TOUR.title),
    ).toBe(true);
  });

  it('ORs the itinerary-matched tour ids into the tour query', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);

    await search('komfo');

    const where = prisma.tour.findMany.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ id: { in: ['tour-1'] } });
  });

  it('does not let 2-character queries pull in itinerary-only matches', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.tour.findMany.mockResolvedValue([KUMASI_TOUR]);

    const data = await search('ko');

    expect(data.results.some((r) => r.kind === 'tour')).toBe(false);
  });
});
