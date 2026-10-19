/**
 * Special offers, against Postgres — because the mocked unit suite beside this
 * one (`__tests__/unit/specialOfferController.test.js`) cannot see the query
 * this feature actually depends on.
 *
 * That suite hand-feeds `prisma.specialOffer.findMany` whatever rows it wants
 * to prove the window maths on. What it can never prove is that `assertNoOverlap`
 *'s own `where` clause finds those rows in the first place:
 *
 *     targets: { some: { tourId: { in: tourIds } } }
 *     isActive: true
 *     supplierId
 *     ...(selfId ? { id: { not: selfId } } : {})
 *
 * A relation name typed wrong, a `some` left off, `isActive` dropped — every
 * one of those passes every mocked test (the mock returns the offer regardless
 * of the filter) and then quietly stops detecting collisions in production. The
 * consequence is not a 500: it is two active discounts covering the same product
 * and period, which is the one thing this endpoint exists to prevent.
 *
 * So each test below asserts what the mock is structurally blind to:
 *
 *   - an overlapping window on a real existing offer → 409 (the relation filter
 *     resolves, and `targets` include round-trips);
 *   - a non-overlapping window → 201, with the row and its `targets` children
 *     actually in Postgres, end-of-UTC-day normalisation intact;
 *   - an offer switched OFF over the same window → allowed (`isActive: true`
 *     really is in the where — a mock always controls this itself);
 *   - a window starting the day AFTER the stored end-of-day → allowed, the
 *     same calendar day → 409 (the date that comes back out of Postgres is the
 *     date the check has to agree with);
 *   - another supplier's tour → 400, an unpublished tour → 400 (the `tour.findMany`
 *     where and select validate against the real schema);
 *   - editing an offer without moving its window → allowed (`id: { not: selfId }`),
 *     which a dropped `selfId` turns into every edit being rejected as a
 *     self-conflict;
 *   - a second supplier editing it → 404, and `GET` returning only their own
 *     offers with `computeStatus` computed from real stored timestamps.
 *
 * Kept mocked: `cacheHelper` as a pass-through (the supplier-resolution cache
 * would otherwise be able to remember "no profile" across a fixture that has
 * since been created), plus `emailService`, `queue`, `getConfig`, `auditLogger`
 * and `imageOptimizer` — creating an offer enqueues no mail of its own and this
 * suite is about the query, not the side effects.
 *
 * `config/jwt` is NOT mocked: tokens are minted for real users, so the whole
 * `protect → resolveSupplier → requireTeamPermission('products.update')` chain
 * runs for real.
 *
 * Fixtures are keyed on a `soff-` prefix and removed in `afterAll`.
 */
const request = require('supertest');

jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
  invalidateTourCaches: jest.fn(() => Promise.resolve()),
  TOUR_DETAIL_PREFIX: jest.fn((id) => `tour:${id}:`),
  _clearMemory: jest.fn(),
}));
jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  resolveEmailBrand: jest.fn(() => 'ghana'),
}));
jest.mock('../../src/core/services/getConfig', () => jest.fn((_key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const { signAccessToken } = require('../../config/jwt');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'soff-';

const OWNER1 = `${PREFIX}owner1`;
const OWNER2 = `${PREFIX}owner2`;
const emailFor = (name) => `${name}@example.test`;

/** Midnight UTC of `offset` days from now — offer windows are calendar days. */
function day(offset) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

/** The stored end of a window: last millisecond of that UTC day. */
function endOfDay(offset) {
  return new Date(day(offset).getTime() + 86399999);
}

const iso = (d) => d.toISOString();

let tokens;
let owner1;
let owner2;
let tour1;
let tour2;
let tourDraft;
let tourOther;
let seed1Id;
let seedOffId;
let seedOtherId;

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

async function upsertUser(name, data) {
  return prisma.user.upsert({
    where: { email: emailFor(name) },
    update: data,
    create: { firebaseUid: `test-${name}`, email: emailFor(name), photoURL: '', active: true, ...data },
  });
}

async function upsertProfile(owner) {
  const empty = {};
  return prisma.supplierProfile.upsert({
    where: { userId: owner.id },
    update: { status: 'ACTIVE' },
    create: {
      userId: owner.id,
      businessInfo: empty,
      operatingInfo: empty,
      representativeInfo: empty,
      businessDocuments: empty,
      payoutInfo: empty,
      compliance: empty,
      status: 'ACTIVE',
    },
  });
}

async function upsertTour(owner, key, status = 'ACTIVE') {
  const slug = `${PREFIX}${key}`;
  const existing = await prisma.tour.findFirst({ where: { slug } });
  if (existing) return existing.id;

  const created = await prisma.tour.create({
    data: {
      supplierId: owner.id,
      title: `SOFF ${key}`,
      description: 'A tour that exists so an offer has somewhere to point.',
      slug,
      photos: [],
      // coverPhoto set: tours.test.js binds the first ACTIVE tour's coverPhoto,
      // and a null-rated, coverPhoto-less fixture sorts to row 1 while this
      // suite's window is open (DESC NULLS FIRST).
      coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/soff-cover.jpg',
      categorization: {},
      theme: {},
      productContent: {},
      schedulesAndPricing: {},
      bookingAndTickets: {},
      status,
    },
  });
  return created.id;
}

/** Seed an offer row directly, so each test's own request is the only write. */
async function seedOffer({ supplierId, tourId, name, startOffset, endOffset, isActive = true }) {
  const existing = await prisma.specialOffer.findFirst({
    where: { supplierId, name },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.specialOffer.create({
    data: {
      supplierId,
      name,
      offerType: 'LIMITED_TIME',
      discountType: 'PERCENTAGE',
      discountPercentage: 15,
      startDate: day(startOffset),
      endDate: endOfDay(endOffset),
      isActive,
      targets: { create: [{ tourId }] },
    },
    select: { id: true },
  });
  return created.id;
}

/** The body `POST /api/suppliers/special-offers` expects for a windowed offer. */
function offerBody({ tourId, name, startOffset, endOffset }) {
  return {
    name,
    offerType: 'LIMITED_TIME',
    discountType: 'PERCENTAGE',
    discountPercentage: 25,
    startDate: iso(day(startOffset)),
    endDate: iso(day(endOffset)),
    isActive: true,
    targets: [{ tourId }],
  };
}

const CREATE = '/api/suppliers/special-offers';

describeDb('special offers: collision guard, writes and supplier scoping', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    await prisma.$connect();

    tokens = {};

    owner1 = await upsertUser(OWNER1, { name: 'SOFF Owner One', roles: ['supplier'] });
    owner2 = await upsertUser(OWNER2, { name: 'SOFF Owner Two', roles: ['supplier'] });

    await upsertProfile(owner1);
    await upsertProfile(owner2);

    tour1 = await upsertTour(owner1, 'tour-one');
    tour2 = await upsertTour(owner1, 'tour-two');
    tourDraft = await upsertTour(owner1, 'tour-draft', 'DRAFT');
    tourOther = await upsertTour(owner2, 'tour-other');

    // Windows all sit around today so `computeStatus` reports real states
    // rather than dates that were true when the file was written.
    seed1Id = await seedOffer({
      supplierId: owner1.id,
      tourId: tour1,
      name: `${PREFIX}seed active`,
      startOffset: -2,
      endOffset: 10,
    });
    seedOffId = await seedOffer({
      supplierId: owner1.id,
      tourId: tour2,
      name: `${PREFIX}seed switched off`,
      startOffset: -2,
      endOffset: 10,
      isActive: false,
    });
    seedOtherId = await seedOffer({
      supplierId: owner2.id,
      tourId: tourOther,
      name: `${PREFIX}seed other supplier`,
      startOffset: -2,
      endOffset: 10,
    });

    tokens.owner1 = signAccessToken({ userId: owner1.id });
    tokens.owner2 = signAccessToken({ userId: owner2.id });
  });

  afterAll(async () => {
    await prisma.specialOffer.deleteMany({
      where: { supplier: { email: { startsWith: PREFIX } } },
    });
    await prisma.tour.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.supplierProfile.deleteMany({
      where: { user: { email: { startsWith: PREFIX } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  describe('the overlap guard', () => {
    it('rejects a window that covers a product an active offer already covers', async () => {
      const res = await request(app)
        .post(CREATE)
        .set(auth('owner1'))
        .send(offerBody({ tourId: tour1, name: `${PREFIX}collide`, startOffset: 1, endOffset: 5 }));

      // The assertion the mocked suite can never make: the offer it would have
      // "returned" has to be FOUND, through `targets.some`, in Postgres.
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/overlaps/i);
    });

    it('writes a non-overlapping offer and its product targets to Postgres', async () => {
      const res = await request(app)
        .post(CREATE)
        .set(auth('owner1'))
        .send(offerBody({ tourId: tour1, name: `${PREFIX}new window`, startOffset: 20, endOffset: 30 }));

      expect(res.status).toBe(201);
      const created = res.body.data.offer;
      expect(created.supplierId).toBe(owner1.id);
      // The nested `targets.create` and the `include` the dashboards render
      // from are both real relations — a wrong name here is a 500 in prod.
      expect(created.targets).toHaveLength(1);
      expect(created.targets[0].tourId).toBe(tour1);
      expect(created.targets[0].tour.title).toBe(`SOFF tour-one`);

      const row = await prisma.specialOffer.findUnique({
        where: { id: created.id },
        include: { targets: true },
      });
      expect(row).not.toBeNull();
      expect(row.supplierId).toBe(owner1.id);
      expect(row.isActive).toBe(true);
      expect(row.targets).toHaveLength(1);
      expect(row.targets[0].tourId).toBe(tour1);

      // endDate is a calendar day: last millisecond of the chosen UTC day, not
      // the midnight the picker's date would otherwise store.
      expect(row.startDate.toISOString()).toBe(day(20).toISOString());
      expect(row.endDate.toISOString()).toBe(endOfDay(30).toISOString());
    });

    it('lets a switched-off offer leave the same window free', async () => {
      // `isActive: true` is part of the collision `where`. The unit suite
      // controls that value itself, so it has never been able to check that the
      // query asks for it — an inactive offer would otherwise block a supplier
      // from re-running a discount that never went live.
      const res = await request(app)
        .post(CREATE)
        .set(auth('owner1'))
        .send(offerBody({ tourId: tour2, name: `${PREFIX}after off`, startOffset: 1, endOffset: 5 }));

      expect(res.status).toBe(201);

      const stillOff = await prisma.specialOffer.findUnique({ where: { id: seedOffId } });
      expect(stillOff.isActive).toBe(false);
    });

    it('separates the last day of a window from the day after it', async () => {
      // The stored end-of-day has to agree with the value the guard compares
      // against. Off by a day in either direction and this pair flips.
      const sameDay = await request(app)
        .post(CREATE)
        .set(auth('owner1'))
        .send(offerBody({ tourId: tour1, name: `${PREFIX}last day`, startOffset: 10, endOffset: 13 }));
      expect(sameDay.status).toBe(409);

      const nextDay = await request(app)
        .post(CREATE)
        .set(auth('owner1'))
        .send(offerBody({ tourId: tour1, name: `${PREFIX}day after`, startOffset: 11, endOffset: 15 }));
      expect(nextDay.status).toBe(201);
    });

    it('refuses a tour owned by another supplier', async () => {
      const res = await request(app)
        .post(CREATE)
        .set(auth('owner1'))
        .send(offerBody({ tourId: tourOther, name: `${PREFIX}cross owner`, startOffset: 40, endOffset: 45 }));

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('You can only target tours you own');
    });

    it('refuses an unpublished tour', async () => {
      const res = await request(app)
        .post(CREATE)
        .set(auth('owner1'))
        .send(offerBody({ tourId: tourDraft, name: `${PREFIX}draft target`, startOffset: 40, endOffset: 45 }));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not published/i);
    });
  });

  describe('editing', () => {
    it('accepts an edit that keeps its own window', async () => {
      const res = await request(app)
        .put(`${CREATE}/${seed1Id}`)
        .set(auth('owner1'))
        .send({
          name: `${PREFIX}seed renamed`,
          startDate: iso(day(-2)),
          endDate: iso(day(10)),
        });

      // `id: { not: selfId }` in the collision query. Drop the exclusion and
      // every edit of an in-window offer reports itself as a conflict, which
      // locks suppliers out of fixing their own offer.
      expect(res.status).toBe(200);
      expect(res.body.data.offer.status).toBe('active');

      const row = await prisma.specialOffer.findUnique({ where: { id: seed1Id } });
      expect(row.name).toBe(`${PREFIX}seed renamed`);
    });

    it('rejects a date-only edit that would cover another active offer', async () => {
      // Two live offers on the same product, well clear of every other window
      // this suite uses.
      const first = await request(app)
        .post(CREATE)
        .set(auth('owner1'))
        .send(offerBody({ tourId: tour1, name: `${PREFIX}edit target a`, startOffset: 40, endOffset: 45 }));
      expect(first.status).toBe(201);

      const second = await request(app)
        .post(CREATE)
        .set(auth('owner1'))
        .send(offerBody({ tourId: tour1, name: `${PREFIX}edit target b`, startOffset: 48, endOffset: 55 }));
      expect(second.status).toBe(201);
      const idB = second.body.data.offer.id;

      // Move B on top of A — deliberately WITHOUT restating `targets`, which is
      // what a "just change the dates" edit sends. The guard has to fall back to
      // the stored products; if it doesn't, the dates land and the supplier ends
      // up running two discounts over the same week.
      const res = await request(app)
        .put(`${CREATE}/${idB}`)
        .set(auth('owner1'))
        .send({ startDate: iso(day(41)), endDate: iso(day(42)) });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/overlaps/i);

      // And the rejected window did not half-apply.
      const row = await prisma.specialOffer.findUnique({ where: { id: idB } });
      expect(row.startDate.toISOString()).toBe(day(48).toISOString());
      expect(row.endDate.toISOString()).toBe(endOfDay(55).toISOString());
    });

    it('refuses to touch another supplier\'s offer', async () => {
      const res = await request(app)
        .put(`${CREATE}/${seed1Id}`)
        .set(auth('owner2'))
        .send({ name: `${PREFIX}hijack` });

      // `findFirst({ where: { id, supplierId } })` — with a mocked Prisma the
      // supplierId half of that where is invisible, so "scoped to the owner"
      // and "not scoped at all" both returned the offer.
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Offer not found');

      const row = await prisma.specialOffer.findUnique({ where: { id: seed1Id } });
      expect(row.name).toBe(`${PREFIX}seed renamed`);
    });
  });

  describe('listing', () => {
    it('returns only this supplier\'s offers, with statuses computed from real dates', async () => {
      const mine = await request(app).get(CREATE).set(auth('owner1'));
      expect(mine.status).toBe(200);

      const ids = mine.body.data.offers.map((o) => o.id);
      expect(ids).not.toContain(seedOtherId);

      const byId = new Map(mine.body.data.offers.map((o) => [o.id, o]));
      // In-window and switched on.
      expect(byId.get(seed1Id).status).toBe('active');
      // In-window but switched off: precedence sends it to 'expired', never to
      // 'scheduled' — the label the supplier UI treats as launchable.
      expect(byId.get(seedOffId).status).toBe('expired');

      const theirs = await request(app).get(CREATE).set(auth('owner2'));
      expect(theirs.status).toBe(200);
      const theirIds = theirs.body.data.offers.map((o) => o.id);
      expect(theirIds).toEqual([seedOtherId]);
    });

    it('filters to live offers when asked, without dropping the switched-on one', async () => {
      const res = await request(app).get(`${CREATE}?activeOnly=true`).set(auth('owner1'));

      expect(res.status).toBe(200);
      const ids = res.body.data.offers.map((o) => o.id);
      expect(ids).toContain(seed1Id);
      expect(ids).not.toContain(seedOffId);
    });
  });
});
