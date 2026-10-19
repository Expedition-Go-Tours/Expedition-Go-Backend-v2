/**
 * `getLocationTourIds` — the location tier behind six production call sites
 * (the tour detail page's related rail, the homepage location sections, the
 * place-scoped listing), and the single most load-bearing raw query in the
 * codebase.
 *
 * It joins `SupplierProfile` on `sp."userId" = t."supplierId"` while requiring
 * both `t.status = 'ACTIVE'` and `sp.status = 'ACTIVE'`, then matches the term
 * against `city` / `destinationCity` / `region` (with and without the " Region"
 * suffix) / `attractions` / `tags` / `itineraryCities` / `itineraryRegions`
 * with four LIKE shapes each — plus an optional platform join selected by
 * `Prisma.empty` when no brand flag is given.
 *
 * It earns a real database for three reasons the mocks could not reach:
 *
 *   1. The optional join is `Prisma.empty` on the unbranded path. That shape
 *      used to fail under Jest with `42601 syntax error at or near "$1"` — the
 *      fragment serialised as a bound parameter instead of being spliced — and
 *      the query had therefore never once executed inside the test suite.
 *   2. Every branch above is a `WHERE` clause. Asserting the assembled SQL
 *      says `LOWER(t.city) = $1` proves nothing about whether Postgres agrees
 *      that `'Zenzur'` matches `'zenzur'`, whether the `ESCAPE` clause is
 *      spelled right, or whether `unnest` sees the column at all.
 *   3. Two of these branches are customer-visible correctness: an `INNER JOIN`
 *      that became a `LEFT JOIN` would list tours for businesses that were
 *      never approved, and an unescaped `%` in the searched term would let
 *      `?city=%` match the entire catalogue.
 *
 * Fixtures are keyed to made-up Ghanaian place names and only ever asserted
 * through `pick()`, which filters the returned ids down to this suite's own
 * tours — so a concurrent suite's rows, or a seeded catalogue that one day
 * happens to contain a real town of the same name, cannot swing an assertion
 * either way.
 */

// Pass-through rather than real Redis: the 300-second tier cache would
// otherwise serve a previous run's answer for the same term, and these tests
// deliberately vary only one term at a time.
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');
const { getLocationTourIds } = require('../../src/core/services/homepageRanking');

const SLUG_PREFIX = 'hlr-';
const EMAIL_PREFIX = 'hlr-';

const ACTIVE_SUPPLIER_EMAIL = `${EMAIL_PREFIX}active@example.com`;
const PENDING_SUPPLIER_EMAIL = `${EMAIL_PREFIX}pending@example.com`;
const PROFILELESS_SUPPLIER_EMAIL = `${EMAIL_PREFIX}noprofile@example.com`;

const baseTour = {
  status: 'ACTIVE',
  country: 'Ghana',
  description: 'Fixture tour for the location-tier suite.',
  photos: [],
  // coverPhoto set: tours.test.js binds the first ACTIVE tour's coverPhoto,
  // and a null-rated, coverPhoto-less fixture sorts to row 1 while this
  // suite's window is open (DESC NULLS FIRST).
  coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/hlr-cover.jpg',
  tags: [],
  categorization: {},
  theme: {},
  productContent: {},
  schedulesAndPricing: {},
  bookingAndTickets: {},
  aiProcessingStatus: 'PENDING',
};

/** Fixture tour ids, and slug ↔ id, so expectations read as slugs. */
const idBySlug = new Map();
const slugById = new Map();

async function upsertUser(email, data) {
  return prisma.user.upsert({
    where: { email },
    update: data,
    create: { firebaseUid: `test-${email}`, email, photoURL: '', active: true, ...data },
  });
}

async function upsertTour(slug, data) {
  const tour = await prisma.tour.upsert({
    where: { slug },
    update: { ...baseTour, ...data },
    create: { slug, ...baseTour, ...data },
  });
  idBySlug.set(slug, tour.id);
  slugById.set(tour.id, slug);
  return tour;
}

