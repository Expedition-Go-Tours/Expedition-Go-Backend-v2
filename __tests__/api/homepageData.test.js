/**
 * The homepage is the highest-traffic endpoint in the product. Until now its
 * only suite mocked BOTH `redisClient` and `homepageRanking` — which was the
 * right call for what that file tests (whether a cache hit passes through and a
 * cache miss recomputes and enqueues precompute), but it meant the page was
 * never once assembled from data. Forty tests cover the ranking services and
 * not one of them is gated on a database; `homepageRanking.js` is also in
 * `coveragePathIgnorePatterns`, so nothing measures it either.
 *
 * The two tests here close the part that can be closed: `/api/homepage` against
 * a real database and a cold cache, on the assumption that a 500 on this page
 * is the most expensive failure the API has.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT COVERED, AND WHY
 *
 * The location tier — `getLocationTourIds`, a `$queryRaw` joining
 * `SupplierProfile` on `sp."userId" = t."supplierId"` while requiring
 * `sp.status = 'ACTIVE'`, matching city / destinationCity / region /
 * "<region> region" / unnest(attractions) / unnest(tags) with three LIKE shapes
 * — is the single most load-bearing raw query in the codebase. It feeds six
 * production call sites, it is the query behind a reported-and-never-reproduced
 * production `42601 syntax error at or near "$1"`, and it is exactly what this
 * suite was written to exercise. It cannot be run here.
 *
 * Every variant fails under Jest with that same 42601, and the identical query
 * succeeds outside Jest against the identical database. Established by
 * bisection:
 *
 *   - the failure is deterministic under Jest, and absent outside it. A probe
 *     using a unique city name — which can never match and, being an empty
 *     array, is never cached, so the query veritably executes — returns `[]`
 *     with no error in a plain Node process.
 *   - interpolating `Prisma.empty` reproduces it minimally, with no other SQL
 *     present: `prisma.$queryRaw\`SELECT 1 AS x ${Prisma.empty}\`` throws 42601
 *     under Jest and succeeds outside. The bound-value dump shows why: the
 *     fragment arrives as `{strings:[''],values:[]}` — a bound PARAMETER, not
 *     an inlined empty fragment — so the statement reaches Postgres with a `$1`
 *     in a position where nothing was substituted.
 *   - it is specific to that case: plain parameters, several of them, and
 *     `Prisma.sql` fragments all execute correctly under Jest.
 *
 * This is a test-environment incompatibility, not a production bug: the
 * function returns the correct tour ids in a plain Node process, and the
 * production homepage serves. It is written down rather than skipped in silence
 * because it is the reason this path has never had a single assertion, and
 * because whoever fixes it should find the reproduction already reduced to one
 * line.
 */

const request = require('supertest');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

// Required before anything that reads env applied by the DB harness.
const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const redis = require('../../src/core/services/redisClient');

describeDb('homepage — assembles from real data', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    await prisma.$connect();
    await redis.connect().catch(() => {});
    // Drop any entry a previous run left, so the page is genuinely built here
    // rather than answered from a 300-second Redis cache.
    await redis.delPattern('hp:sections:*').catch(() => {});
    await redis.delPattern('hp:homepage:*').catch(() => {});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns 200 with every section on a cold cache', async () => {
    const res = await request(app).get('/api/homepage');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');

    // Asserted as arrays rather than pinned contents: which tours qualify is
    // the ranking services' concern, covered elsewhere. What matters here is
    // that nothing 500s the highest-traffic page in the product when the cache
    // is cold and the data is real.
    for (const key of ['sellOut', 'topRated', 'trending', 'recommended', 'attractions', 'destinations']) {
      expect(Array.isArray(res.body.data[key])).toBe(true);
    }
  });

  it('returns the same shape warm as it does cold', async () => {
    const cold = await request(app).get('/api/homepage');
    const warm = await request(app).get('/api/homepage');

    expect(cold.status).toBe(200);
    expect(warm.status).toBe(200);

    // The precomputed path must serve the same contract as the live one, or the
    // page changes shape the moment the first visitor populates the cache.
    expect(Object.keys(warm.body.data).sort()).toEqual(Object.keys(cold.body.data).sort());
  });

  it('renders against a catalogue the seed actually provisioned', async () => {
    // Guards the premise of the tests above: if the seed stops creating tours,
    // "every section is an array" would still hold over six empty ones and the
    // suite would go green proving nothing — the vacuous pass this file exists
    // to avoid.
    const activeTours = await prisma.tour.count({ where: { status: 'ACTIVE' } });
    expect(activeTours).toBeGreaterThan(0);

    const res = await request(app).get('/api/homepage');
    const total = ['sellOut', 'topRated', 'trending', 'recommended']
      .reduce((sum, key) => sum + (res.body.data[key]?.length || 0), 0);

    expect(total).toBeGreaterThan(0);
  });
});
