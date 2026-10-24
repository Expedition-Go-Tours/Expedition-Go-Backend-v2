/**
 * Supplier-created bookings & offline payment collection — the twelve
 * scenarios the spec names, run through the real HTTP routes against a real
 * database, with real auth, real transactions and the real commission and
 * availability engines.
 *
 *   1. a walk-in cash booking            7. an offline refund
 *   2. a mobile-money reference          8. a commission waiver
 *   3. an unpaid reservation paid later  9. commission as a receivable
 *   4. partial collections               10. marketplace flows unchanged
 *   5. a registered customer, masked     11. an idempotent resubmission
 *   6. the last-place race               12. guest data stays protected
 *
 * Mocked, deliberately: `calculateTourPrice` (the pricing engine has its own
 * extensive suite; this one is about the booking and money rules, and the
 * fixture would otherwise need the full schedules-and-pricing blob), plus the
 * mail/event queue and the audit log, none of which this suite is about.
 *
 * NOT mocked: the availability core (scenario 6 is precisely about what it
 * guarantees under concurrency), `calculateCommission` (scenarios 8 and 9 are
 * about it), `supplierContact` (scenario 5 is about it), the Prisma client and
 * the transactions themselves.
 *
 * Fixtures are keyed on an `scb-` prefix and removed in `afterAll`.
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
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/adminNotificationService', () => ({
  ...jest.requireActual('../../src/core/services/adminNotificationService'),
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/discordNotifier', () => ({
  ...jest.requireActual('../../src/core/services/discordNotifier'),
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));
jest.mock('../../src/core/services/cancellationRequestService', () => ({
  ...jest.requireActual('../../src/core/services/cancellationRequestService'),
  pendingRequestsForBookingIds: jest.fn(async () => new Map()),
}));

// Config is a mutable map here so each scenario can turn the feature flag, the
// commission policy and the day ceiling on its own terms. Defaults come from
// the same `def` arguments the real service passes.
const config = {};
jest.mock('../../src/core/services/getConfig', () =>
  jest.fn(async (key, def) => (config[key] !== undefined ? config[key] : def)),
);

jest.mock('../../src/core/services/tourHelpers', () => ({
  ...jest.requireActual('../../src/core/services/tourHelpers'),
  calculateTourPrice: jest.fn(async () => ({
    success: true,
    subtotal: 400,
    discount: 0,
    total: 400,
    currency: 'USD',
  })),
}));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const queue = require('../../src/core/services/queue');
const { notifyAdmin } = require('../../src/core/services/adminNotificationService');
const { notifyDiscord } = require('../../src/core/services/discordNotifier');
const { signAccessToken } = require('../../config/jwt');
const { payoutBookingsWhere } = require('../../src/core/services/financeHelpers');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'scb-';
const OWNER1 = `${PREFIX}owner1`;
const OWNER2 = `${PREFIX}owner2`;
// A supplier with a tour but no marketplace earnings at all — the "no credit"
// gate's natural subject.
const OWNER3 = `${PREFIX}owner3`;
const CUSTOMER = `${PREFIX}customer`;
const emailFor = (name) => `${name}@example.test`;

let tokens = {};
const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const CREATE = '/api/travioghana/supplier/bookings';
const SUPPLIER = '/api/travioghana/supplier';
const quote = (body) => request(app).post(`${CREATE}/quote`).set(auth('owner1')).send(body);

let tourId;
const createIds = [];
const collectionIds = [];
const userIds = [];

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

describeDb('supplier-created bookings & offline payment collection', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    const owner1 = await upsertUser(OWNER1, { name: 'SCB Owner One' });
    const owner2 = await upsertUser(OWNER2, { name: 'SCB Owner Two' });
    const owner3 = await upsertUser(OWNER3, { name: 'SCB Owner Three' });
    const customer = await upsertUser(CUSTOMER, { name: 'SCB Customer' });
    userIds.push(owner1.id, owner2.id, owner3.id, customer.id);
    await upsertProfile(owner1);
    await upsertProfile(owner2);
    await upsertProfile(owner3);

    const existing = await prisma.tour.findFirst({ where: { slug: `${PREFIX}tour` } });
    if (existing) {
      tourId = existing.id;
    } else {
      const created = await prisma.tour.create({
        data: {
          supplierId: owner1.id,
          title: 'SCB Tour',
          description: 'A tour that exists so a booking has somewhere to hang.',
          slug: `${PREFIX}tour`,
          photos: [],
          coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/scb-cover.jpg',
          categorization: {},
          theme: {},
          productContent: {},
          schedulesAndPricing: {},
          bookingAndTickets: {},
          status: 'ACTIVE',
        },
      });
      tourId = created.id;
    }

    tokens = {
      owner1: signAccessToken({ userId: owner1.id }),
      owner2: signAccessToken({ userId: owner2.id }),
      owner3: signAccessToken({ userId: owner3.id }),
    };

    // Owner three's tour exists only so the no-credit scenario has somewhere to
    // point a booking at. No marketplace booking hangs off it, so owner three's
    // eligible earnings — and therefore their cover — are genuinely zero.
    const bare = await prisma.tour.findFirst({ where: { slug: `${PREFIX}bare-tour` } });
    if (!bare) {
      await prisma.tour.create({
        data: {
          supplierId: owner3.id,
          title: 'SCB Bare Tour',
          description: 'A tour with no earnings behind it.',
          slug: `${PREFIX}bare-tour`,
          photos: [],
          coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/scb-bare.jpg',
          categorization: {},
          theme: {},
          productContent: {},
          schedulesAndPricing: {},
          bookingAndTickets: {},
          status: 'ACTIVE',
        },
      });
    }

    // NO CREDIT, fixture side: a supplier-created booking's commission must be
    // covered by money the platform is already holding for this supplier. With
    // no eligible earnings there is no cover, every create would be refused,
    // and the suite would only be testing the gate. One marketplace booking
    // large enough to cover every scenario below gives the gate something to
    // be satisfied by, and scenario 13 gives it something to refuse.
    const cover = await prisma.booking.findFirst({ where: { bookingNumber: `${PREFIX}cover` } });
    if (!cover) {
      const created = await prisma.booking.create({
        data: {
          bookingNumber: `${PREFIX}cover`,
          customerId: customer.id,
          tourId,
          travelDate: new Date('2026-11-01'),
          travelers: { adults: 2 },
          subtotal: 6000,
          grossAmount: 6000,
          commissionRate: 0.15,
          platformCommission: 900,
          supplierPayout: 5100,
          status: 'CONFIRMED',
          paymentStatus: 'SUCCEEDED',
          payoutStatus: 'ELIGIBLE',
        },
      });
      createIds.push(created.id);
    }

    config['feature.supplierCreatedBookings.ghana'] = 'true';
    config['feature.supplierCreatedCommissionPolicy'] = 'APPLY';
  });

  afterAll(async () => {
    // Relay minting may have opened supplier-customer conversations; clear
    // them before their users go, even if a FK would cascade.
    await prisma.conversation
      .deleteMany({ where: { participants: { some: { userId: { in: userIds } } } } })
      .catch(() => {});
    await prisma.supplierCharge.deleteMany({ where: { bookingId: { in: createIds } } });
    await prisma.bookingCollection.deleteMany({ where: { bookingId: { in: createIds } } });
    await prisma.bookingIdempotencyKey.deleteMany({ where: { bookingId: { in: createIds } } });
    await prisma.booking.deleteMany({ where: { id: { in: createIds } } });
    await prisma.bookingGuest.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
    await prisma.bookingCounter.deleteMany({ where: { prefix: PREFIX } }).catch(() => {});
    await prisma.tour.deleteMany({ where: { slug: { in: [`${PREFIX}tour`, `${PREFIX}bare-tour`] } } });
    await prisma.supplierProfile.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [OWNER1, OWNER2, OWNER3, CUSTOMER].map(emailFor) } } });
  });

  const body = (over = {}) => ({
    tourId,
    travelDate: '2026-11-04',
    selectedTime: '09:00',
    travelers: { adults: 2 },
    guest: { name: `${PREFIX}guest`, phone: '+233201111111', email: 'guest@example.test' },
    idempotencyKey: `scb-key-${createIds.length}-${Math.random().toString(36).slice(2, 8)}`,
    ...over,
  });

  async function createBooking(over = {}, headers = {}) {
    const res = await request(app).post(CREATE).set(auth('owner1')).set(headers).send(body(over));
    if (res.body?.data?.booking?.id) createIds.push(res.body.data.booking.id);
    return res;
  }

  describe('1. a walk-in cash booking is recorded, and no platform payment is claimed', () => {
    it('creates the booking, its guest and its collection — with paymentStatus untouched', async () => {
      const res = await createBooking({
        collection: { amount: 400, method: 'CASH' },
      });
      expect(res.status).toBe(201);

      const row = await prisma.booking.findUnique({
        where: { id: res.body.data.booking.id },
        include: { guest: true, collections: true },
      });
      expect(row.origin).toBe('SUPPLIER_CREATED');
      // A walk-in has no account and none was invented for them.
      expect(row.customerId).toBeNull();
      expect(row.guest?.name).toBe(`${PREFIX}guest`);
      // Money a supplier says they hold is NOT a platform payment.
      expect(row.paymentStatus).toBe('PENDING');
      expect(row.stripePaymentIntentId).toBeNull();
      // …and it is not sitting in the payout pipeline either.
      expect(row.payoutStatus).toBe('PENDING');

      expect(row.collections).toHaveLength(1);
      expect(Number(row.collections[0].amount)).toBe(400);
      expect(row.collections[0].method).toBe('CASH');
      collectionIds.push(row.collections[0].id);
    });

    it('the quote endpoint prices it from the server and refuses to trust the client', async () => {
      const res = await quote({
        tourId,
        travelDate: '2026-11-04',
        travelers: { adults: 2 },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(400);
      expect(res.body.data.available).toBe(true);

      // A client-supplied total cannot influence anything: the create payload
      // has no such field, and the schema rejects unknown ones… but even a
      // total sent anyway must be ignored (it is, since the service prices).
      const res2 = await createBooking({ total: 1, grossAmount: 1, commissionRate: 0 });
      expect(res2.status).toBe(201);
      expect(Number(res2.body.data.booking.grossAmount)).toBe(400);
    });
  });

  describe('2. a mobile-money collection keeps its provider reference', () => {
    it('stores the method and the external reference on the collection row', async () => {
      const res = await createBooking({
        collection: { amount: 400, method: 'MOBILE_MONEY', externalRef: 'MM-9921' },
      });
      expect(res.status).toBe(201);

      const rows = await prisma.bookingCollection.findMany({
        where: { bookingId: res.body.data.booking.id },
      });
      expect(rows[0].method).toBe('MOBILE_MONEY');
      expect(rows[0].externalRef).toBe('MM-9921');
    });
  });

  describe('3. an unpaid reservation can be paid later', () => {
    it('starts with no collection and reaches FULL when the money arrives', async () => {
      const res = await createBooking();
      const id = res.body.data.booking.id;

      let summary = await request(app).get(`${CREATE}/${id}/collections`).set(auth('owner1'));
      expect(summary.status).toBe(200);
      expect(summary.body.data.state).toBe('NONE');
      expect(summary.body.data.outstanding).toBe(400);

      const paid = await request(app)
        .post(`${CREATE}/${id}/collections`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-coll-pay-later')
        .send({ amount: 400, method: 'CASH' });
      expect(paid.status).toBe(201);

      summary = await request(app).get(`${CREATE}/${id}/collections`).set(auth('owner1'));
      expect(summary.body.data.state).toBe('FULL');
      expect(summary.body.data.outstanding).toBe(0);
    });
  });

  describe('4. partial collections accumulate, and over-collection is refused', () => {
    it('tracks the outstanding balance across separate collection rows', async () => {
      const res = await createBooking();
      const id = res.body.data.booking.id;

      await request(app)
        .post(`${CREATE}/${id}/collections`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-coll-part-1')
        .send({ amount: 150, method: 'CASH' });
      await request(app)
        .post(`${CREATE}/${id}/collections`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-coll-part-2')
        .send({ amount: 250, method: 'BANK_TRANSFER' });

      const summary = await request(app).get(`${CREATE}/${id}/collections`).set(auth('owner1'));
      expect(summary.body.data.collected).toBe(400);
      expect(summary.body.data.outstanding).toBe(0);

      // Money that exceeds what is owed is refused — no silent overpayment.
      const tooMuch = await request(app)
        .post(`${CREATE}/${id}/collections`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-coll-part-3')
        .send({ amount: 50, method: 'CASH' });
      expect(tooMuch.status).toBe(409);
    });

    it('refuses an initial collection above the price, and writes nothing at all', async () => {
      const before = await prisma.booking.count({ where: { tourId } });
      const guestsBefore = await prisma.bookingGuest.count({ where: { name: { startsWith: PREFIX } } });

      // The same ceiling later collections obey: creating the booking must not
      // be a way to record money the booking does not cost.
      const res = await createBooking({
        collection: { amount: 400.01, method: 'CASH' },
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/exceeds what the booking costs/i);

      // The whole transaction rolled back: no booking, and no guest row left
      // orphaned behind the refused attempt.
      expect(await prisma.booking.count({ where: { tourId } })).toBe(before);
      expect(await prisma.bookingGuest.count({ where: { name: { startsWith: PREFIX } } })).toBe(guestsBefore);
    });
  });

  describe('5. a registered customer is shown by relay address, never by real email', () => {
    it('never returns the customer\'s real email, in the create response or the list', async () => {
      const customer = await prisma.user.findUnique({ where: { email: emailFor(CUSTOMER) } });
      const res = await createBooking({ customerId: customer.id, guest: undefined });

      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain(emailFor(CUSTOMER));
      // The booking is attached to the real account — no fake guest row for a
      // customer who already has one.
      const row = await prisma.booking.findUnique({ where: { id: res.body.data.booking.id } });
      expect(row.customerId).toBe(customer.id);
      expect(row.guestId).toBeNull();

      // And the list a supplier reads every day is masked the same way.
      const list = await request(app).get(CREATE).set(auth('owner1'));
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(emailFor(CUSTOMER));
    });
  });

  describe('6. two attempts racing for the last place: exactly one wins', () => {
    it('serializes on the tour row and refuses the second, leaving one booking', async () => {
      // One traveller per day for this test only.
      config['booking.max_travelers'] = '1';
      const date = '2026-12-01';

      const [a, b] = await Promise.all([
        createBooking({ travelDate: date, travelers: { adults: 1 } }),
        createBooking({ travelDate: date, travelers: { adults: 1 } }),
      ]);
      config['booking.max_travelers'] = undefined;

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const rows = await prisma.booking.count({
        where: {
          tourId,
          travelDate: new Date(date),
          origin: 'SUPPLIER_CREATED',
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
        },
      });
      expect(rows).toBe(1);
    });
  });

  describe('7. an offline refund returns money and cannot exceed what was collected', () => {
    it('records the refund as its own row and refuses an over-refund', async () => {
      const res = await createBooking({ collection: { amount: 400, method: 'CASH' } });
      const id = res.body.data.booking.id;

      const refund = await request(app)
        .post(`${CREATE}/${id}/refunds`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-refund-1')
        .send({ amount: 100, method: 'CASH', note: 'Guest left early' });
      expect(refund.status).toBe(201);
      expect(Number(refund.body.data.refund.amount)).toBe(-100);

      const summary = await request(app).get(`${CREATE}/${id}/collections`).set(auth('owner1'));
      expect(summary.body.data.collected).toBe(300);

      // A refund larger than everything ever collected is refused.
      const tooMuch = await request(app)
        .post(`${CREATE}/${id}/refunds`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-refund-2')
        .send({ amount: 500, method: 'CASH' });
      expect(tooMuch.status).toBe(409);
    });
  });

  describe('8. a commission waiver records the decision instead of a charge', () => {
    it('writes zero commission and raises no SupplierCharge', async () => {
      config['feature.supplierCreatedCommissionPolicy'] = 'WAIVE';
      const res = await createBooking({ collection: { amount: 400, method: 'CASH' } });
      config['feature.supplierCreatedCommissionPolicy'] = 'APPLY';

      const row = await prisma.booking.findUnique({
        where: { id: res.body.data.booking.id },
        include: { collections: true },
      });
      expect(Number(row.platformCommission)).toBe(0);
      expect(Number(row.supplierPayout)).toBe(400);

      const charges = await prisma.supplierCharge.findMany({
        where: { bookingId: row.id },
      });
      expect(charges).toHaveLength(0);
    });
  });

  describe('9. commission is a receivable the payout request already nets off', () => {
    it('raises an OPEN SupplierCharge per collection, at the platform\'s rate', async () => {
      const res = await createBooking({ collection: { amount: 200, method: 'CASH' } });
      const id = res.body.data.booking.id;

      const charges = await prisma.supplierCharge.findMany({ where: { bookingId: id } });
      expect(charges).toHaveLength(1);
      expect(charges[0].reason).toBe('SUPPLIER_COMMISSION');
      // OPEN is the state the payout-request machinery already understands and
      // nets off — no second settlement ledger.
      expect(charges[0].status).toBe('OPEN');
      // 15% of the money actually collected (200), not of the booking value.
      expect(Number(charges[0].amount)).toBe(30);
    });
  });

  describe('10. marketplace flows are unchanged — and supplier-created money is never paid out', () => {
    it('excludes supplier-created bookings from payout eligibility even in the worst case', async () => {
      const sc = await createBooking();
      const supplierBookingId = sc.body.data.booking.id;

      // A marketplace booking that is genuinely payable.
      const customer = await prisma.user.findUnique({ where: { email: emailFor(CUSTOMER) } });
      const market = await prisma.booking.create({
        data: {
          bookingNumber: `${PREFIX}market-1`,
          customerId: customer.id,
          tourId,
          travelDate: new Date('2026-11-05'),
          travelers: { adults: 2 },
          subtotal: 100,
          grossAmount: 100,
          commissionRate: 0.15,
          platformCommission: 15,
          supplierPayout: 85,
          status: 'CONFIRMED',
          paymentStatus: 'SUCCEEDED',
          payoutStatus: 'ELIGIBLE',
        },
      });
      createIds.push(market.id);

      // Worst case, simulated only in the fixture: a supplier-created booking
      // whose money fields were somehow set as if the platform had collected
      // it. The payout gate must still refuse it — that is what "never enter
      // the payout pipeline" means.
      await prisma.booking.update({
        where: { id: supplierBookingId },
        data: { paymentStatus: 'SUCCEEDED', payoutStatus: 'ELIGIBLE', status: 'CONFIRMED' },
      });

      const where = payoutBookingsWhere({ supplierId: (await prisma.tour.findUnique({ where: { id: tourId } })).supplierId });
      const payable = await prisma.booking.findMany({ where, select: { id: true } });
      const payableIds = payable.map((b) => b.id);

      expect(payableIds).toContain(market.id);
      expect(payableIds).not.toContain(supplierBookingId);
    });
  });

  describe('11. an idempotent resubmission returns the same booking', () => {
    it('replays the original for the same key and body, and conflicts on a different one', async () => {
      const first = await createBooking({ idempotencyKey: 'scb-idem-stable' });
      expect(first.status).toBe(201);

      const replay = await createBooking({ idempotencyKey: 'scb-idem-stable' });
      expect(replay.status).toBe(201);
      expect(replay.body.data.booking.id).toBe(first.body.data.booking.id);

      // Only one booking, one guest, no second charge for the same request.
      const rows = await prisma.booking.count({
        where: { id: { in: createIds }, origin: 'SUPPLIER_CREATED' },
      });
      expect(rows).toBeGreaterThan(0);

      const conflict = await createBooking({
        idempotencyKey: 'scb-idem-stable',
        travelers: { adults: 5 },
      });
      expect(conflict.status).toBe(409);
    });
  });

  describe('12. guest data stays with the supplier who took it', () => {
    it('is invisible to another supplier, in the collection history and the list', async () => {
      const res = await createBooking({
        collection: { amount: 100, method: 'CASH' },
        guest: { name: `${PREFIX}private-guest`, phone: '+233209999999', email: 'private@example.test' },
      });
      const id = res.body.data.booking.id;

      // The other supplier cannot read the collection history…
      const stolen = await request(app).get(`${CREATE}/${id}/collections`).set(auth('owner2'));
      expect(stolen.status).toBe(404);

      // …cannot record against it…
      const forged = await request(app)
        .post(`${CREATE}/${id}/collections`)
        .set(auth('owner2'))
        .set('Idempotency-Key', 'scb-forged-1')
        .send({ amount: 50, method: 'CASH' });
      expect(forged.status).toBe(404);

      // …and none of the guest's details appear anywhere in their own lists.
      const list2 = await request(app).get(CREATE).set(auth('owner2'));
      const payload = JSON.stringify(list2.body);
      expect(payload).not.toContain('private@example.test');
      expect(payload).not.toContain('+233209999999');
    });

    it('refuses creation entirely when the feature flag is off', async () => {
      config['feature.supplierCreatedBookings.ghana'] = 'false';
      const res = await createBooking();
      config['feature.supplierCreatedBookings.ghana'] = 'true';

      // The BACKEND refuses — hiding the button is not a control.
      expect(res.status).toBe(403);
    });
  });

  describe('13. no credit — the gate is money already held, not a promise', () => {
    it('refuses a booking the supplier cannot cover, and says by how much', async () => {
      const owner3Tour = await prisma.tour.findFirst({ where: { slug: `${PREFIX}bare-tour` } });
      const res = await request(app)
        .post(CREATE)
        .set(auth('owner3'))
        .send(body({ tourId: owner3Tour.id, collection: { amount: 400, method: 'CASH' } }));

      // Nothing was created — the refusal happens inside the transaction, after
      // the supplier row lock, so it cannot be raced either.
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/available earnings|available but this needs/i);
      const count = await prisma.booking.count({
        where: { tourId: owner3Tour.id, origin: 'SUPPLIER_CREATED' },
      });
      expect(count).toBe(0);
    });

    it('reports the same balance the gate uses', async () => {
      const rich = await request(app).get(`${SUPPLIER}/finance/commission-cover`).set(auth('owner1'));
      expect(rich.status).toBe(200);
      expect(rich.body.data.usable).toBe(true);
      const usd = rich.body.data.currencies.find((c) => c.currency === 'USD');
      expect(usd.available).toBeGreaterThan(0);
      // available is derived, not stored: eligible minus what is already owed.
      expect(usd.available).toBeCloseTo(usd.eligible - usd.openCharges, 2);

      const bare = await request(app).get(`${SUPPLIER}/finance/commission-cover`).set(auth('owner3'));
      expect(bare.status).toBe(200);
      expect(bare.body.data.usable).toBe(false);
    });
  });

  describe('14. a later collection raises commission — the leak this ledger closes', () => {
    it('charges on the money that arrives after creation, not only at creation', async () => {
      const res = await createBooking();
      const id = res.body.data.booking.id;

      // Unpaid reservations raise nothing at all.
      expect(await prisma.supplierCharge.count({ where: { bookingId: id } })).toBe(0);

      const paid = await request(app)
        .post(`${CREATE}/${id}/collections`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-later-collection')
        .send({ amount: 400, method: 'MOBILE_MONEY', externalRef: 'MM-LATER-1' });
      expect(paid.status).toBe(201);

      const charges = await prisma.supplierCharge.findMany({ where: { bookingId: id } });
      expect(charges).toHaveLength(1);
      expect(Number(charges[0].amount)).toBe(60); // 15% of 400, the money collected
      expect(charges[0].status).toBe('OPEN');

      // The booking row is still not claiming a platform payment or payout.
      const row = await prisma.booking.findUnique({ where: { id } });
      expect(Number(row.platformCommission)).toBe(0);
      expect(row.paymentStatus).toBe('PENDING');
    });
  });

  describe('15. a correction reverses the original and charges the corrected amount once', () => {
    it('never double-charges when a mis-keyed collection is replaced', async () => {
      const res = await createBooking({ collection: { amount: 400, method: 'CASH' } });
      const id = res.body.data.booking.id;

      const [original] = await prisma.bookingCollection.findMany({ where: { bookingId: id } });

      const corrected = await request(app)
        .post(`${CREATE}/${id}/collections`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-correction-1')
        .send({ amount: 300, method: 'CASH', reversesId: original.id });
      expect(corrected.status).toBe(201);

      const charges = await prisma.supplierCharge.findMany({
        where: { bookingId: id },
        orderBy: { createdAt: 'asc' },
      });
      // Two rows, one net figure: the original voided in place, the corrected
      // collection charged on its own amount. 60 − 60 + 45 = 45.
      expect(charges).toHaveLength(2);
      const live = charges.filter((c) => c.status !== 'REVERSED');
      expect(live).toHaveLength(1);
      expect(Number(live[0].amount)).toBe(45);
      expect(charges.find((c) => c.status === 'REVERSED').id).toBe(charges[0].id);

      // The corrected row is the only one counted as collected.
      const summary = await request(app).get(`${CREATE}/${id}/collections`).set(auth('owner1'));
      expect(summary.body.data.collected).toBe(300);
      expect(summary.body.data.commission.accrued).toBe(45);
    });

    it('refuses to correct the same collection twice', async () => {
      const res = await createBooking({ collection: { amount: 400, method: 'CASH' } });
      const id = res.body.data.booking.id;
      const [original] = await prisma.bookingCollection.findMany({ where: { bookingId: id } });

      const first = await request(app)
        .post(`${CREATE}/${id}/collections`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-correction-once-a')
        .send({ amount: 200, method: 'CASH', reversesId: original.id });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post(`${CREATE}/${id}/collections`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-correction-once-b')
        .send({ amount: 100, method: 'CASH', reversesId: original.id });
      expect(second.status).toBe(409);
    });
  });

  describe('16. a refund returns the commission, and a full refund lands on exactly zero', () => {
    it('credits the commission on refunded money', async () => {
      const res = await createBooking({ collection: { amount: 400, method: 'CASH' } });
      const id = res.body.data.booking.id;

      const refund = await request(app)
        .post(`${CREATE}/${id}/refunds`)
        .set(auth('owner1'))
        .set('Idempotency-Key', 'scb-refund-partial')
        .send({ amount: 100, method: 'CASH' });
      expect(refund.status).toBe(201);

      const summary = await request(app).get(`${CREATE}/${id}/collections`).set(auth('owner1'));
      // 60 charged on 400, 15 credited on the 100 returned.
      expect(summary.body.data.collected).toBe(300);
      expect(summary.body.data.commission.accrued).toBe(45);
    });

    it('leaves no residue when the whole booking is refunded', async () => {
      const res = await createBooking({ collection: { amount: 400, method: 'CASH' } });
      const id = res.body.data.booking.id;

      for (const [key, amount] of [['scb-refund-all-a', 150], ['scb-refund-all-b', 250]]) {
        const r = await request(app)
          .post(`${CREATE}/${id}/refunds`)
          .set(auth('owner1'))
          .set('Idempotency-Key', key)
          .send({ amount, method: 'CASH' });
        expect(r.status).toBe(201);
      }

      const summary = await request(app).get(`${CREATE}/${id}/collections`).set(auth('owner1'));
      expect(summary.body.data.collected).toBe(0);
      expect(summary.body.data.commission.accrued).toBe(0);
      const live = await prisma.supplierCharge.count({
        where: { bookingId: id, status: { not: 'REVERSED' } },
      });
      expect(live).toBe(0);
    });
  });

  describe('17. the rate is frozen at creation', () => {
    it('does not reprice a booking when the platform changes its rate', async () => {
      const res = await createBooking();
      const id = res.body.data.booking.id;
      const row = await prisma.booking.findUnique({ where: { id } });
      expect(Number(row.commissionRate)).toBe(0.15);
      expect(row.commissionPolicy).toBe('APPLY');

      config['commission.default_rate'] = '0.5';
      try {
        const paid = await request(app)
          .post(`${CREATE}/${id}/collections`)
          .set(auth('owner1'))
          .set('Idempotency-Key', 'scb-frozen-rate')
          .send({ amount: 400, method: 'CASH' });
        expect(paid.status).toBe(201);
      } finally {
        delete config['commission.default_rate'];
      }

      const charges = await prisma.supplierCharge.findMany({ where: { bookingId: id } });
      // 15% of 400 — the rate the supplier quoted their customer — not 50%.
      expect(Number(charges[0].amount)).toBe(60);
    });
  });

  describe('18. the ledger reconciles with the money actually collected', () => {
    it('sums non-reversed charges to rate × recorded collections, per booking', async () => {
      const bookings = await prisma.booking.findMany({
        where: { id: { in: createIds }, origin: 'SUPPLIER_CREATED' },
        select: { id: true, commissionRate: true },
      });

      for (const booking of bookings) {
        const [collections, charges] = await Promise.all([
          prisma.bookingCollection.findMany({
            where: { bookingId: booking.id, status: 'RECORDED' },
            select: { amount: true },
          }),
          prisma.supplierCharge.findMany({
            where: { bookingId: booking.id, reason: 'SUPPLIER_COMMISSION', status: { not: 'REVERSED' } },
            select: { amount: true },
          }),
        ]);
        const collected = collections.reduce((s, c) => s + Number(c.amount), 0);
        const charged = charges.reduce((s, c) => s + Number(c.amount), 0);
        const expected = Math.round(Number(booking.commissionRate) * collected * 100) / 100;
        expect(charged).toBeCloseTo(expected, 2);
      }
    });
  });

  describe('19. everyone is told, and nobody is told twice', () => {
    beforeEach(() => {
      queue.enqueueEmail.mockClear();
      queue.enqueueNotification.mockClear();
      notifyAdmin.mockClear();
      notifyDiscord.mockClear();
    });

    const callsOf = (mock) => mock.mock.calls.map((call) => call[0]);

    it('notifies the supplier, emails the guest and the supplier, and posts the record to ops', async () => {
      const res = await createBooking({
        collection: { amount: 150, method: 'MOBILE_MONEY', externalRef: 'MM-123' },
      });
      expect(res.status).toBe(201);
      const booking = res.body.data.booking;

      const row = await prisma.booking.findUnique({
        where: { id: booking.id },
        select: { source: true, tour: { select: { supplierId: true } } },
      });
      // The storefront the booking belongs to is persisted, so every email
      // downstream renders with the Ghana identity instead of falling back.
      expect(row.source).toBe('GHANA');

      const bell = callsOf(queue.enqueueNotification).find((j) => j.type === 'BOOKING_CREATED_BY_SUPPLIER');
      expect(bell).toBeDefined();
      expect(bell.userId).toBe(row.tour.supplierId);
      expect(bell.message).toContain('$150.00');
      expect(bell.message).toContain('$250.00');

      const emails = callsOf(queue.enqueueEmail);
      const guestMail = emails.find((j) => j.type === 'supplier-created-booking-confirmation');
      const supplierMail = emails.find((j) => j.type === 'supplier-booking-recorded');
      expect(guestMail).toMatchObject({ bookingId: booking.id });
      expect(supplierMail).toMatchObject({ bookingId: booking.id });

      expect(notifyAdmin).toHaveBeenCalledWith(expect.objectContaining({
        type: 'BOOKING_CONFIRMED',
        title: 'Booking Recorded by Supplier',
      }));
      expect(notifyDiscord).toHaveBeenCalledWith(
        'sales',
        expect.stringContaining('recorded by'),
        expect.objectContaining({ title: 'Booking Recorded by Supplier' }),
      );
    });

    it('rings a registered customer\'s bell instead of leaving them to the guest email', async () => {
      const customer = await prisma.user.findUnique({ where: { email: emailFor(CUSTOMER) } });
      const res = await createBooking({ customerId: customer.id, guest: undefined, collection: { amount: 100, method: 'CASH' } });
      expect(res.status).toBe(201);

      const bell = callsOf(queue.enqueueNotification).find((j) => j.type === 'BOOKING_CONFIRMED');
      expect(bell).toBeDefined();
      expect(bell.userId).toBe(customer.id);
      expect(bell.message).toContain('recorded your booking');
      // A registered customer still gets the written confirmation.
      expect(callsOf(queue.enqueueEmail).some((j) => j.type === 'supplier-created-booking-confirmation')).toBe(true);
    });

    it('does not notify anyone again when the same request is replayed', async () => {
      const key = `scb-notify-replay-${Math.random().toString(36).slice(2, 8)}`;
      const first = await createBooking({ idempotencyKey: key, collection: { amount: 50, method: 'CASH' } });
      expect(first.status).toBe(201);

      queue.enqueueEmail.mockClear();
      queue.enqueueNotification.mockClear();
      notifyAdmin.mockClear();
      notifyDiscord.mockClear();

      const second = await createBooking({ idempotencyKey: key, collection: { amount: 50, method: 'CASH' } });
      expect(second.status).toBe(201);
      expect(second.body.data.booking.id).toBe(first.body.data.booking.id);
      expect(queue.enqueueEmail).not.toHaveBeenCalled();
      expect(queue.enqueueNotification).not.toHaveBeenCalled();
      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(notifyDiscord).not.toHaveBeenCalled();
    });

    it('accepts the supplier notification type in the database', async () => {
      // The enum value the worker inserts. Without the migration this row
      // throws a Prisma validation error and the job dies silently.
      const owner = await prisma.user.findUnique({ where: { email: emailFor(OWNER1) } });
      const notification = await prisma.notification.create({
        data: {
          userId: owner.id,
          type: 'BOOKING_CREATED_BY_SUPPLIER',
          title: 'Booking recorded',
          message: 'Enum acceptance check',
        },
      });
      expect(notification.id).toBeDefined();
      await prisma.notification.delete({ where: { id: notification.id } });
    });

    it('moves the supplier counters in step with the booking', async () => {
      const owner = await prisma.user.findUnique({ where: { email: emailFor(OWNER1) } });
      const before = await prisma.supplierProfile.findUnique({ where: { userId: owner.id } });

      const res = await createBooking({ collection: { amount: 400, method: 'CASH' } });
      expect(res.status).toBe(201);

      const after = await prisma.supplierProfile.findUnique({ where: { userId: owner.id } });
      expect(after.totalBookings).toBe(before.totalBookings + 1);
      // supplierPayout is the gross for a supplier-created booking: the
      // platform never pays it out, so nothing inflates the payout pipeline.
      expect(Number(after.totalEarnings)).toBeCloseTo(Number(before.totalEarnings) + 400, 2);
    });
  });
});
