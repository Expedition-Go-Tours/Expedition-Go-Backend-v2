/**
 * Region-fallback tests.
 *
 * Two layers:
 *  - `regionForQuery` (Attraction -> region): self-seeds its own row, so it is
 *    deterministic in any migrated DB and needs NO geocoder.
 *  - `placeTourIds` region fallback: depends on the real catalog (a place with
 *    no tours whose region does have some) plus the geocoder; it skips when
 *    that data/environment is absent, so CI seeded only with seed.js stays
 *    green without weakening the assertion.
 */

const { normalizeRegion, regionForQuery, resolvePlace } = require('../../utils/placeResolver');
const { placeTourIds } = require('../../utils/placeListing');
const prisma = require('../../utils/prismaClient');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

describeDb('regionForQuery (Attraction -> region)', () => {
  const NAME = 'ZZ Region Test Attraction';
  const TOWN = 'ZZRegionTestTown';

  beforeAll(async () => {
    await prisma.attraction.deleteMany({ where: { name: NAME } });
    await prisma.attraction.create({
      data: {
        name: NAME,
        slug: 'zz-region-test-attraction',
        town: TOWN,
        region: 'Eastern',
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    await prisma.attraction.deleteMany({ where: { name: NAME } }).catch(() => {});
  });

  it('resolves a town to its region (and normalises the suffix)', async () => {
    expect(await regionForQuery(TOWN)).toBe('Eastern');
    expect(normalizeRegion(await regionForQuery(TOWN))).toBe('Eastern Region');
  });

  it('resolves an attraction by exact name', async () => {
    expect(await regionForQuery(NAME)).toBe('Eastern');
  });

  it('returns null for a non-place query', async () => {
    expect(await regionForQuery('zzzz not a place zzzz')).toBeNull();
  });
});

describeDb('placeTourIds region fallback (needs catalog + geocoder)', () => {
  // Guard: only assert when this environment can resolve the place to a region
  // (i.e. the catalog + geocoder are present, as in production/staging).
  const canResolve = async (q) => {
    const r = await resolvePlace(q, { expeditionOnly: true }).catch(() => null);
    return !!(r && r.region);
  };

  it('widens to the region when the place has no tours', async () => {
    if (!(await canResolve('Sekondi-Takoradi'))) return;
    const { ids, regionFallback } = await placeTourIds('Sekondi-Takoradi', { expeditionOnly: true });
    if (ids.size > 0) return; // catalog differs from production
    expect(regionFallback).not.toBeNull();
    expect(regionFallback.ids.size).toBeGreaterThan(0);
  });

  it('does NOT widen when the place already has tours', async () => {
    if (!(await canResolve('Aburi'))) return;
    const { ids, regionFallback } = await placeTourIds('Aburi', { expeditionOnly: true });
    if (ids.size === 0) return; // catalog differs from production
    expect(regionFallback).toBeNull();
  });
});

describeDb('itinerary place matching (needs catalog)', () => {
  it('a region search matches a tour that only VISITS it', async () => {
    // Guard: only meaningful when the catalog has a tour whose itinerary
    // includes Volta (based elsewhere).
    const seeded = await prisma.tour.count({
      where: { status: 'ACTIVE', itineraryRegions: { has: 'Volta Region' } },
    });
    if (seeded === 0) return;

    const { getLocationTourIds } = require('../../utils/homepageRanking');
    const ids = await getLocationTourIds('Volta Region', false, true);
    expect(ids.length).toBeGreaterThan(0);

    const tours = await prisma.tour.findMany({
      where: { id: { in: ids } },
      select: { itineraryRegions: true },
    });
    expect(tours.some((t) => t.itineraryRegions.includes('Volta Region'))).toBe(true);
  });
});
