/**
 * The Analytics page is gated on `analytics.view` (admin + editor + finance),
 * but it used to build its per-product charts by calling the supplier's BOOKINGS
 * LIST — `bookings.view`, which is admin + editor. A finance member could open
 * Analytics and got a "You do not have permission" error instead of the charts.
 *
 * These tests cover the endpoint that replaced it: keyed on the same permission
 * as the page, scoped to the supplier the caller acts for.
 *
 * It previously mocked `prismaClient`, which left the two things that endpoint
 * exists to do asserted only against ourselves:
 *
 *   - The aggregation. `booking.groupBy` was stubbed with
 *     `{ _count: { _all: 7 }, _sum: { grossAmount: 2100 } }` and the expected
 *     answer was written out by hand as `{ bookings: 7, revenue: 2100 }`. The
 *     mapping `_count._all → bookings` and `_sum.grossAmount → revenue` is the
 *     whole contract, and a stub cannot get it wrong. Neither can it notice that
 *     `Tour.coverPhoto` — selected here, and the column whose absence produced
 *     a production 500 elsewhere — has been renamed.
 *
 *   - The scoping. `supplierId` scoping was verified by asserting the argument
 *     passed to the mock. A tour belonging to a DIFFERENT supplier now holds
 *     bookings too, and its id must be absent from the response.
 *
 * Three further cases are only expressible against real data, and all three are
 * money-shaped: `isSimulated` bookings are excluded from revenue, the ranking
 * is by revenue descending, and a supplier with no bookings reads as an empty
 * list rather than an error.
 *
 * One original case is gone rather than converted: it expected the name
 * "Unknown product" for a tour the join could not resolve. `booking.tourId` is
 * a foreign key, so a grouped row without a tour cannot exist — the branch is
 * defensive, unreachable here, and better kept than deleted but not something a
 * database can be asked to produce.
 *
 * `cacheHelper` is a pass-through: the controller caches per supplier for 60
 * seconds, which would otherwise let an earlier test's buckets answer a later
 * one's.
 */

const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  resolveEmailBrand: jest.fn(() => 'ghana'),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const E = (n) => `apa-${n}@test.invalid`;
const EMAILS = [
  E('owner'), E('other'), E('empty'), E('editor'), E('finance'),
  E('support'), E('customer'),
];

const PRODUCTS = '/api/suppliers/analytics/products';

let owner;
let ownerTourA;
let ownerTourB;
let ownerTourSimulated;
let otherTour;
let finance;
const created = { users: [], profiles: [], members: [], tours: [], bookings: [] };

async function makeUser(email, roles) {
  const user = await prisma.user.create({
    data: {
      firebaseUid: `test-${email}`,
      name: `APA ${email}`,
      email,
      roles,
      active: true,
      photoURL: '',
    },
  });
  created.users.push(user.id);
  return user;
}

async function makeProfile(userId) {
  const profile = await prisma.supplierProfile.create({
    data: {
      userId,
      status: 'ACTIVE',
      supplierType: 'TOUR_COMPANY',
      businessInfo: {},
      operatingInfo: {},
      representativeInfo: {},
      businessDocuments: {},
      payoutInfo: {},
      compliance: {},
    },
  });
  created.profiles.push(profile.id);
  return profile;
}

async function makeMember(email, supplierId, roles) {
  const member = await prisma.teamMember.create({
    data: { email, supplierId, roles, role: roles[0] || null, status: 'ACCEPTED' },
  });
  created.members.push(member.id);
  return member;
}

async function makeTour(supplierId, { slug, title, coverPhoto, averageRating }) {
  const tour = await prisma.tour.create({
    data: {
      supplierId,
      slug,
      title,
      description: `${title} — analytics fixture.`,
      status: 'ACTIVE',
      country: 'Ghana',
      photos: ['https://cdn.test/apa.jpg'],
      coverPhoto,
      averageRating,
      categorization: {},
      theme: {},
      productContent: {},
      schedulesAndPricing: {},
      bookingAndTickets: {},
      tags: ['apa'],
    },
  });
  created.tours.push(tour.id);
  return tour;
}

