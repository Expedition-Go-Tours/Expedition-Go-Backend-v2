/**
 * Cancellation Requests — HTTP-layer contract, against a REAL database.
 *
 * The approval gate's whole point is who may do what:
 *   - queue visibility needs `bookings.view`
 *   - deciding needs `cancellations.approve`
 *   - suppliers only ever see/withdraw their OWN requests
 *
 * This suite previously mocked `prismaClient`. That verified the guard logic
 * but left two things asserted only against ourselves:
 *
 *   1. Response shape. The queue test did
 *      `toMatchObject({ supplier: {...}, booking: {...}, tour: {...} })` against
 *      a fixture row the test itself authored. `serializeCancellationRequest`
 *      hoists `booking.tour` to a top-level `tour` and joins `supplier` from a
 *      SEPARATE `user.findMany` — if either read stopped producing what the
 *      handler expects, the fixture would still satisfy the assertion while the
 *      real UI received `undefined`.
 *
 *   2. Filtering. `mockResolvedValue([row])` ignores `where` entirely, so
 *      "the supplier sees only their own requests" proved that a filter was
 *      BUILT, never that it FILTERS. Here two requests exist — one owned by the
 *      supplier under test, one by somebody else — and the assertion is on what
 *      comes back.
 *
 * The permission matrix is still checked per-role, but now through the real
 * `AdminRole` → `AdminRolePermission` → `AdminPermission` wiring rather than a
 * stubbed `adminRole.findUnique`.
 *
 * `cacheHelper` stays a pass-through (getOrSet → fn()) so every read reaches
 * the database instead of a shared Redis holding a 30–60s entry from a previous
 * run; it is a cache, not the data under test.
 *
 * Fixtures are created in `beforeAll` and removed in `afterAll`, keyed on a
 * `CRTEST` booking-number prefix so a crashed run cannot leave counts behind.
 * Runs against the isolated `travio_test` (gated on TEST_DB_AVAILABLE).
 */

const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
  notifyDiscord: jest.fn(),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

/** Everything this suite creates is tagged so cleanup and counts are exact. */
const PREFIX = 'CRTEST-';
const SUPPLIER_EMAIL = 'rxsieon@gmail.com'; // provisioned by prisma/seed.js
const CUSTOMER_EMAIL = 'cr-customer@test.invalid';
const OTHER_EMAIL = 'cr-other-supplier@test.invalid';
const ROLE_FULL = 'test_cancellations_full';
const ROLE_VIEW = 'test_cancellations_view';
const ROLE_OTHER = 'test_cancellations_other';
const ADMIN_FULL = 'cr-admin-full@test.invalid';
const ADMIN_VIEW = 'cr-admin-view@test.invalid';
const ADMIN_OTHER = 'cr-admin-other@test.invalid';

let supplier;
let tour;
let customer;
let otherUser;
let ownBooking;
let otherBooking;
let ownRequest;
let otherRequest;
const roleIds = [];

// Tokens are minted in beforeAll, once the real user ids exist.
let supplierToken;
let fullToken;
let viewToken;
let otherToken;

