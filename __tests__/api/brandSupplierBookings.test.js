/**
 * The supplier's Bookings page is served from the BRAND storefront routers
 * (`/api/travioghana/supplier/bookings`, `/api/travioafrica/supplier/bookings`):
 * both dashboards rewrite their `/bookings/supplier/*` calls into a brand
 * namespace, so these are the routes the page actually hits.
 *
 * Those routes were gated on `restrictTo('supplier')`, which reads the CALLER's
 * own `roles` — and a team member's own account carries `['customer']`, because
 * the supplier they work for is reached through the membership, not through
 * their roles. So the page was refused to every member of every role, and the
 * controller behind it scoped by `req.user.id`, which for a member owns no
 * tours at all. The visible result was an empty "No bookings yet" page with a
 * permission toast on both brands: indistinguishable from a supplier with no
 * bookings, which is how it survived the role audit.
 *
 * The fix scopes by `req.supplierId` — whoever the caller acts FOR: their own
 * account when they own the business, the owner's when they are a member
 * (`resolveSupplier` + `requireTeamPermission`).
 *
 * This suite used to mock Prisma, with `booking.findMany` returning `[]`. That
 * proved the guard let an editor through and that the query named the owner's
 * id in its where clause — but with nothing in the table, "scoped to the owner"
 * and "not scoped at all" returned the same empty page. There were two
 * businesses here and neither could be told apart from the other's.
 *
 * Running against `travio_test` gives each supplier a real tour and a real
 * booking, so the assertions are now about who sees WHAT:
 *
 *   - an editor member sees the OWNER's booking and not the second business's;
 *   - the same editor can move their own business's booking on, and gets a
 *     404 (not a 403) when they try the other business's — the write-side
 *     counterpart of the same boundary;
 *   - a support member, a finance member and a traveller are refused before
 *     any query runs, because `bookings.view` is admin + editor only.
 *
 * The write test also verifies the transition really landed in Postgres, which
 * a mocked `booking.update` could only ever confirm was called.
 *
 * Kept mocked: `cacheHelper` as a pass-through, plus `emailService`, `queue`,
 * `getConfig`, `auditLogger` and `imageOptimizer` — the status change enqueues
 * mail and events, none of which this suite is about.
 *
 * `config/jwt` is NOT mocked: tokens are minted for real users.
 *
 * Fixtures are keyed on a `bsb-` prefix and removed in `afterAll`.
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
  _clearMemory: jest.fn(),
}));
jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  resolveEmailBrand: jest.fn(() => 'ghana'),
}));
jest.mock('../../src/core/services/getConfig', () => jest.fn((_key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

// The controllers reach for the cancellation-request service to attach chips;
// keep the rest of it real, since other modules loaded by app.js use it.
jest.mock('../../src/core/services/cancellationRequestService', () => ({
  ...jest.requireActual('../../src/core/services/cancellationRequestService'),
  pendingRequestsForBookingIds: jest.fn(async () => new Map()),
}));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const { signAccessToken } = require('../../config/jwt');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'bsb-';

/** Two businesses, each with its own tour and its own booking. */
const OWNER1 = `${PREFIX}owner1`;
const OWNER2 = `${PREFIX}owner2`;
const EDITOR = `${PREFIX}editor`;
const SUPPORT = `${PREFIX}support`;
const FINANCE = `${PREFIX}finance`;
const TRAVELLER = `${PREFIX}traveller`;

const emailFor = (name) => `${name}@example.test`;

let booking1Id;
let booking2Id;
let tokens;

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

async function upsertUser(name, data) {
  return prisma.user.upsert({
    where: { email: emailFor(name) },
    update: data,
    create: { firebaseUid: `test-${name}`, email: emailFor(name), photoURL: '', active: true, ...data },
  });
}

async function upsertMember(name, supplierId, roles) {
  return prisma.teamMember.upsert({
    where: { supplierId_email: { supplierId, email: emailFor(name) } },
    update: { roles, role: roles[0], status: 'ACCEPTED' },
    create: {
      supplierId,
      email: emailFor(name),
      roles,
      role: roles[0],
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    },
  });
}