let seq = 0;
async function makeBooking(tour, customerId, { gross, payout, isSimulated = false }) {
  seq += 1;
  const booking = await prisma.booking.create({
    data: {
      bookingNumber: `APA-${String(seq).padStart(4, '0')}`,
      customerId,
      tourId: tour.id,
      status: 'CONFIRMED',
      paymentStatus: 'SUCCEEDED',
      currency: 'USD',
      isSimulated,
      travelers: { adults: 2, children: 0, infants: 0 },
      travelDate: new Date('2026-12-01T09:00:00.000Z'),
      subtotal: gross,
      grossAmount: gross,
      commissionRate: 0.10,
      platformCommission: gross - payout,
      supplierPayout: payout,
    },
  });
  created.bookings.push(booking.id);
  return booking;
}

const auth = (user) => ({ Authorization: `Bearer ${signAccessToken({ userId: user.id })}` });

describeDb('per-product analytics (real DB)', () => {
  jest.setTimeout(30000);

  let editor;
  let support;
  let customer;
  let emptyOwner;

  beforeAll(async () => {
    await prisma.$connect();

    // Clear residue so counts and totals below are exact.
    await prisma.booking.deleteMany({ where: { bookingNumber: { startsWith: 'APA-' } } });
    await prisma.teamMember.deleteMany({ where: { email: { in: EMAILS } } });
    await prisma.supplierProfile.deleteMany({ where: { user: { email: { in: EMAILS } } } });
    await prisma.tour.deleteMany({ where: { slug: { startsWith: 'apa-' } } });
    await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });

    owner = await makeUser(E('owner'), ['supplier']);
    const otherOwner = await makeUser(E('other'), ['supplier']);
    emptyOwner = await makeUser(E('empty'), ['supplier']);
    editor = await makeUser(E('editor'), ['customer']);
    finance = await makeUser(E('finance'), ['customer']);
    support = await makeUser(E('support'), ['customer']);
    customer = await makeUser(E('customer'), ['customer']);

    await makeProfile(owner.id);
    await makeProfile(otherOwner.id);
    await makeProfile(emptyOwner.id);

    // A finance member may open Analytics but may not open the Bookings page —
    // the exact mismatch this endpoint exists to fix.
    await makeMember(E('finance'), owner.id, ['finance']);
    await makeMember(E('editor'), owner.id, ['editor']);
    await makeMember(E('support'), owner.id, ['support']);

    ownerTourA = await makeTour(owner.id, {
      slug: 'apa-shai-hills', title: 'Shai Hills Safari',
      coverPhoto: 'https://cdn.test/shai.jpg', averageRating: 4.5,
    });
    ownerTourB = await makeTour(owner.id, {
      slug: 'apa-cape-coast', title: 'Cape Coast Castle',
      // coverPhoto deliberately NULL: the handler must surface the column as
      // stored, and this is the only fixture in the suite that proves it.
      // (A coverless ACTIVE tour does sort to row 1 of GET /api/tours for as
      // long as this suite's window is open; tours.test.js guards against
      // that by not binding a single fixture row.)
      coverPhoto: null, averageRating: 4.1,
    });
    ownerTourSimulated = await makeTour(owner.id, {
      slug: 'apa-simulated', title: 'Simulated Practice Tour',
      coverPhoto: 'https://cdn.test/sim.jpg', averageRating: 5,
    });
    otherTour = await makeTour(otherOwner.id, {
      slug: 'apa-other-supplier', title: 'Another Supplier Tour',
      coverPhoto: 'https://cdn.test/other.jpg', averageRating: 4.9,
    });

    // 3 x 700 = 2100 gross, 3 x 490 = 1470 payout.
    await makeBooking(ownerTourA, customer.id, { gross: 700, payout: 490 });
    await makeBooking(ownerTourA, customer.id, { gross: 700, payout: 490 });
    await makeBooking(ownerTourA, customer.id, { gross: 700, payout: 490 });
    // 2 x 150 = 300 gross, 2 x 105 = 210 payout.
    await makeBooking(ownerTourB, customer.id, { gross: 150, payout: 105 });
    await makeBooking(ownerTourB, customer.id, { gross: 150, payout: 105 });

    // Simulated bookings must not reach revenue, however large.
    await makeBooking(ownerTourSimulated, customer.id, { gross: 99999, payout: 99999, isSimulated: true });

    // Another supplier's bookings must not reach this supplier's charts at all.
    await makeBooking(otherTour, customer.id, { gross: 5000, payout: 4000 });
    await makeBooking(otherTour, customer.id, { gross: 5000, payout: 4000 });
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { id: { in: created.bookings } } }).catch(() => {});
    await prisma.teamMember.deleteMany({ where: { id: { in: created.members } } }).catch(() => {});
    await prisma.tour.deleteMany({ where: { id: { in: created.tours } } }).catch(() => {});
    await prisma.supplierProfile.deleteMany({ where: { id: { in: created.profiles } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
    await prisma.$disconnect();
  });

  const get = (user) => request(app).get(PRODUCTS).set(auth(user));

  it('serves a FINANCE member the charts — the page is theirs to open', async () => {
    const res = await get(finance);

    expect(res.status).toBe(200);
    expect(res.body.data.products).toHaveLength(2);
  });

  it('serves an editor member and the owner too', async () => {
    expect((await get(editor)).status).toBe(200);
    expect((await get(owner)).status).toBe(200);
  });

  it('refuses a support member — Analytics is not theirs (analytics.view)', async () => {
    const res = await get(support);

    expect(res.status).toBe(403);
  });

  it('refuses a traveller', async () => {
    expect((await get(customer)).status).toBe(403);
  });

  it('groups the OWNER’s bookings, and nobody else’s', async () => {
    const res = await get(owner);
    const ids = res.body.data.products.map((p) => p.tourId);

    expect(ids).toContain(ownerTourA.id);
    expect(ids).toContain(ownerTourB.id);

    // Another supplier's tour holds the two largest bookings in the table
    // (10000 gross between them). A leaked scope would put it at the top.
    expect(ids).not.toContain(otherTour.id);
    expect(res.body.data.products.some((p) => p.name === 'Another Supplier Tour')).toBe(false);
  });

  it('excludes simulated bookings from revenue', async () => {
    const res = await get(owner);
    const ids = res.body.data.products.map((p) => p.tourId);

    // This tour's only booking is simulated, and is worth more than every real
    // booking combined — including it would both add a row and distort totals.
    expect(ids).not.toContain(ownerTourSimulated.id);
  });

  it('joins the counts and sums to the tour title, photo and rating', async () => {
    const res = await get(owner);

    expect(res.body.data.products).toEqual([
      {
        tourId: ownerTourA.id, name: 'Shai Hills Safari',
        photo: 'https://cdn.test/shai.jpg', rating: 4.5,
        bookings: 3, revenue: 2100, payout: 1470,
      },
      {
        tourId: ownerTourB.id, name: 'Cape Coast Castle',
        photo: null, rating: 4.1,
        bookings: 2, revenue: 300, payout: 210,
      },
    ]);
  });

  it('ranks by revenue, highest first', async () => {
    const res = await get(owner);
    const revenues = res.body.data.products.map((p) => p.revenue);

    expect(revenues).toEqual([...revenues].sort((a, b) => b - a));
    expect(res.body.data.products[0].name).toBe('Shai Hills Safari');
  });

  it('every returned product resolves to a real tour', async () => {
    // `booking.tourId` is a foreign key, so a grouped row can never lack its
    // tour — which is why the "Unknown product" fallback is defensive only.
    const res = await get(owner);

    for (const product of res.body.data.products) {
      expect(product.name).not.toBe('Unknown product');
      expect(product.name).toEqual(expect.any(String));
      expect(product.name.length).toBeGreaterThan(0);
    }
  });

  it('returns an empty list, not an error, for a supplier with no bookings', async () => {
    const res = await get(emptyOwner);

    expect(res.status).toBe(200);
    expect(res.body.data.products).toEqual([]);
  });
});
