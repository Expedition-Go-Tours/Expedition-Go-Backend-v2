/**
 * `?near=` scoping on the Ghana tours listing — the location filter's param.
 *
 * The homepage's location filter and every section's "view all" link carry the
 * searched place/region as `near` (`/tours?mood=X&near=Greater Accra Region`)
 * and head the page "{mood} near {location}". The endpoint used to treat `near`
 * as a pure sort hint (a centroid for distanceKm, "keep all") while the heading
 * promised proximity — so "Nature & Outdoors near Greater Accra Region"
 * returned the whole country (Cape Coast, Nzulezo, Kintampo…), `placeScope`
 * came back null, and the store's response-driven scope UI stayed dormant.
 * `near` now resolves through the same place machinery as `place=` whenever it
 * is the ONLY scoping param, and an unresolvable `near` keeps every result —
 * the `place`/`q` empty-set branch must not swallow it and blank the page.
 *
 * Real DB, because every layer exercised here IS the query: resolvePlace's
 * city/region catalog reads, getLocationTourIds' raw SQL region matching, the
 * mood ∩ scope intersection, and the distance centroid. Mocking prisma would
 * let a dropped filter still return "our" row and pass.
 *
 * `cacheHelper` is a pass-through so the 300s catalog caches (`hp:place:*`,
 * `hp:loctier:*`, `hp:regiontours:*`) cannot serve a pre-fixture answer.
 * `homepageRanking` is deliberately NOT mocked — `getLocationTourIds` is the
 * scoping engine under test (the sibling travioGhana suite mocks it to keep
 * its booking/admin focus).
 *
 * No network anywhere: region-shaped inputs resolve from the seeded catalog at
 * step 1 of resolvePlace (findRegion reads Tour.region), never the geocoder,
 * and the unresolvable case uses a stopword ("near"), which resolvePlace
 * rejects before any external lookup — so CI without egress is deterministic.
 *
 * Fixtures are keyed on a `nsg-` prefix and removed in afterAll. Isolated
 * `travio_test` (gated on TEST_DB_AVAILABLE).
 */
const request = require('supertest');

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/getConfig', () => jest.fn((_key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));
jest.mock('../../src/core/services/viewTracking', () => ({
  shouldCountTourView: jest.fn(async () => ({ counted: false, geo: null })),
  isInternalViewer: jest.fn(async () => false),
  getViewerGeo: jest.fn(() => null),
}));
// homepageRanking is real on purpose — see the file header.

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const { resolveCityCentroid } = require('../../src/core/services/locationGeo');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'nsg-';
const SUPPLIER_EMAIL = `${PREFIX}supplier@test.invalid`;

// The two Greater Accra tours and one Central Region tour that make every
// assertion below reachable: same region-scoped shapes production stores
// (suffixed regions, geolocated, tag-bearing), and geolocated only where a
// distance assertion needs it.
const ACCRA_LOWER = `${PREFIX}accra-lower`; // in scope + mood tag
const ACCRA_DEDENYA = `${PREFIX}accra-dedenya`; // in scope, NO mood tag
const CENTRAL_CAPE = `${PREFIX}central-cape`; // mood tag, OUT of scope

const MOOD = 'Animals & Nature'; // keyword group containing 'safari'
const REGION = 'Greater Accra Region';

const baseTour = {
  status: 'ACTIVE',
  country: 'Ghana',
  description: 'NSG fixture tour for the near-scoping suite.',
  // coverPhoto included: sibling suites (e.g. tours.test.js "the shape the
  // storefront binds to") bind the first ACTIVE tour the catalogue returns,
  // and a fixture without the field production always carries would poison
  // their assertion while it is being created here.
  coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/nsg-cover.jpg',
  photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/nsg-cover.jpg'],
  attractions: [], // no attraction may leak the Central tour into the Accra scope
  itineraryCities: [],
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

async function wipeFixtures() {
  await prisma.travioGhanaTour.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } });
  await prisma.tour.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

async function seedFixtures() {
  await prisma.$connect();
  await wipeFixtures();

  const supplier = await upsertUser(SUPPLIER_EMAIL, { name: 'NSG Supplier', roles: ['supplier'] });
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

  const accraLower = await upsertTour(ACCRA_LOWER, {
    title: 'NSG Accra Ridge Nature Walk',
    city: 'Accra',
    region: REGION,
    latitude: 5.6037,
    longitude: -0.187,
    tags: ['safari'],
    itineraryRegions: [REGION],
    supplierId: supplier.id,
  });

  const accraDedenya = await upsertTour(ACCRA_DEDENYA, {
    title: 'NSG Dedenya Hills Day Trip',
    city: 'Dedenya',
    region: REGION,
    latitude: 5.75,
    longitude: -0.1,
    tags: [], // in scope, but no mood tag → must drop out of the mood query
    itineraryRegions: [REGION],
    supplierId: supplier.id,
  });

  const centralCape = await upsertTour(CENTRAL_CAPE, {
    title: 'NSG Cape Coast Nature Escape',
    city: 'Cape Coast',
    region: 'Central Region',
    latitude: 5.105,
    longitude: -1.246,
    tags: ['safari'], // mood-tagged, but in ANOTHER region → must drop out
    itineraryRegions: ['Central Region'],
    supplierId: supplier.id,
  });

  const listings = [
    [accraLower, 91],
    [accraDedenya, 92],
    [centralCape, 93],
  ];
  for (const [tour, displayOrder] of listings) {
    await prisma.travioGhanaTour.upsert({
      where: { tourId: tour.id },
      update: { isActive: true, isFeatured: false, displayOrder },
      create: { tourId: tour.id, isActive: true, isFeatured: false, displayOrder },
    });
  }
}