async function upsertSupplier(userId, status) {
  return prisma.supplierProfile.upsert({
    where: { userId },
    update: { status },
    create: {
      userId,
      status,
      businessInfo: {},
      operatingInfo: {},
      representativeInfo: {},
      businessDocuments: {},
      payoutInfo: {},
      compliance: {},
    },
  });
}

describeDb('getLocationTourIds (real DB, raw SQL)', () => {
  jest.setTimeout(30000);

  let activeSupplierId;
  let pendingSupplierId;
  let profilelessSupplierId;

  /** Ids returned by a query, restricted to this suite's fixtures. */
  const pick = (ids) => ids.filter((id) => slugById.has(id));
  const slugOf = (id) => slugById.get(id);
  const idOf = (slug) => idBySlug.get(slug);

  beforeAll(async () => {
    await prisma.$connect();

    await prisma.tour.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    idBySlug.clear();
    slugById.clear();

    const active = await upsertUser(ACTIVE_SUPPLIER_EMAIL, {
      name: 'HLR Active Supplier',
      roles: ['supplier'],
    });
    activeSupplierId = active.id;
    await upsertSupplier(active.id, 'ACTIVE');

    const pending = await upsertUser(PENDING_SUPPLIER_EMAIL, {
      name: 'HLR Pending Supplier',
      roles: ['supplier'],
    });
    pendingSupplierId = pending.id;
    await upsertSupplier(pending.id, 'PENDING');

    // Registered but never onboarded: no SupplierProfile row at all. The tier
    // query INNER JOINs that table, so this tour must never surface.
    const profileless = await upsertUser(PROFILELESS_SUPPLIER_EMAIL, {
      name: 'HLR Profileless Supplier',
      roles: ['supplier'],
    });
    profilelessSupplierId = profileless.id;
    await prisma.supplierProfile.deleteMany({ where: { userId: profileless.id } });

    // ── city ────────────────────────────────────────────────────────────
    await upsertTour(`${SLUG_PREFIX}city`, {
      title: 'HLR city match',
      city: 'Zenzur',
      region: 'Ashanti Region',
      supplierId: activeSupplierId,
    });

    // ── destinationCity ─────────────────────────────────────────────────
    await upsertTour(`${SLUG_PREFIX}dest`, {
      title: 'HLR destinationCity match',
      destinationCity: 'Yapeikrom',
      supplierId: activeSupplierId,
    });

    // ── region, with and without the " Region" suffix ───────────────────
    await upsertTour(`${SLUG_PREFIX}region`, {
      title: 'HLR region match',
      region: 'Volta Region',
      supplierId: activeSupplierId,
    });

    // ── attractions: exact / prefix / suffix / word, plus a near miss ───
    await upsertTour(`${SLUG_PREFIX}att-exact`, {
      title: 'HLR attraction exact',
      attractions: ['klo'],
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}att-prefix`, {
      title: 'HLR attraction prefix',
      attractions: ['Klo Falls'],
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}att-suffix`, {
      title: 'HLR attraction suffix',
      attractions: ['Blue Klo'],
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}att-word`, {
      title: 'HLR attraction word',
      attractions: ['Old Klo Ridge'],
      supplierId: activeSupplierId,
    });
    // 'kloberry falls' starts with the letters but not the token — a LIKE
    // written as `klo%` rather than `klo %` would wrongly return this.
    await upsertTour(`${SLUG_PREFIX}att-near`, {
      title: 'HLR attraction near miss',
      attractions: ['Kloberry Falls'],
      supplierId: activeSupplierId,
    });

    // ── tags: exact / word, plus a near miss ────────────────────────────
    await upsertTour(`${SLUG_PREFIX}tag-exact`, {
      title: 'HLR tag exact',
      tags: ['Akwa'],
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}tag-word`, {
      title: 'HLR tag word',
      tags: ['Akwa Nights'],
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}tag-near`, {
      title: 'HLR tag near miss',
      tags: ['Akwanite'],
      supplierId: activeSupplierId,
    });

    // ── itineraryCities: exact / prefix, plus a near miss ───────────────
    await upsertTour(`${SLUG_PREFIX}itin-exact`, {
      title: 'HLR itinerary city exact',
      itineraryCities: ['Tafo'],
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}itin-prefix`, {
      title: 'HLR itinerary city prefix',
      itineraryCities: ['Tafo Junction'],
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}itin-near`, {
      title: 'HLR itinerary city near miss',
      itineraryCities: ['Tafoville'],
      supplierId: activeSupplierId,
    });

    // ── itineraryRegions: exact and suffix shapes ───────────────────────
    await upsertTour(`${SLUG_PREFIX}itinreg-exact`, {
      title: 'HLR itinerary region exact',
      itineraryRegions: ['Eastern Region'],
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}itinreg-suffix`, {
      title: 'HLR itinerary region suffix',
      itineraryRegions: ['Upper Eastern Region'],
      supplierId: activeSupplierId,
    });

    // ── LIKE escaping: the term is client-supplied (?city=) ─────────────
    await upsertTour(`${SLUG_PREFIX}esc-under`, {
      title: 'HLR underscore is literal',
      attractions: ['Togo_Lane Falls'],
      supplierId: activeSupplierId,
    });
    // Unescaped, `_` matches any character, so this bait would come back too.
    await upsertTour(`${SLUG_PREFIX}esc-under-bait`, {
      title: 'HLR underscore bait',
      attractions: ['TogoZlane Falls'],
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}esc-pct`, {
      title: 'HLR percent is literal',
      attractions: ['100% Ghana Falls'],
      supplierId: activeSupplierId,
    });
    // Unescaped, `%` matches any run of characters: '100xyz ghana falls'
    // satisfies a pattern of `100% ghana %`.
    await upsertTour(`${SLUG_PREFIX}esc-pct-bait`, {
      title: 'HLR percent bait',
      attractions: ['100xyz ghana Falls'],
      supplierId: activeSupplierId,
    });

    // ── must never match: unlisted supplier, draft tour, no profile ─────
    await upsertTour(`${SLUG_PREFIX}pending-supplier`, {
      title: 'HLR tour on an unapproved business',
      city: 'Zenzur',
      supplierId: pendingSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}draft`, {
      title: 'HLR draft tour',
      city: 'Zenzur',
      status: 'DRAFT',
      supplierId: activeSupplierId,
    });
    await upsertTour(`${SLUG_PREFIX}no-profile`, {
      title: 'HLR tour with no supplier profile',
      city: 'Zenzur',
      supplierId: profilelessSupplierId,
    });

    // ── platform joins: one city, three listing combinations ────────────
    const both = await upsertTour(`${SLUG_PREFIX}plat-both`, {
      title: 'HLR listed on both brands',
      city: 'Platformville',
      supplierId: activeSupplierId,
    });
    const ghanaOnly = await upsertTour(`${SLUG_PREFIX}plat-ghana`, {
      title: 'HLR listed on Ghana only',
      city: 'Platformville',
      supplierId: activeSupplierId,
    });
    const expOnly = await upsertTour(`${SLUG_PREFIX}plat-exp`, {
      title: 'HLR listed on Expedition only',
      city: 'Platformville',
      supplierId: activeSupplierId,
    });

    const listing = (tourId, isActive) => ({ tourId, isActive });
    await prisma.travioGhanaTour.upsert({
      where: { tourId: both.id },
      update: { isActive: true },
      create: listing(both.id, true),
    });
    await prisma.travioGhanaTour.upsert({
      where: { tourId: ghanaOnly.id },
      update: { isActive: true },
      create: listing(ghanaOnly.id, true),
    });
    await prisma.travioGhanaTour.upsert({
      where: { tourId: expOnly.id },
      update: { isActive: false },
      create: listing(expOnly.id, false),
    });
    await prisma.expeditionTour.upsert({
      where: { tourId: both.id },
      update: { isActive: true },
      create: listing(both.id, true),
    });
    await prisma.expeditionTour.upsert({
      where: { tourId: ghanaOnly.id },
      update: { isActive: false },
      create: listing(ghanaOnly.id, false),
    });
    await prisma.expeditionTour.upsert({
      where: { tourId: expOnly.id },
      update: { isActive: true },
      create: listing(expOnly.id, true),
    });
  });

  afterAll(async () => {
    await prisma.tour.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await prisma.$disconnect();
  });

  it('never queries for a term shorter than two characters', async () => {
    const queryRaw = jest.spyOn(prisma, '$queryRaw');
    try {
      expect(await getLocationTourIds('')).toEqual([]);
      expect(await getLocationTourIds('   ')).toEqual([]);
      expect(await getLocationTourIds(null)).toEqual([]);
      // Trims first: ' a ' is one character once padded, not three.
      expect(await getLocationTourIds(' a ')).toEqual([]);

      // The guard is an early return, not a WHERE clause — without it every
      // one-character keystroke on ?city= would be a round trip to Postgres.
      expect(queryRaw).not.toHaveBeenCalled();
    } finally {
      queryRaw.mockRestore();
    }
  });

  it('matches the tour city, case- and whitespace-insensitively', async () => {
    const ids = await getLocationTourIds('  ZENZUR  ');

    expect(pick(ids)).toEqual([idOf(`${SLUG_PREFIX}city`)]);
  });

  it('matches destinationCity', async () => {
    const ids = pick(await getLocationTourIds('yapeikrom'));

    expect(ids).toHaveLength(1);
    expect(slugOf(ids[0])).toBe(`${SLUG_PREFIX}dest`);
  });

  it('matches region with and without the " Region" suffix', async () => {
    const bare = pick(await getLocationTourIds('volta'));
    const full = pick(await getLocationTourIds('volta region'));

    expect(bare).toHaveLength(1);
    expect(slugOf(bare[0])).toBe(`${SLUG_PREFIX}region`);
    expect(full).toEqual(bare);
  });

  it('matches attractions on exact, prefix, suffix and word boundaries', async () => {
    const ids = pick(await getLocationTourIds('klo')).map(slugOf).sort();

    expect(ids).toEqual([
      `${SLUG_PREFIX}att-exact`,
      `${SLUG_PREFIX}att-prefix`,
      `${SLUG_PREFIX}att-suffix`,
      `${SLUG_PREFIX}att-word`,
    ].sort());
    // 'Kloberry Falls' shares the letters but not the token.
    expect(ids).not.toContain(`${SLUG_PREFIX}att-near`);
  });

  it('matches tags on exact and word boundaries', async () => {
    const ids = pick(await getLocationTourIds('akwa')).map(slugOf).sort();

    expect(ids).toEqual([`${SLUG_PREFIX}tag-exact`, `${SLUG_PREFIX}tag-word`].sort());
    expect(ids).not.toContain(`${SLUG_PREFIX}tag-near`);
  });

  it('matches itineraryCities on exact and prefix boundaries', async () => {
    const ids = pick(await getLocationTourIds('tafo')).map(slugOf).sort();

    expect(ids).toEqual([`${SLUG_PREFIX}itin-exact`, `${SLUG_PREFIX}itin-prefix`].sort());
    expect(ids).not.toContain(`${SLUG_PREFIX}itin-near`);
  });

  it('matches itineraryRegions with and without the suffix', async () => {
    // Suffix-free: 'eastern %' hits 'Eastern Region', '% eastern %' hits
    // 'Upper Eastern Region'.
    const bare = pick(await getLocationTourIds('eastern')).map(slugOf).sort();
    // Full form: equality on one, '% eastern region' on the other.
    const full = pick(await getLocationTourIds('eastern region')).map(slugOf).sort();

    expect(bare).toEqual([`${SLUG_PREFIX}itinreg-exact`, `${SLUG_PREFIX}itinreg-suffix`].sort());
    expect(full).toEqual(bare);
  });

  it('treats `_` in the searched term as a literal character', async () => {
    const ids = pick(await getLocationTourIds('togo_lane')).map(slugOf);

    expect(ids).toEqual([`${SLUG_PREFIX}esc-under`]);
    // Without ESCAPE, `_` matches any single character and this bait returns.
    expect(ids).not.toContain(`${SLUG_PREFIX}esc-under-bait`);
  });

  it('treats `%` in the searched term as a literal character', async () => {
    const ids = pick(await getLocationTourIds('100% ghana')).map(slugOf);

    expect(ids).toEqual([`${SLUG_PREFIX}esc-pct`]);
    // Without ESCAPE, `%` matches any run of characters and this bait returns —
    // which is also how `?city=%` would have matched the whole catalogue.
    expect(ids).not.toContain(`${SLUG_PREFIX}esc-pct-bait`);
  });

  it('returns only tours that are live and belong to an approved business', async () => {
    // One query over one city, holding every exclusion the JOIN and WHERE
    // clauses are responsible for. Three fixtures share this city precisely so
    // a single read can prove what comes back AND what does not.
    const ids = pick(await getLocationTourIds('zenzur')).map(slugOf);

    expect(ids).toEqual([`${SLUG_PREFIX}city`]);
    // Business registered but never approved.
    expect(ids).not.toContain(`${SLUG_PREFIX}pending-supplier`);
    // Business with no SupplierProfile row at all — an INNER JOIN that turned
    // into a LEFT JOIN would surface this one.
    expect(ids).not.toContain(`${SLUG_PREFIX}no-profile`);
    // Listing switched off.
    expect(ids).not.toContain(`${SLUG_PREFIX}draft`);
  });

  it('returns nothing for a place with no tours', async () => {
    expect(await getLocationTourIds(`zzq-no-such-place-${Date.now()}`)).toEqual([]);
  });

  describe('platform join', () => {
    it('returns every brand listing when no flag is given', async () => {
      // This is the `Prisma.empty` branch — the one that used to fail under
      // Jest with 42601 and had therefore never executed in a test.
      const ids = pick(await getLocationTourIds('platformville')).map(slugOf).sort();

      expect(ids).toEqual([
        `${SLUG_PREFIX}plat-both`,
        `${SLUG_PREFIX}plat-exp`,
        `${SLUG_PREFIX}plat-ghana`,
      ].sort());
    });

    it('requires an active Ghana listing when ghanaOnly is set', async () => {
      const ids = pick(await getLocationTourIds('platformville', true, false)).map(slugOf).sort();

      expect(ids).toEqual([`${SLUG_PREFIX}plat-both`, `${SLUG_PREFIX}plat-ghana`].sort());
    });

    it('requires an active Expedition listing when expeditionOnly is set', async () => {
      const ids = pick(await getLocationTourIds('platformville', false, true)).map(slugOf).sort();

      expect(ids).toEqual([`${SLUG_PREFIX}plat-both`, `${SLUG_PREFIX}plat-exp`].sort());
    });
  });

  it('keys the tier cache on the normalized term and the platform flag', async () => {
    cache.getOrSet.mockClear();

    await getLocationTourIds('  Platformville ', false, false);
    await getLocationTourIds('  Platformville ', true, false);
    await getLocationTourIds('  Platformville ', false, true);

    // Three different answers for three different queries. If the flag were
    // missing from the key, whichever variant ran first would be served to the
    // other two for the next five minutes.
    expect(cache.getOrSet.mock.calls.map((c) => c[0])).toEqual([
      'hp:loctier:platformville',
      'hp:loctier:platformville:ghana',
      'hp:loctier:platformville:exp',
    ]);
    // And the TTL has to travel with the key, or a stale tier list outlives
    // the catalogue edit that invalidated it.
    expect(cache.getOrSet.mock.calls.every((c) => c[2] === 300)).toBe(true);
  });
});
