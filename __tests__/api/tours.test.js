/**
 * GET /api/tours — the storefront's primary read.
 *
 * The previous version of this file asserted `Array.isArray(res.body.data.tours)`
 * and `limit=5 → length <= 5`, both of which pass against an empty table. With a
 * seed that created no tours, every test here was green without reading a row —
 * a filter could have been broken, pagination could have returned the wrong
 * count, and none of it would show. `prisma/seed.js` now provisions an ACTIVE
 * catalogue, so these assert on content and math instead of shape.
 *
 * Runs against a real database (gated on TEST_DB_AVAILABLE), which
 * scripts/test-db-up.sh provisions as the isolated `travio_test`.
 */

const request = require('supertest');
const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

describeDb('GET /api/tours', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    await prisma.$connect();
    // `getAllTours` caches every query hash in shared Redis for 300s. A response
    // cached before this run's seed would make every assertion below read stale
    // data, so the list and filter-option entries are dropped first.
    await cache.invalidateKeys([cache.TOUR_LIST_PREFIX, cache.TOUR_FILTERS_KEY]);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** The catalogue the endpoint should be reading. */
  const activeCount = () => prisma.tour.count({ where: { status: 'ACTIVE' } });

  it('returns 200 with a non-empty paginated catalogue', async () => {
    const seeded = await activeCount();
    // If this fails there is nothing to read and the rest of the suite is
    // vacuous — it is the guard that makes the other assertions mean anything.
    expect(seeded).toBeGreaterThan(0);

    const res = await request(app).get('/api/tours');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(Array.isArray(res.body.data.tours)).toBe(true);
    expect(res.body.data.tours.length).toBeGreaterThan(0);
    expect(res.body.data.pagination.totalCount).toBe(seeded);
    expect(res.body.data.pagination.currentPage).toBe(1);
    expect(res.body.data.pagination.limit).toBe(12);
    expect(res.body.data.pagination.totalPages).toBe(Math.ceil(seeded / 12));
    expect(res.body.data.pagination.hasNextPage).toBe(seeded > 12);
    expect(res.body.data.pagination.hasPrevPage).toBe(false);
  });

  it('returns the shape the storefront binds to', async () => {
    const res = await request(app).get('/api/tours');
    const [tour] = res.body.data.tours;

    expect(tour).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      slug: expect.any(String),
      status: 'ACTIVE',
    });
    expect(tour.coverPhoto).toBeTruthy();

    // supplier is re-shaped by the handler (not returned raw), so assert the
    // fields the listing card actually reads.
    expect(tour.supplier).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      supplierType: expect.any(String),
      verified: expect.any(Boolean),
    });

    // _count comes from the relation include; a wrong include shows up here.
    expect(tour._count).toMatchObject({
      reviews: expect.any(Number),
      bookings: expect.any(Number),
    });
  });

  it('respects the limit query parameter', async () => {
    const res = await request(app).get('/api/tours?limit=5');

    expect(res.status).toBe(200);
    expect(res.body.data.tours.length).toBeGreaterThan(0);
    expect(res.body.data.tours.length).toBeLessThanOrEqual(5);
    expect(res.body.data.pagination.limit).toBe(5);
    expect(res.body.data.pagination.totalPages).toBe(Math.ceil((await activeCount()) / 5));
  });

  it('walks pages without repeating or dropping tours', async () => {
    const seeded = await activeCount();
    const limit = 5;
    const first = await request(app).get(`/api/tours?limit=${limit}&page=1`);
    const second = await request(app).get(`/api/tours?limit=${limit}&page=2`);

    expect(first.body.data.tours.length).toBe(Math.min(limit, seeded));
    expect(first.body.data.pagination.hasPrevPage).toBe(false);
    expect(first.body.data.pagination.hasNextPage).toBe(seeded > limit);

    const lastPage = Math.ceil(seeded / limit);
    if (lastPage > 1) {
      expect(second.body.data.pagination.hasPrevPage).toBe(true);
      expect(second.body.data.tours.length).toBe(seeded - limit);
      expect(second.body.data.pagination.hasNextPage).toBe(false);

      const firstIds = first.body.data.tours.map((t) => t.id);
      const secondIds = second.body.data.tours.map((t) => t.id);
      expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    }
  });

  it('filters by category against the scalar column', async () => {
    // `buildTourFilters` reads the `category` column, not the `categorization`
    // JSON — seeding only the JSON would silently return everything.
    const expected = await prisma.tour.count({
      where: { status: 'ACTIVE', category: { equals: 'Adventure', mode: 'insensitive' } },
    });
    expect(expected).toBeGreaterThan(0);

    const res = await request(app).get('/api/tours?category=Adventure');

    expect(res.status).toBe(200);
    expect(res.body.data.tours.length).toBe(expected);
    expect(res.body.data.pagination.totalCount).toBe(expected);
    for (const tour of res.body.data.tours) {
      expect(tour.category.toLowerCase()).toBe('adventure');
    }
    expect(res.body.data.appliedFilters.category).toBe('Adventure');
  });

  it('filters by city', async () => {
    const expected = await prisma.tour.count({
      where: { status: 'ACTIVE', city: { equals: 'Accra', mode: 'insensitive' } },
    });
    expect(expected).toBeGreaterThan(0);

    const res = await request(app).get('/api/tours?city=Accra');

    expect(res.body.data.tours.length).toBe(expected);
    for (const tour of res.body.data.tours) {
      expect(tour.city.toLowerCase()).toBe('accra');
    }
  });

  it('narrows a page when a filter removes tours', async () => {
    const all = await request(app).get('/api/tours?limit=12');
    const filtered = await request(app).get('/api/tours?limit=12&category=Adventure');

    expect(filtered.body.data.pagination.totalCount)
      .toBeLessThan(all.body.data.pagination.totalCount);
    expect(filtered.body.data.tours.length).toBeGreaterThan(0);
  });

  it('returns 400 for invalid pagination params', async () => {
    const res = await request(app).get('/api/tours?page=-1');

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('fail');
  });

  it('publishes the seeded categories as filter options', async () => {
    const res = await request(app).get('/api/tours/filters/options');

    expect(res.status).toBe(200);
    // The handler nests under `filterOptions`, not directly under `data`.
    const { categories } = res.body.data.filterOptions;
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.length).toBeGreaterThan(0);
    expect(categories.map((c) => c.toLowerCase())).toContain('adventure');
  });
});
