/**
 * Completed-trip refund claims — end to end through the real HTTP routes and a
 * real PostGIS database.
 *
 * This is the "did it actually work" test that the unit suites cannot be: the
 * request goes through auth, the claim is submitted, the supplier approves it,
 * and an admin releases it — all against real Prisma queries, real transactions
 * and the real invoice/payout detach code. Only the external money movement is
 * mocked (`refundBookingPayment`), because that is the one part a local run
 * must never do.
 *
 * Scenarios:
 *   1. ELIGIBLE  — claim freeze, no supplier debt, funds cancelled
 *   2. INVOICED  — booking leaves the unpaid invoice, no supplier debt
 *   3. REQUESTED — booking leaves the payout request, settled charge returns
 *                  to the open pool, no supplier debt
 *   4. PAID      — supplier is debited, payout document left intact
 *   5. PAID partial — proportional debit, booking stays payable
 *   6. duplicate claim is refused
 *
 * Fixtures are keyed on an `rcr-` prefix and removed in `afterAll`.
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
jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({
  ...jest.requireActual('../../src/core/services/adminNotificationService'),
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/discordNotifier', () => ({
  ...jest.requireActual('../../src/core/services/discordNotifier'),
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/ga4Measurement', () => ({
  sendRefund: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../../src/core/services/payments', () => ({
  ...jest.requireActual('../../src/core/services/payments'),
  refundBookingPayment: jest.fn(async () => ({ id: 're_test_1', status: 'succeeded' })),
}));
jest.mock('../../src/core/services/stripeHelpers', () => ({
  ...jest.requireActual('../../src/core/services/stripeHelpers'),
  // The replay lookup talks to Stripe. No prior refund exists in these runs.
  findExistingRefund: jest.fn(async () => null),
}));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const { refundBookingPayment } = require('../../src/core/services/payments');
const { signAccessToken } = require('../../config/jwt');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'rcr-';
const OWNER = `${PREFIX}owner`;
const ADMIN = `${PREFIX}admin`;
const emailFor = (name) => `${name}@example.test`;

const tokens = {};
const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

let ownerId;
let tourId;

const bookingIds = [];
const invoiceIds = [];
const requestIds = [];

let serial = 0;
const unique = (label) => {
  serial += 1;
  return `${PREFIX}${label}-${Date.now()}-${serial}`;
};

async function upsertUser(name, roles) {
  return prisma.user.upsert({
    where: { email: emailFor(name) },
    update: { roles, active: true },
    create: {
      firebaseUid: `test-${name}`,
      email: emailFor(name),
      name,
      roles,
      photoURL: '',
      active: true,
    },
  });
}

async function makeCustomer() {
  const user = await upsertUser(unique('customer'), ['customer']);
  return { user, token: signAccessToken({ userId: user.id }) };
}

async function makeBooking({ customerId, payoutStatus = 'ELIGIBLE', gross = 100, payout = 80 } = {}) {
  const booking = await prisma.booking.create({
    data: {
      bookingNumber: unique('booking'),
      customerId,
      tourId,
      travelDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      travelers: { adults: 2 },
      subtotal: gross,
      grossAmount: gross,
      commissionRate: 0.2,
      platformCommission: gross - payout,
      supplierPayout: payout,
      status: 'COMPLETED',
      paymentStatus: 'SUCCEEDED',
      payoutStatus,
      currency: 'USD',
      paymentProvider: 'STRIPE',
      stripePaymentIntentId: unique('pi_test'),
    },
  });
  bookingIds.push(booking.id);
  return booking;
}

async function makeInvoice(booking) {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: unique('INV'),
      supplierId: ownerId,
      cycle: 'TWICE_MONTHLY',
      cycleStartDate: new Date('2026-11-01'),
      cycleEndDate: new Date('2026-11-15'),
      cycleLabel: 'Nov 1–15',
      invoicedAt: new Date('2026-11-16'),
      paymentScheduledAt: new Date('2026-11-20'),
      status: 'INVOICED',
      grossTotal: booking.grossAmount,
      commissionTotal: booking.platformCommission,
      netTotal: booking.supplierPayout,
      currency: 'USD',
      bookingCount: 1,
      items: {
        create: {
          bookingId: booking.id,
          grossAmount: booking.grossAmount,
          platformCommission: booking.platformCommission,
          supplierPayout: booking.supplierPayout,
          currency: 'USD',
        },
      },
    },
  });
  invoiceIds.push(invoice.id);
  return invoice;
}

async function makePayoutRequest(booking) {
  const payoutRequest = await prisma.payoutRequest.create({
    data: {
      requestNumber: unique('PR'),
      supplierId: ownerId,
      amount: booking.supplierPayout,
      currency: 'USD',
      bookingCount: 1,
      status: 'PROCESSING',
      cycleStartDate: new Date('2026-11-01'),
      cycleEndDate: new Date('2026-11-15'),
      cycleLabel: 'Nov 1–15',
      items: {
        create: {
          bookingId: booking.id,
          grossAmount: booking.grossAmount,
          platformCommission: booking.platformCommission,
          supplierPayout: booking.supplierPayout,
          currency: 'USD',
        },
      },
    },
  });
  requestIds.push(payoutRequest.id);
  return payoutRequest;
}

const submitClaim = (booking, token, over = {}) =>
  request(app)
    .post(`/api/refund-claims/bookings/${booking.id}/claim`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'OTHER', type: 'FULL', ...over });

const supplierApprove = (claimId) =>
  request(app).patch(`/api/refund-claims/supplier/${claimId}/approve`).set(auth('owner'));

const adminRelease = (claimId, releasedAmount) =>
  request(app)
    .patch(`/api/refund-claims/admin/${claimId}/release`)
    .set(auth('admin'))
    .send({ releasedAmount });

async function approvedClaim(booking, token, over = {}) {
  const submitted = await submitClaim(booking, token, over);
  expect(submitted.status).toBe(201);
  const claimId = submitted.body.data.claim.id;

  const approved = await supplierApprove(claimId);
  expect(approved.status).toBe(200);
  expect(approved.body.data.claim.status).toBe('SUPPLIER_APPROVED');
  return claimId;
}

describeDb('refund claim release — real HTTP, real database', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    const owner = await upsertUser(OWNER, ['supplier']);
    const admin = await upsertUser(ADMIN, ['admin']);
    ownerId = owner.id;

    await prisma.supplierProfile.upsert({
      where: { userId: owner.id },
      update: {},
      create: {
        userId: owner.id,
        businessInfo: {},
        operatingInfo: {},
        representativeInfo: {},
        businessDocuments: {},
        payoutInfo: {},
        compliance: {},
        status: 'ACTIVE',
      },
    });

    const existing = await prisma.tour.findFirst({ where: { slug: `${PREFIX}tour` } });
    if (existing) {
      tourId = existing.id;
    } else {
      const tour = await prisma.tour.create({
        data: {
          supplierId: owner.id,
          title: 'RCR Tour',
          description: 'A tour that exists so a claim has something to hang from.',
          slug: `${PREFIX}tour`,
          photos: [],
          coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/rcr-cover.jpg',
          categorization: {},
          theme: {},
          productContent: {},
          schedulesAndPricing: {},
          bookingAndTickets: {},
          status: 'ACTIVE',
        },
      });
      tourId = tour.id;
    }

    tokens.owner = signAccessToken({ userId: owner.id });
    tokens.admin = signAccessToken({ userId: admin.id });
  });

  afterAll(async () => {
    await prisma.supplierCharge.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.refundClaim.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.invoiceItem.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.payoutRequestItem.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.payoutRequest.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma.tour.deleteMany({ where: { slug: `${PREFIX}tour` } });
    await prisma.supplierProfile.deleteMany({ where: { userId: ownerId } });
    await prisma.user.deleteMany({
      where: {
        OR: [
          { email: { in: [OWNER, ADMIN].map(emailFor) } },
          { email: { startsWith: `${PREFIX}customer` } },
        ],
      },
    });
  });

  beforeEach(() => {
    refundBookingPayment.mockClear();
  });

  it('ELIGIBLE: the claim freezes the payout and a full refund costs the supplier nothing', async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking({ customerId: customer.user.id, payoutStatus: 'ELIGIBLE' });

    const submitted = await submitClaim(booking, customer.token);
    expect(submitted.status).toBe(201);
    const claimId = submitted.body.data.claim.id;
    const frozen = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(frozen.payoutStatus).toBe('DISPUTED');

    const approved = await supplierApprove(claimId);
    expect(approved.status).toBe(200);
    expect(approved.body.data.claim.status).toBe('SUPPLIER_APPROVED');

    const released = await adminRelease(claimId, 100);
    expect(released.status).toBe(200);

    const [claim, after, charges] = await Promise.all([
      prisma.refundClaim.findUnique({ where: { id: claimId } }),
      prisma.booking.findUnique({ where: { id: booking.id } }),
      prisma.supplierCharge.findMany({ where: { bookingId: booking.id } }),
    ]);

    expect(claim.status).toBe('RELEASED');
    expect(Number(claim.releasedAmount)).toBe(100);
    expect(after.status).toBe('REFUNDED');
    expect(after.paymentStatus).toBe('REFUNDED');
    expect(after.payoutStatus).toBe('CANCELLED');
    expect(Number(after.refundAmount)).toBe(100);
    expect(charges).toHaveLength(0);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ id: booking.id }),
      10000,
      expect.objectContaining({ idempotencyKey: `refund_claim_${claimId}` }),
    );
  });

  it('INVOICED: the booking leaves the unpaid invoice and is not charged to the supplier', async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking({ customerId: customer.user.id, payoutStatus: 'INVOICED' });
    const invoice = await makeInvoice(booking);

    const claimId = await approvedClaim(booking, customer.token);
    const released = await adminRelease(claimId, 100);
    expect(released.status).toBe(200);

    const [invoiceAfter, items, charges, after] = await Promise.all([
      prisma.invoice.findUnique({ where: { id: invoice.id } }),
      prisma.invoiceItem.findMany({ where: { bookingId: booking.id } }),
      prisma.supplierCharge.findMany({ where: { bookingId: booking.id } }),
      prisma.booking.findUnique({ where: { id: booking.id } }),
    ]);

    expect(items).toHaveLength(0);
    // Removing the only line cancels the empty invoice.
    expect(invoiceAfter.status).toBe('CANCELLED');
    expect(Number(invoiceAfter.bookingCount)).toBe(0);
    expect(charges).toHaveLength(0);
    expect(after.status).toBe('REFUNDED');
    expect(after.payoutStatus).toBe('CANCELLED');
  });

  it('REQUESTED: the booking leaves the payout request and its settled charge is released', async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking({ customerId: customer.user.id, payoutStatus: 'REQUESTED' });
    const payoutRequest = await makePayoutRequest(booking);
    const settled = await prisma.supplierCharge.create({
      data: {
        supplierId: ownerId,
        bookingId: booking.id,
        amount: 5,
        currency: 'USD',
        reason: 'SUPPLIER_CANCELLATION_FEE',
        status: 'SETTLED',
        payoutRequestId: payoutRequest.id,
        settledAt: new Date(),
      },
    });

    const claimId = await approvedClaim(booking, customer.token);
    const released = await adminRelease(claimId, 100);
    expect(released.status).toBe(200);

    const [requestAfter, items, chargeAfter, claimCharges, after] = await Promise.all([
      prisma.payoutRequest.findUnique({ where: { id: payoutRequest.id } }),
      prisma.payoutRequestItem.findMany({ where: { bookingId: booking.id } }),
      prisma.supplierCharge.findUnique({ where: { id: settled.id } }),
      prisma.supplierCharge.findMany({
        where: { bookingId: booking.id, reason: 'CUSTOMER_REFUND_CLAIM' },
      }),
      prisma.booking.findUnique({ where: { id: booking.id } }),
    ]);

    expect(items).toHaveLength(0);
    expect(requestAfter.status).toBe('CANCELLED');
    // The request will never pay, so the charge must not vanish with it.
    expect(chargeAfter.status).toBe('OPEN');
    expect(chargeAfter.payoutRequestId).toBeNull();
    expect(claimCharges).toHaveLength(0);
    expect(after.payoutStatus).toBe('CANCELLED');
  });

  it('PAID: the supplier is debited and the paid document is left intact', async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking({ customerId: customer.user.id, payoutStatus: 'PAID' });

    const claimId = await approvedClaim(booking, customer.token);
    const released = await adminRelease(claimId, 100);
    expect(released.status).toBe(200);

    const [charges, after, claim] = await Promise.all([
      prisma.supplierCharge.findMany({ where: { bookingId: booking.id } }),
      prisma.booking.findUnique({ where: { id: booking.id } }),
      prisma.refundClaim.findUnique({ where: { id: claimId } }),
    ]);

    expect(charges).toHaveLength(1);
    expect(Number(charges[0].amount)).toBe(80);
    expect(charges[0].reason).toBe('CUSTOMER_REFUND_CLAIM');
    expect(charges[0].status).toBe('OPEN');
    expect(charges[0].supplierId).toBe(ownerId);
    // Paid money is history — it is recovered by the debit, not by erasing it.
    expect(after.payoutStatus).toBe('PAID');
    expect(after.status).toBe('REFUNDED');
    expect(claim.status).toBe('RELEASED');
  });

  it('PAID partial: proportional debit and the booking stays payable', async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking({ customerId: customer.user.id, payoutStatus: 'PAID' });

    const claimId = await approvedClaim(booking, customer.token, { type: 'PARTIAL', requestedAmount: 40 });
    const released = await adminRelease(claimId, 40);
    expect(released.status).toBe(200);

    const [charges, after, claim] = await Promise.all([
      prisma.supplierCharge.findMany({ where: { bookingId: booking.id } }),
      prisma.booking.findUnique({ where: { id: booking.id } }),
      prisma.refundClaim.findUnique({ where: { id: claimId } }),
    ]);

    expect(charges).toHaveLength(1);
    expect(Number(charges[0].amount)).toBe(32);
    expect(after.status).toBe('COMPLETED');
    expect(after.paymentStatus).toBe('SUCCEEDED');
    expect(Number(after.refundAmount)).toBe(40);
    expect(claim.status).toBe('RELEASED');
  });

  it('refuses a second claim on a booking that already has one open', async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking({ customerId: customer.user.id });
    const first = await submitClaim(booking, customer.token);
    expect(first.status).toBe(201);

    const second = await submitClaim(booking, customer.token);
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/refund request in progress/i);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });
});