describeDb('GHANA listing — near scoping (real DB)', () => {
  jest.setTimeout(60000);

  beforeAll(seedFixtures);
  afterAll(wipeFixtures);

  const getTours = (qs) => request(app).get(`/api/travioghana/tours?${qs}`);
  const slugs = (res) => res.body.data.tours.map((r) => r.tour.slug);
  const rowFor = (res, slug) => res.body.data.tours.find((r) => r.tour.slug === slug);

  it('scopes `near=<region>` to the region and labels the scope (the reported bug)', async () => {
    const res = await getTours(`near=${encodeURIComponent(REGION)}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.data.placeScope).toMatchObject({
      requested: REGION,
      mode: 'place',
      region: REGION,
    });

    const ids = slugs(res);
    expect(ids).toContain(ACCRA_LOWER);
    expect(ids).toContain(ACCRA_DEDENYA);
    // Cape Coast under a "near Greater Accra Region" heading was the bug.
    expect(ids).not.toContain(CENTRAL_CAPE);

    for (const slug of [ACCRA_LOWER, ACCRA_DEDENYA]) {
      const row = rowFor(res, slug);
      expect(row.tour.placeMatch).toBe(true);
      expect(typeof row.tour.placeRank).toBe('number');
      // The region centroid flows into distanceKm — the closest-first sort the
      // heading implies has something to sort by.
      expect(typeof row.tour.distanceKm).toBe('number');
      expect(row.tour.distanceKm).toBeGreaterThanOrEqual(0);
    }
  });

  it('accepts the bare region form the location filter can also produce', async () => {
    const res = await getTours(`near=${encodeURIComponent('Greater Accra')}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.data.placeScope).toMatchObject({ mode: 'place', region: REGION });

    const ids = slugs(res);
    expect(ids).toContain(ACCRA_LOWER);
    expect(ids).toContain(ACCRA_DEDENYA);
    expect(ids).not.toContain(CENTRAL_CAPE);
  });

  it('intersects the mood with the near scope instead of letting either win', async () => {
    const qs = `mood=${encodeURIComponent(MOOD)}&near=${encodeURIComponent(REGION)}&limit=50`;
    const res = await getTours(qs);
    expect(res.status).toBe(200);
    expect(res.body.data.placeScope).toMatchObject({ mode: 'place', region: REGION });

    const ids = slugs(res);
    expect(ids).toContain(ACCRA_LOWER); // in scope AND tagged for the mood
    expect(ids).not.toContain(ACCRA_DEDENYA); // in scope, not the mood
    expect(ids).not.toContain(CENTRAL_CAPE); // the mood, but out of scope
  });

  it('keeps every result for an unresolvable `near` instead of blanking the page', async () => {
    // "near" is a stopword: resolvePlace rejects it before any geocoder call,
    // so this is the deterministic offline path to "not a place".
    const res = await getTours(`near=near&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.data.placeScope).toBeNull();

    const ids = slugs(res);
    expect(ids).toContain(ACCRA_LOWER);
    expect(ids).toContain(CENTRAL_CAPE); // keep-all: the proximity hint may not empty the listing
  });

  it('lets `place=` win the scope when both are sent; `near` still adds distance', async () => {
    const qs = `place=${encodeURIComponent('Central Region')}&near=${encodeURIComponent(REGION)}&limit=50`;
    const res = await getTours(qs);
    expect(res.status).toBe(200);
    expect(res.body.data.placeScope).toMatchObject({ mode: 'place', region: 'Central Region' });

    const ids = slugs(res);
    expect(ids).toContain(CENTRAL_CAPE);
    expect(ids).not.toContain(ACCRA_LOWER);

    const row = rowFor(res, CENTRAL_CAPE);
    expect(row.tour.placeMatch).toBe(true);
    expect(typeof row.tour.distanceKm).toBe('number');
  });

  describe('resolveCityCentroid region fallback', () => {
    it('resolves a region-shaped name from the region column (city miss → region match)', async () => {
      const centroid = await resolveCityCentroid(REGION);
      expect(centroid).not.toBeNull();
      expect(centroid.lat).toBeGreaterThanOrEqual(5);
      expect(centroid.lat).toBeLessThanOrEqual(6.5);
      expect(centroid.lng).toBeGreaterThanOrEqual(-1);
      expect(centroid.lng).toBeLessThanOrEqual(0.5);
    });

    it('tolerates the bare/suffixed region mismatch (stray "Greater Accra" rows)', async () => {
      const centroid = await resolveCityCentroid('Greater Accra');
      expect(centroid).not.toBeNull();
    });

    it('returns null for a name that is neither a city nor a region', async () => {
      const centroid = await resolveCityCentroid('Zzz Nowhereville');
      expect(centroid).toBeNull();
    });
  });
});
