/**
 * Region-fallback tests.
 *
 * Two layers:
 *  - `regionForQuery` (Attraction -> region): self-seeds its own row, so it is
 *    deterministic in any migrated DB and needs NO geocoder.
 *  - `placeTourIds` region fallback: the three tests at the bottom of this file
 *    used to be guarded into vacuous passes. They need (a) a place the
 *    geocoder resolves to a region, (b) a catalog where one place has tours
 *    and its region has tours while another place has none, and (c) a tour that
 *    merely VISITS a region. CI seeded only with seed.js has none of that, so
 *    every test began with `if (!(await ...)) return;` and reported green
 *    having asserted nothing.
 *
 * The catalog half is now self-seeded here, the same way the Attraction row
 * above is: three tours under an `rlf-` prefix that between them make all
 * three assertions reachable. The geocoder half is genuinely external and
 * still guarded — that guard is the honest part, since a CI runner without
 * network cannot resolve "Sekondi-Takoradi" and the test cannot invent the
 * answer. What is no longer accepted is the data half silently emptying the
 * assertion.
 *
 * Fixtures carry no latitude/longitude on purpose. Band 1 of `placeTourIds`
 * is a PostGIS radius search around the resolved centroid, so a coordinate-less
 * tour can never leak into `nearIds` and be mistaken for being "in" the town.
 */

// Pass-through rather than real Redis: `getCatalogCountries`, `regionTourIds`
// and the geocoder all cache for 300s, and this suite's whole premise is that
// the catalog it just seeded is the catalog that gets read.
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

const { normalizeRegion, regionForQuery, resolvePlace } = require('../../src/core/services/placeResolver');
const { placeTourIds, regionTourIds } = require('../../src/core/services/placeListing');
const prisma = require('../../src/core/services/prismaClient');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'rlf-';
const SUPPLIER_EMAIL = `${PREFIX}supplier@example.com`;

const baseTour = {
  status: 'ACTIVE',
  country: 'Ghana',
  description: 'Fixture tour for the region-fallback suite.',
  photos: [],
  // coverPhoto set: tours.test.js binds the first ACTIVE tour's coverPhoto,
  // and a null-rated, coverPhoto-less fixture sorts to row 1 while this
  // suite's window is open (DESC NULLS FIRST).
  coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/rlf-cover.jpg',
  tags: [],
  // No latitude/longitude: see the file header. Coordinates would pull these
  // into the radius band and make "the town has no tours" untrue.
  categorization: {},
  theme: {},
  productContent: {},
  schedulesAndPricing: {},
  bookingAndTickets: {},
  aiProcessingStatus: 'PENDING',
};

async function upsertUser(email, data) {
  return prisma.user.upsert({
    where: { email },
    update: data,
    create: { firebaseUid: `test-${email}`, email, photoURL: '', active: true, ...data },
  });
}

async function upsertTour(slug, data) {
  return prisma.tour.upsert({
    where: { slug },
    update: { ...baseTour, ...data },
    create: { slug, ...baseTour, ...data },
  });
}