async function upsertProfile(owner) {
  const empty = {};
  return prisma.supplierProfile.upsert({
    where: { userId: owner.id },
    update: {},
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

async function upsertTour(owner, key) {
  const existing = await prisma.tour.findFirst({ where: { slug: `${PREFIX}${key}` } });
  if (existing) return existing.id;

  const created = await prisma.tour.create({
    data: {
      supplierId: owner.id,
      title: `BSB ${key}`,
      description: 'A tour that exists so a booking has somewhere to hang.',
      slug: `${PREFIX}${key}`,
      photos: [],
      categorization: {},
      theme: {},
      productContent: {},
      schedulesAndPricing: {},
      bookingAndTickets: {},
      status: 'ACTIVE',
    },
  });
  return created.id;
}

async function upsertBooking(key, tourId, customerId, reference) {
  const existing = await prisma.booking.findFirst({ where: { bookingNumber: reference } });
  if (existing) return existing.id;

  const created = await prisma.booking.create({
    data: {
      bookingNumber: reference,
      customerId,
      tourId,
      travelers: { adults: 2 },
      travelDate: new Date('2026-03-01T00:00:00.000Z'),
      subtotal: 100,
      grossAmount: 100,
      commissionRate: 0.15,
      platformCommission: 15,
      supplierPayout: 85,
      status: 'PENDING',
    },
  });
  return created.id;
}

/** Both dashboards rewrite into a brand namespace, and both brands serve it. */
const BRAND_LISTS = [
  '/api/travioghana/supplier/bookings',
  '/api/travioafrica/supplier/bookings',
];

const idsIn = (res) => res.body.data.bookings.map((b) => b.id);

describeDb('the supplier bookings page, per role, on both brands', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    await prisma.$connect();

    tokens = {};

    const owner1 = await upsertUser(OWNER1, { name: 'BSB Owner One', roles: ['supplier'] });
    const owner2 = await upsertUser(OWNER2, { name: 'BSB Owner Two', roles: ['supplier'] });
    const editor = await upsertUser(EDITOR, { name: 'BSB Editor', roles: ['customer'] });
    const support = await upsertUser(SUPPORT, { name: 'BSB Support', roles: ['customer'] });
    const finance = await upsertUser(FINANCE, { name: 'BSB Finance', roles: ['customer'] });
    const traveller = await upsertUser(TRAVELLER, { name: 'BSB Traveller', roles: ['customer'] });

    await upsertProfile(owner1);
    await upsertProfile(owner2);

    // `bookings.view` / `bookings.manage` are admin + editor. Support and
    // finance deliberately hold neither, and the traveller is not a member.
    await upsertMember(EDITOR, owner1.id, ['editor']);
    await upsertMember(SUPPORT, owner1.id, ['support']);
    await upsertMember(FINANCE, owner1.id, ['finance']);

    const tour1 = await upsertTour(owner1, 'tour-one');
    const tour2 = await upsertTour(owner2, 'tour-two');

    booking1Id = await upsertBooking('one', tour1, traveller.id, `${PREFIX}ref-one`);
    booking2Id = await upsertBooking('two', tour2, traveller.id, `${PREFIX}ref-two`);

    for (const [who, user] of Object.entries({ owner1, owner2, editor, support, finance, traveller })) {
      tokens[who] = signAccessToken({ userId: user.id });
    }
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { bookingNumber: { startsWith: PREFIX } } });
    await prisma.tour.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.teamMember.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.supplierProfile.deleteMany({
      where: { user: { email: { startsWith: PREFIX } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  describe.each(BRAND_LISTS)('the bookings list at %s', (LIST) => {
    it('serves an editor member the OWNER\'s bookings, and not another business\'s', async () => {
      const res = await request(app).get(LIST).set(auth('editor'));

      expect(res.status).toBe(200);
      const ids = idsIn(res);
      // The leak the mocked suite could not express: a second business's
      // booking is real, present, and must not appear here.
      expect(ids).toContain(booking1Id);
      expect(ids).not.toContain(booking2Id);
      expect(ids).toEqual([booking1Id]);
    });

    it('reports the summary for that one business only', async () => {
      const res = await request(app).get(LIST).set(auth('editor'));

      expect(res.body.data.summary).toEqual({
        totalRevenue: 100,
        totalEarnings: 85,
        totalBookings: 1,
      });
      expect(res.body.data.pagination.totalCount).toBe(1);
    });

    it('nests pagination inside data, where the shared dashboard client reads it', async () => {
      // Both supplier dashboards call the same helper, which unwraps
      // `response.data.data`. Pagination sitting at the top level reads as
      // null there, so the page showed one page of bookings however many
      // existed and suppliers could not page past the first ten.
      const res = await request(app).get(LIST).set(auth('editor'));

      expect(res.body.data.pagination).toMatchObject({
        currentPage: 1,
        totalCount: 1,
        limit: 10,
        totalPages: 1,
      });
      expect(res.body.pagination).toBeUndefined();
    });

    it('leaves the owner serving themselves, unchanged', async () => {
      const res = await request(app).get(LIST).set(auth('owner1'));

      expect(res.status).toBe(200);
      expect(idsIn(res)).toEqual([booking1Id]);
    });

    it('serves the second business its own booking', async () => {
      const res = await request(app).get(LIST).set(auth('owner2'));

      expect(res.status).toBe(200);
      expect(idsIn(res)).toEqual([booking2Id]);
    });

    it('refuses a support member — the page is not theirs (bookings.view)', async () => {
      const res = await request(app).get(LIST).set(auth('support'));

      expect(res.status).toBe(403);
    });

    it('refuses a finance member', async () => {
      const res = await request(app).get(LIST).set(auth('finance'));

      expect(res.status).toBe(403);
    });

    it('refuses a traveller, who is neither supplier nor member', async () => {
      const res = await request(app).get(LIST).set(auth('traveller'));

      expect(res.status).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      const res = await request(app).get(LIST);

      expect(res.status).toBe(401);
    });
  });

  describe.each(BRAND_LISTS)('the booking status change at %s', (LIST) => {
    // The two brand blocks share one row, and PENDING -> CONFIRMED can only
    // happen once. Reset it so each brand's write test exercises the real
    // transition rather than being handed the state the last block left.
    beforeEach(async () => {
      await prisma.booking.update({
        where: { id: booking1Id },
        data: { status: 'PENDING' },
      });
      await prisma.booking.update({
        where: { id: booking2Id },
        data: { status: 'PENDING' },
      });
    });

    it('lets an editor member move their own business\'s booking on, for real', async () => {
      const res = await request(app)
        .patch(`${LIST}/${booking1Id}/status`)
        .set(auth('editor'))
        .send({ status: 'CONFIRMED' });

      expect(res.status).toBe(200);

      // The transition is verified in Postgres, not against a mock: a mocked
      // `booking.update` reports success for any payload.
      const row = await prisma.booking.findUnique({ where: { id: booking1Id } });
      expect(row.status).toBe('CONFIRMED');
    });

    it('cannot reach the other business\'s booking — 404, not 403', async () => {
      const res = await request(app)
        .patch(`${LIST}/${booking2Id}/status`)
        .set(auth('editor'))
        .send({ status: 'CONFIRMED' });

      // The guard let them through — the route is theirs — but the controller
      // looks in the OWNER's bookings and finds nothing that isn't theirs.
      expect(res.status).toBe(404);

      const row = await prisma.booking.findUnique({ where: { id: booking2Id } });
      expect(row.status).toBe('PENDING');
    });

    it('refuses a support member — changing a booking is not theirs (bookings.manage)', async () => {
      const res = await request(app)
        .patch(`${LIST}/${booking1Id}/status`)
        .set(auth('support'))
        .send({ status: 'CONFIRMED' });

      expect(res.status).toBe(403);

      const row = await prisma.booking.findUnique({ where: { id: booking1Id } });
      expect(row.status).toBe('PENDING');
    });

    it('refuses a finance member', async () => {
      const res = await request(app)
        .patch(`${LIST}/${booking1Id}/status`)
        .set(auth('finance'))
        .send({ status: 'CANCELLED' });

      expect(res.status).toBe(403);

      const row = await prisma.booking.findUnique({ where: { id: booking1Id } });
      expect(row.status).toBe('PENDING');
    });
  });
});
