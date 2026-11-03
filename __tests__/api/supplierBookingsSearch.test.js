/**
 * Free-text search on the supplier bookings list — against a REAL database.
 *
 * The supplier types a name, and the name on the card is the LEAD TRAVELLER
 * (`BookingCard` renders `leadTravelerName`, with "Booked by …" underneath).
 * The filter used to match only the account, the reference and the tour, so:
 *
 *   - "Priscilla" missed TRG-86629225, booked by Wayne Gibson for Priscilla
 *     Hankins — the traveller was visible and unsearchable;
 *   - accountless rows (guest checkouts, supplier-created reservations) were
 *     findable by reference alone, because `customer` is null for them.
 *
 * A mocked `where` cannot prove this: every row is a real booking here, so the
 * assertions are about WHICH ids come back, that another business's rows never
 * do, and that the CSV export agrees with the screen it is exported from.
 *
 * Fixtures are keyed on a `sbs-` prefix and removed in `afterAll`.
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

jest.mock('../../src/core/services/cancellationRequestService', () => ({
  ...jest.requireActual('../../src/core/services/cancellationRequestService'),
  pendingRequestsForBookingIds: jest.fn(async () => new Map()),
}));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const { signAccessToken } = require('../../config/jwt');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'sbs-';
const LIST = '/api/travioghana/supplier/bookings';
const EXPORT = `${LIST}/export`;
const emailFor = (name) => `${PREFIX}${name}@example.test`;

let owner;
let otherOwner;
let token;
let accountBookingId;
let guestBookingId;
let controlBookingId;
let otherBusinessBookingId;

const idsIn = (res) => res.body.data.bookings.map((b) => b.id);

async function upsertUser(name, data) {
  return prisma.user.upsert({
    where: { email: emailFor(name) },
    update: data,
    create: { firebaseUid: `test-${name}`, email: emailFor(name), photoURL: '', active: true, ...data },
  });
}

async function upsertProfile(user) {
  const empty = {};
  return prisma.supplierProfile.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
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

async function upsertTour(supplierId, key) {
  const slug = `${PREFIX}${key}`;
  const existing = await prisma.tour.findFirst({ where: { slug } });
  if (existing) return existing.id;

  const created = await prisma.tour.create({
    data: {
      supplierId,
      title: `SBS ${key}`,
      description: 'A tour that exists so a booking has somewhere to hang.',
      slug,
      photos: [],
      coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/sbs-cover.jpg',
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

async function upsertBooking(key, data) {
  const bookingNumber = `${PREFIX}${key}`;
  const existing = await prisma.booking.findFirst({ where: { bookingNumber } });
  if (existing) return existing.id;

  const created = await prisma.booking.create({
    data: {
      bookingNumber,
      travelers: { adults: 1 },
      travelDate: new Date('2026-12-01T00:00:00.000Z'),
      subtotal: 100,
      grossAmount: 100,
      commissionRate: 0.15,
      platformCommission: 15,
      supplierPayout: 85,
      status: 'CONFIRMED',
      ...data,
    },
  });
  return created.id;
}

describeDb('supplier bookings search (real DB)', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    await prisma.$connect();

    owner = await upsertUser('owner', { name: 'SBS Owner', roles: ['supplier'] });
    otherOwner = await upsertUser('other', { name: 'SBS Other Owner', roles: ['supplier'] });
    await upsertProfile(owner);
    await upsertProfile(otherOwner);

    const customer = await upsertUser('customer', { name: 'Wayne Gibson', roles: ['customer'] });
    const control = await upsertUser('control', { name: 'Ama Mensah', roles: ['customer'] });

    const tourId = await upsertTour(owner.id, 'tour-one');
    const otherTourId = await upsertTour(otherOwner.id, 'tour-other');

    // Supplier-created reservation: no account, identity on the guest row.
    const existingGuest = await prisma.bookingGuest.findFirst({ where: { email: emailFor('guest') } });
    const guest = existingGuest
      || await prisma.bookingGuest.create({ data: { name: 'Thomas Rhodes', email: emailFor('guest'), phone: '+233200000001' } });

    accountBookingId = await upsertBooking('account', {
      customerId: customer.id,
      leadTravelerName: 'Priscilla Hankins',
      leadTravelerEmail: 'priscilla@example.test',
      tourId,
    });
    guestBookingId = await upsertBooking('guest', {
      customerId: null,
      guestId: guest.id,
      leadTravelerName: 'Thomas Rhodes',
      leadTravelerEmail: emailFor('guest'),
      tourId,
    });
    controlBookingId = await upsertBooking('control', {
      customerId: control.id,
      leadTravelerName: 'Ama Mensah',
      leadTravelerEmail: emailFor('control'),
      tourId,
    });
    // Same traveller name, different business: must never surface.
    otherBusinessBookingId = await upsertBooking('other', {
      customerId: null,
      leadTravelerName: 'Thomas Rhodes',
      leadTravelerEmail: emailFor('other-guest'),
      tourId: otherTourId,
    });

    token = signAccessToken({ userId: owner.id });
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { bookingNumber: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.bookingGuest.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.tour.deleteMany({ where: { slug: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.teamMember.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.supplierProfile.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.$disconnect();
  });

  const search = async (term) => {
    const res = await request(app)
      .get(LIST)
      .set({ Authorization: `Bearer ${token}` })
      .query({ search: term, limit: 50 });
    expect(res.status).toBe(200);
    return idsIn(res);
  };

  it('finds a booking by the LEAD TRAVELLER when the account holder differs', async () => {
    expect(await search('priscilla')).toEqual([accountBookingId]);
    expect(await search('hankins')).toEqual([accountBookingId]);
  });

  it('still finds the account holder of that same booking', async () => {
    expect(await search('gibson')).toEqual([accountBookingId]);
  });

  it('finds an accountless reservation by its traveller and guest identity', async () => {
    expect(await search('rhodes')).toEqual([guestBookingId]);
    expect(await search(PREFIX + 'guest@')).toEqual([guestBookingId]);
  });

  it('ANDs the words, in any order, across different fields', async () => {
    expect(await search('hankins priscilla')).toEqual([accountBookingId]);
    // Traveller in one word, account in the other — same booking, one row.
    expect(await search('priscilla gibson')).toEqual([accountBookingId]);
  });

  it('never surfaces another business’s bookings, even for a matching name', async () => {
    const ids = await search('rhodes');
    expect(ids).toContain(guestBookingId);
    expect(ids).not.toContain(otherBusinessBookingId);
    expect(ids).not.toContain(controlBookingId);
  });

  it('exports exactly the rows the screen shows for the same search', async () => {
    const res = await request(app)
      .get(EXPORT)
      .set({ Authorization: `Bearer ${token}` })
      .query({ search: 'priscilla' });

    expect(res.status).toBe(200);
    // text/csv → supertest keeps the raw body in `.text`.
    const csv = String(res.text || '');
    expect(csv).toContain(`${PREFIX}account`);
    expect(csv).not.toContain(`${PREFIX}control`);
    expect(csv).not.toContain(`${PREFIX}other`);
  });
});