async function cleanCatalog() {
  await prisma.tour.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

/**
 * Three tours that between them make every assertion in this file reachable.
 *
 * Called by each block that needs it rather than hoisted to the file root:
 * a describe block's `afterAll` runs when ITS tests finish, so fixtures seeded
 * once for the whole file would be deleted before the last block looked at
 * them. Upserting twice is harmless, and so is deleting in between.
 */
async function seedCatalog() {
  await prisma.$connect();
  await cleanCatalog();

  const supplier = await upsertUser(SUPPLIER_EMAIL, {
    name: 'RLF Supplier',
    roles: ['supplier'],
  });
  await prisma.supplierProfile.upsert({
    where: { userId: supplier.id },
    update: { status: 'ACTIVE' },
    create: {
      userId: supplier.id,
      status: 'ACTIVE',
      businessInfo: {},
      operatingInfo: {},
      representativeInfo: {},
      businessDocuments: {},
      payoutInfo: {},
      compliance: {},
    },
  });

  // Western Region, but based in Axim — deliberately NOT Sekondi-Takoradi, so
  // that town stays empty and the fallback has something to widen onto.
  const western = await upsertTour(`${PREFIX}western`, {
    title: 'RLF Western Region tour',
    city: 'Axim',
    region: 'Western Region',
    supplierId: supplier.id,
  });

  // Based in Aburi, so that town HAS tours and must not widen.
  const eastern = await upsertTour(`${PREFIX}eastern`, {
    title: 'RLF Aburi tour',
    city: 'Aburi',
    region: 'Eastern Region',
    supplierId: supplier.id,
  });

  // Based in Accra, visiting Volta: the itinerary-only case the last test is
  // about. Being based there would make the match trivial.
  const voltaVisit = await upsertTour(`${PREFIX}volta-visit`, {
    title: 'RLF Accra tour that visits Volta',
    city: 'Accra',
    region: 'Greater Accra Region',
    itineraryRegions: ['Volta Region'],
    supplierId: supplier.id,
  });

  // All three are Expedition listings: every query in this file runs with
  // `expeditionOnly`, which INNER JOINs an active ExpeditionTour row.
  for (const tour of [western, eastern, voltaVisit]) {
    await prisma.expeditionTour.upsert({
      where: { tourId: tour.id },
      update: { isActive: true },
      create: { tourId: tour.id, isActive: true },
    });
  }
}

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
  beforeAll(seedCatalog);
  afterAll(cleanCatalog);

  // The only surviving reason to skip: the geocoder is external, and a runner
  // that cannot resolve the place cannot be told what the answer should be.
  // The catalog is seeded above, so "no tours in the region" is no longer a
  // reason to stay silent.
  const regionHasTours = async (q) => {
    const r = await resolvePlace(q, { expeditionOnly: true }).catch(() => null);
    if (!r || !r.region) return false;
    const ids = await regionTourIds(r.region, { expeditionOnly: true });
    return ids.length > 0;
  };

  it('widens to the region when the place has no tours', async () => {
    if (!(await regionHasTours('Sekondi-Takoradi'))) return;

    const { localIds, regionFallback } = await placeTourIds('Sekondi-Takoradi', { expeditionOnly: true });

    // `localIds`, not `ids`. Production widens when the PLACE itself has no
    // tours (placeListing.js gates on localIds), while `ids` also carries the
    // 50 km radius band — a neighbouring tour would have skipped this
    // assertion at exactly the moment the fallback was working.
    if (localIds.size > 0) return; // the town gained tours of its own
    expect(regionFallback).not.toBeNull();
    expect(regionFallback.ids.size).toBeGreaterThan(0);
  });

  it('does NOT widen when the place already has tours', async () => {
    // Note the precondition is the place resolving, not its region. Aburi
    // geocodes without one, and requiring a region here would have quietly
    // kept this test vacuous — the region is precisely what must not be
    // consulted, so gating on it tests the thing being avoided.
    const resolved = await resolvePlace('Aburi', { expeditionOnly: true }).catch(() => null);
    if (!resolved) return;

    const { ids, localIds, regionFallback } = await placeTourIds('Aburi', { expeditionOnly: true });

    // Aburi is seeded with a tour, so this is an assertion, not a guard: the
    // catalog half of the precondition is this file's own fixture.
    expect(localIds.size).toBeGreaterThan(0);
    expect(ids.size).toBeGreaterThan(0);
    expect(regionFallback).toBeNull();
  });
});

describeDb('itinerary place matching (needs catalog)', () => {
  beforeAll(seedCatalog);
  afterAll(cleanCatalog);

  it('a region search matches a tour that only VISITS it', async () => {
    // Asserted, not guarded. The fixture seeded above IS this case — an Accra
    // tour whose itinerary runs through Volta — so a zero here means the seed
    // broke, which is exactly what this test should say out loud.
    const seeded = await prisma.tour.count({
      where: { status: 'ACTIVE', itineraryRegions: { has: 'Volta Region' } },
    });
    expect(seeded).toBeGreaterThan(0);

    const { getLocationTourIds } = require('../../src/core/services/homepageRanking');
    const ids = await getLocationTourIds('Volta Region', false, true);
    expect(ids.length).toBeGreaterThan(0);

    const tours = await prisma.tour.findMany({
      where: { id: { in: ids } },
      select: { itineraryRegions: true },
    });
    expect(tours.some((t) => t.itineraryRegions.includes('Volta Region'))).toBe(true);
  });
});