/** Create (or reuse) an admin role holding exactly `keys`. */
async function upsertRole(name, keys) {
  const role = await prisma.adminRole.upsert({
    where: { name },
    update: { description: 'cancellationRequests suite' },
    create: { name, description: 'cancellationRequests suite', isSystem: false },
  });
  const perms = await prisma.adminPermission.findMany({ where: { key: { in: keys } } });
  if (perms.length !== keys.length) {
    throw new Error(`seed is missing permissions: expected ${keys.length}, found ${perms.length}`);
  }
  await prisma.adminRolePermission.deleteMany({ where: { roleId: role.id } });
  await prisma.adminRolePermission.createMany({
    data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  roleIds.push(role.id);
  return role;
}

async function upsertAdmin(email, roleId) {
  const user = await prisma.user.upsert({
    where: { email },
    update: { active: true, roles: ['admin'], adminRoleId: roleId },
    create: {
      firebaseUid: `test-${email}`,
      name: `CR Admin ${email}`,
      email,
      roles: ['admin'],
      active: true,
      adminRoleId: roleId,
      photoURL: '',
    },
  });
  return user;
}

async function createBooking(bookingNumber) {
  return prisma.booking.create({
    data: {
      bookingNumber,
      customerId: customer.id,
      tourId: tour.id,
      status: 'CONFIRMED',
      paymentStatus: 'SUCCEEDED',
      currency: 'USD',
      travelers: { adults: 2, children: 0, infants: 0 },
      travelDate: new Date('2026-12-01T09:00:00.000Z'),
      selectedTime: '09:00',
      subtotal: 100,
      grossAmount: 100,
      commissionRate: 0.10,
      platformCommission: 10,
      supplierPayout: 90,
    },
  });
}

async function createRequest(bookingId, supplierId) {
  return prisma.cancellationRequest.create({
    data: {
      bookingId,
      supplierId,
      status: 'PENDING_APPROVAL',
      payload: { cancellationCode: 'GUIDE_UNAVAILABLE', cancellationCategory: 'OPERATIONAL' },
      preview: { refund: { amount: 100 }, fee: 25, countsTowardRate: true },
    },
  });
}

describeDb('Cancellation Requests (real DB)', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    await prisma.$connect();

    // Remove residue from a previous run first, so counts below are exact.
    await prisma.cancellationRequest.deleteMany({
      where: { booking: { bookingNumber: { startsWith: PREFIX } } },
    });
    await prisma.booking.deleteMany({ where: { bookingNumber: { startsWith: PREFIX } } });

    supplier = await prisma.user.findUnique({ where: { email: SUPPLIER_EMAIL } });
    if (!supplier) throw new Error(`seeded supplier ${SUPPLIER_EMAIL} missing — run npm run test:db:up`);

    tour = await prisma.tour.findFirst({
      where: { supplierId: supplier.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (!tour) throw new Error('seeded ACTIVE tour missing — run npm run test:db:up');

    customer = await prisma.user.upsert({
      where: { email: CUSTOMER_EMAIL },
      update: { active: true },
      create: {
        firebaseUid: `test-${CUSTOMER_EMAIL}`,
        name: 'CR Customer',
        email: CUSTOMER_EMAIL,
        roles: ['customer'],
        active: true,
        photoURL: '',
      },
    });

    // Stands in as another supplier's request. It never needs a profile: the
    // point is that OUR supplier must not see it.
    otherUser = await prisma.user.upsert({
      where: { email: OTHER_EMAIL },
      update: { active: true },
      create: {
        firebaseUid: `test-${OTHER_EMAIL}`,
        name: 'CR Other Supplier',
        email: OTHER_EMAIL,
        roles: ['supplier'],
        active: true,
        photoURL: '',
      },
    });

    const roleFull = await upsertRole(ROLE_FULL, ['bookings.view', 'cancellations.approve', 'dashboard.*']);
    const roleView = await upsertRole(ROLE_VIEW, ['bookings.view']);
    const roleOther = await upsertRole(ROLE_OTHER, ['reviews.view']);

    const adminFull = await upsertAdmin(ADMIN_FULL, roleFull.id);
    const adminView = await upsertAdmin(ADMIN_VIEW, roleView.id);
    const adminOther = await upsertAdmin(ADMIN_OTHER, roleOther.id);

    ownBooking = await createBooking(`${PREFIX}BK-1`);
    otherBooking = await createBooking(`${PREFIX}BK-2`);
    ownRequest = await createRequest(ownBooking.id, supplier.id);
    otherRequest = await createRequest(otherBooking.id, otherUser.id);

    supplierToken = signAccessToken({ userId: supplier.id });
    fullToken = signAccessToken({ userId: adminFull.id });
    viewToken = signAccessToken({ userId: adminView.id });
    otherToken = signAccessToken({ userId: adminOther.id });
  });

  afterAll(async () => {
    // Children first: request → booking → users → roles.
    await prisma.cancellationRequest.deleteMany({
      where: { booking: { bookingNumber: { startsWith: PREFIX } } },
    }).catch(() => {});
    await prisma.booking.deleteMany({ where: { bookingNumber: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.user.deleteMany({
      where: { email: { in: [CUSTOMER_EMAIL, OTHER_EMAIL, ADMIN_FULL, ADMIN_VIEW, ADMIN_OTHER] } },
    }).catch(() => {});
    if (roleIds.length) {
      await prisma.adminRolePermission.deleteMany({ where: { roleId: { in: roleIds } } }).catch(() => {});
      await prisma.adminRole.deleteMany({ where: { id: { in: roleIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  // ── Admin queue: authz ─────────────────────────────────────────────────
  describe('GET /api/admin/cancellation-requests', () => {
    it('401s without a token', async () => {
      await request(app).get('/api/admin/cancellation-requests').expect(401);
    });

    it('403s for a supplier (admin-only surface)', async () => {
      await request(app)
        .get('/api/admin/cancellation-requests')
        .set('Authorization', `Bearer ${supplierToken}`)
        .expect(403);
    });

    it('403s for an admin without bookings.view', async () => {
      // The role really holds only `reviews.view` — this proves the grant is
      // read through AdminRolePermission, not a stub.
      await request(app)
        .get('/api/admin/cancellation-requests')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);
    });

    it('returns the queue with both requests and a real joined shape', async () => {
      const res = await request(app)
        .get('/api/admin/cancellation-requests?status=PENDING_APPROVAL')
        .set('Authorization', `Bearer ${fullToken}`)
        .expect(200);

      expect(res.body.status).toBe('success');
      const { requests } = res.body.data;

      const ids = requests.map((r) => r.id);
      expect(ids).toContain(ownRequest.id);
      expect(ids).toContain(otherRequest.id);

      const own = requests.find((r) => r.id === ownRequest.id);
      expect(own).toMatchObject({
        id: ownRequest.id,
        status: 'PENDING_APPROVAL',
        payload: { cancellationCode: 'GUIDE_UNAVAILABLE' },
      });

      // `supplier` is joined from a SECOND query on supplierId, not the include.
      expect(own.supplier).toMatchObject({ id: supplier.id, name: expect.any(String) });

      // `booking` and its nested customer come from the relation include.
      expect(own.booking).toMatchObject({
        bookingNumber: ownBooking.bookingNumber,
        status: 'CONFIRMED',
        customer: { id: customer.id, email: CUSTOMER_EMAIL },
      });

      // `tour` is hoisted from `booking.tour`, and carries tour.supplier.
      expect(own.tour).toMatchObject({
        id: tour.id,
        title: tour.title,
        supplier: { id: supplier.id },
      });

      expect(res.body.data.pendingCount).toBeGreaterThanOrEqual(2);
      expect(res.body.data.pagination).toMatchObject({
        currentPage: 1,
        limit: expect.any(Number),
        totalCount: expect.any(Number),
      });
    });
  });

  // ── Decisions: the permission that actually matters ────────────────────
  describe('decision endpoints', () => {
    it('403s approve for an admin who can only view bookings', async () => {
      await request(app)
        .post(`/api/admin/cancellation-requests/${ownRequest.id}/approve`)
        .set('Authorization', `Bearer ${viewToken}`)
        .send({})
        .expect(403);

      // and wrote nothing while doing so
      const still = await prisma.cancellationRequest.findUnique({ where: { id: ownRequest.id } });
      expect(still.status).toBe('PENDING_APPROVAL');
    });

    it('404s approving an unknown request', async () => {
      await request(app)
        .post('/api/admin/cancellation-requests/nope/approve')
        .set('Authorization', `Bearer ${fullToken}`)
        .send({})
        .expect(404)
        .then((res) => expect(res.body.message).toMatch(/not found/i));
    });

    it('400s rejecting without a reason (and writes nothing)', async () => {
      const res = await request(app)
        .post(`/api/admin/cancellation-requests/${ownRequest.id}/reject`)
        .set('Authorization', `Bearer ${fullToken}`)
        .send({})
        .expect(400);

      expect(res.body.message).toMatch(/reason is required/i);

      const still = await prisma.cancellationRequest.findUnique({ where: { id: ownRequest.id } });
      expect(still.status).toBe('PENDING_APPROVAL');
      expect(still.decidedAt).toBeNull();
      expect(still.decisionNote).toBeNull();
    });

    it('400s a batch-approve with no ids', async () => {
      await request(app)
        .post('/api/admin/cancellation-requests/batch-approve')
        .set('Authorization', `Bearer ${fullToken}`)
        .send({ ids: [] })
        .expect(400);
    });

    it('403s batch-approve without cancellations.approve', async () => {
      await request(app)
        .post('/api/admin/cancellation-requests/batch-approve')
        .set('Authorization', `Bearer ${viewToken}`)
        .send({ ids: [ownRequest.id] })
        .expect(403);

      const still = await prisma.cancellationRequest.findUnique({ where: { id: ownRequest.id } });
      expect(still.status).toBe('PENDING_APPROVAL');
    });
  });

  // ── Supplier side: own requests only ───────────────────────────────────
  describe('supplier cancellation-request routes', () => {
    it('401s without a token', async () => {
      await request(app).get('/api/bookings/supplier/cancellation-requests').expect(401);
    });

    it('lists the supplier’s own requests and none of anyone else’s', async () => {
      const res = await request(app)
        .get('/api/bookings/supplier/cancellation-requests')
        .set('Authorization', `Bearer ${supplierToken}`)
        .expect(200);

      const ids = res.body.data.requests.map((r) => r.id);

      expect(ids).toContain(ownRequest.id);
      // This is the assertion a mock could not make: `otherRequest` exists in
      // the same table with the same status, and must be filtered out.
      expect(ids).not.toContain(otherRequest.id);
      expect(res.body.data.pagination.totalCount).toBeGreaterThanOrEqual(1);
    });

    it('404s withdrawing someone else’s request', async () => {
      await request(app)
        .post(`/api/bookings/supplier/cancellation-requests/${otherRequest.id}/withdraw`)
        .set('Authorization', `Bearer ${supplierToken}`)
        .send({})
        .expect(404);

      const untouched = await prisma.cancellationRequest.findUnique({ where: { id: otherRequest.id } });
      expect(untouched.status).toBe('PENDING_APPROVAL');
    });

    it('withdraws an open request (scoped to the supplier)', async () => {
      const res = await request(app)
        .post(`/api/bookings/supplier/cancellation-requests/${ownRequest.id}/withdraw`)
        .set('Authorization', `Bearer ${supplierToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.request.status).toBe('WITHDRAWN');

      const inDb = await prisma.cancellationRequest.findUnique({ where: { id: ownRequest.id } });
      expect(inDb.status).toBe('WITHDRAWN');
    });
  });
});
