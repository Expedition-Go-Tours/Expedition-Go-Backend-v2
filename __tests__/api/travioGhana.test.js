/**
 * TravioGhana — brand storefront, supplier dashboard and admin console,
 * against a REAL database.
 *
 * This suite previously mocked `prismaClient`, and that hid a specific class
 * of bug: every `mockResolvedValue(row)` answers whatever it is handed, so a
 * `where` clause that dropped its filter still returned "our" row and passed.
 * Three things are now observed instead of asserted:
 *
 *   1. Scoping. Supplier endpoints reach the business through
 *      `resolveSupplier` (owner OR accepted team member); admin endpoints
 *      through `restrictTo('admin')` plus the real
 *      AdminRole → AdminRolePermission → AdminPermission wiring. A second
 *      supplier and a second customer exist purely so "only their own" has
 *      something to be measured against.
 *
 *   2. Publication filters. A tour owned by a supplier whose profile is still
 *      PENDING, a listing switched off, and a tour not flagged isFeatured all
 *      exist to be excluded — none of which a mock could enforce.
 *
 *   3. Writes. The invoice approve/mark-paid pair reads the row back out of
 *      the table rather than checking `invoice.update` was CALLED with the
 *      right arguments, and the booking/revenue tests create real bookings
 *      including a simulated one that must not be counted.
 *
 * Still mocked, deliberately: `cacheHelper` (a pass-through, so every read
 * reaches the database rather than a 30s Redis entry left by the previous
 * test), `emailService` and `queue` (the contact form must not send),
 * `getConfig`, `auditLogger`, `viewTracking`, `imageOptimizer`, and
 * `homepageRanking` — whose raw SQL is already exercised for real, and at
 * length, by `__tests__/api/homepageData.test.js`, so re-running it here would
 * only add a second way for this suite to fail for an unrelated reason.
 *
 * `tourHelpers` and the availability calendar are the REAL modules, anchored
 * to prices this suite writes itself.
 *
 * Fixtures are keyed on a `tvg-` prefix and removed in `afterAll`, so a
 * crashed run cannot leave counts behind. Runs against the isolated
 * `travio_test` (gated on TEST_DB_AVAILABLE).
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
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));
jest.mock('../../src/core/services/viewTracking', () => ({
  shouldCountTourView: jest.fn(async () => ({ counted: false, geo: null })),
  isInternalViewer: jest.fn(async () => false),
  getViewerGeo: jest.fn(() => null),
}));
jest.mock('../../src/core/services/homepageRanking', () => {
  const empty = () => jest.fn().mockResolvedValue([]);
  return {
    getLikelySellOut: empty(),
    getTopRated: empty(),
    getTrending: empty(),
    getRecommended: empty(),
    getNewExperiences: empty(),
    getAttractions: empty(),
    getMoodKeywords: empty(),
    getPopularDestinations: empty(),
  };
});

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'tvg-';
const ADMIN_EMAIL = 'tvg-admin@test.invalid';
const SUPPLIER_EMAIL = 'tvg-supplier@test.invalid';
const OTHER_SUPPLIER_EMAIL = 'tvg-other-supplier@test.invalid';
const PENDING_SUPPLIER_EMAIL = 'tvg-pending-supplier@test.invalid';
const CUSTOMER_EMAIL = 'tvg-customer@test.invalid';
const STRANGER_EMAIL = 'tvg-stranger@test.invalid';
const NEWSLETTER_EMAIL = 'tvg-newsletter@test.invalid';
const NEWSLETTER_EMAIL_2 = 'tvg-newsletter-2@test.invalid';

const SLUG_A = 'tvg-cultural-cape-coast';
const SLUG_B = 'tvg-cultural-kumasi';
const SLUG_UNLISTED = 'tvg-unlisted-tour'; // supplier profile still PENDING
const SLUG_UNPUBLISHED = 'tvg-unpublished-tour'; // listing isActive: false
const SLUG_DRAFT = 'tvg-draft-tour'; // no storefront listing at all
const SLUG_OTHER = 'tvg-other-suppliers-tour'; // belongs to somebody else

const TITLE_A = 'TVG Cultural Cape Coast';
const TITLE_B = 'TVG Cultural Kumasi';
const RETAIL_PRICE = 50;
const BOOKING_NUMBER = 'tvg-bk-0001';
const SIMULATED_BOOKING_NUMBER = 'tvg-bk-simulated';
const STRANGER_BOOKING_NUMBER = 'tvg-bk-stranger';
const INVOICE_NUMBER = 'tvg-inv-0001';
const INVOICE_PAID_REFERENCE = 'WB-1420';

/** Written by this suite, so price assertions are anchored to something real. */
const PRICING = {
  travelerDetails: {
    pricingModel: 'perPerson',
    pricingApproach: 'sameForEveryone',
    uniformPrice: RETAIL_PRICE,
    maxTravelersPerBooking: 15,
    ageGroups: [],
  },
  pricingSchedules: {
    currency: 'USD',
    schedules: [
      {
        startDate: '2026-01-01',
        endDate: '2027-12-31',
        prices: [{ ageGroup: 'Adult', retailPrice: RETAIL_PRICE }],
      },
    ],
  },
};

const baseTour = {
  status: 'ACTIVE',
  country: 'Ghana',
  photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/tvg.jpg'],
  coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/tvg-cover.jpg',
  schedulesAndPricing: PRICING,
  bookingAndTickets: {},
  itineraryRegions: ['Greater Accra Region'],
  aiProcessingStatus: 'PENDING',
  categorization: { category: 'Cultural', subcategory: 'Historical Sites', activityType: 'Half-Day Tour' },
  theme: { primary: 'History & Culture' },
  productContent: { location: { city: 'Accra', country: 'Ghana' }, duration: 'Half day' },
};

const emptyProfile = {
  businessInfo: {},
  operatingInfo: {},
  representativeInfo: {},
  businessDocuments: {},
  payoutInfo: {},
  compliance: {},
};

/**
 * Prisma hands back Dates from the driver's own realm, so jest's
 * `toBeInstanceOf(Date)` reports "Expected constructor: Date / Received
 * constructor: Date" and fails on a value that really is a Date. Compare the
 * toString tag instead — it is realm-independent and still catches a string,
 * null or Invalid Date.
 */
function expectDate(value, label) {
  expect({
    label,
    kind: Object.prototype.toString.call(value),
    parsed: Number.isNaN(new Date(value).getTime()) ? 'invalid' : 'valid',
  }).toEqual({ label, kind: '[object Date]', parsed: 'valid' });
}

let adminId;
let supplierId;
// The owner branch of /settings/team/my-role and the merged
// /admin/suppliers/:id payload both key on SupplierProfile.id, not User.id —
// the admin SPA reads them apart (SupplierDetail.tsx: `userId = supplier?.userId`,
// `profileId = supplier?.id`), so the suite has to as well.
let supplierProfileId;
let otherSupplierId;
let pendingSupplierId;
let customerId;
let strangerId;
let adminToken;
let supplierToken;
let customerToken;
let tourA;
let tourB;
let tourUnlisted;
let tourUnpublished;
let tourOther;
let invoiceId;
let approvedReviewId;
let pendingReviewId;

async function upsertUser(email, data) {
  return prisma.user.upsert({
    where: { email },
    update: data,
    create: { firebaseUid: `test-${email}`, email, photoURL: '', active: true, ...data },
  });
}

async function upsertSupplierProfile(userId, status) {
  return prisma.supplierProfile.upsert({
    where: { userId },
    update: { status },
    create: { userId, status, ...emptyProfile },
  });
}

async function upsertTour(slug, data) {
  return prisma.tour.upsert({
    where: { slug },
    update: { ...baseTour, ...data },
    create: { slug, ...baseTour, ...data },
  });
}

async function upsertGhanaListing(tourId, data) {
  return prisma.travioGhanaTour.upsert({
    where: { tourId },
    update: data,
    create: { tourId, ...data },
  });
}

/** Children first: the same order the schema's cascades would force anyway. */
async function wipeFixtures() {
  await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: PREFIX } } });
  await prisma.review.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } });
  await prisma.wishlistItem.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } });
  await prisma.booking.deleteMany({ where: { bookingNumber: { startsWith: PREFIX } } });
  await prisma.travioGhanaTour.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } });
  await prisma.expeditionTour.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } });
  await prisma.tourDateOverride.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } });
  await prisma.tour.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.newsletterSubscriber.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

describeDb('TravioGhana API (real DB)', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    await prisma.$connect();
    await wipeFixtures();

    // The admin routes gate on `restrictTo('admin')` and then on real
    // permissions, so the fixture has to carry a REAL role. Seeded by
    // prisma/seed.js — 32 permissions, the same shape production runs with.
    const superAdmin = await prisma.adminRole.findUnique({
      where: { name: 'super_admin' },
      select: { id: true },
    });
    if (!superAdmin) {
      throw new Error('seeded super_admin role missing — run `npm run seed` against travio_test');
    }

    const admin = await upsertUser(ADMIN_EMAIL, { name: 'TVG Admin', roles: ['admin'], adminRoleId: superAdmin.id });
    adminId = admin.id;
    adminToken = signAccessToken({ userId: admin.id });

    const supplier = await upsertUser(SUPPLIER_EMAIL, {
      name: 'TVG Supplier',
      roles: ['supplier', 'ghana'],
      notificationPreferences: { emailNotifications: {}, pushNotifications: {} },
    });
    supplierId = supplier.id;
    supplierToken = signAccessToken({ userId: supplier.id });
    supplierProfileId = (await upsertSupplierProfile(supplier.id, 'ACTIVE')).id;

    const otherSupplier = await upsertUser(OTHER_SUPPLIER_EMAIL, {
      name: 'TVG Other Supplier',
      roles: ['supplier', 'ghana'],
    });
    otherSupplierId = otherSupplier.id;
    await upsertSupplierProfile(otherSupplier.id, 'ACTIVE');

    // Owns SLUG_UNLISTED: the listing is live, but the business has not been
    // approved, so nothing on the storefront may show it.
    const pendingSupplier = await upsertUser(PENDING_SUPPLIER_EMAIL, {
      name: 'TVG Pending Supplier',
      roles: ['supplier'],
    });
    pendingSupplierId = pendingSupplier.id;
    await upsertSupplierProfile(pendingSupplier.id, 'PENDING');

    const customer = await upsertUser(CUSTOMER_EMAIL, { name: 'TVG Customer', roles: ['customer'] });
    customerId = customer.id;
    customerToken = signAccessToken({ userId: customer.id });

    const stranger = await upsertUser(STRANGER_EMAIL, { name: 'TVG Stranger', roles: ['customer'] });
    strangerId = stranger.id;

    tourA = await upsertTour(SLUG_A, {
      title: TITLE_A,
      description: 'Fixture tour A — featured, with reviews and a booking.',
      category: 'Cultural',
      city: 'Cape Coast',
      region: 'Central',
      latitude: 5.1053,
      longitude: -1.2466,
      supplierId,
    });
    tourB = await upsertTour(SLUG_B, {
      title: TITLE_B,
      description: 'Fixture tour B — same category, not featured.',
      category: 'Cultural',
      city: 'Kumasi',
      region: 'Ashanti',
      latitude: 6.6885,
      longitude: -1.6244,
      supplierId,
    });
    tourUnlisted = await upsertTour(SLUG_UNLISTED, {
      title: 'TVG Unlisted Tour',
      description: 'Live listing on an unapproved supplier.',
      category: 'Cultural',
      city: 'Accra',
      region: 'Greater Accra',
      supplierId: pendingSupplierId,
    });
    tourUnpublished = await upsertTour(SLUG_UNPUBLISHED, {
      title: 'TVG Unpublished Tour',
      description: 'Approved supplier, listing switched off.',
      category: 'Cultural',
      city: 'Accra',
      region: 'Greater Accra',
      supplierId,
    });
    // No listing row at all — must still show on the supplier's own dashboard.
    await upsertTour(SLUG_DRAFT, {
      title: 'TVG Draft Tour',
      description: 'Never published anywhere.',
      category: 'Cultural',
      city: 'Accra',
      region: 'Greater Accra',
      status: 'DRAFT',
      draftStatus: 'DRAFT',
      supplierId,
    });
    tourOther = await upsertTour(SLUG_OTHER, {
      title: 'TVG Other Supplier Tour',
      description: 'Owned by a different, fully approved business.',
      category: 'Cultural',
      city: 'Tamale',
      region: 'Northern',
      supplierId: otherSupplierId,
    });

    await upsertGhanaListing(tourA.id, { isActive: true, isFeatured: true, displayOrder: 1 });
    await upsertGhanaListing(tourB.id, { isActive: true, isFeatured: false, displayOrder: 2 });
    await upsertGhanaListing(tourUnlisted.id, { isActive: true, isFeatured: false, displayOrder: 3 });
    await upsertGhanaListing(tourUnpublished.id, { isActive: false, isFeatured: false, displayOrder: 4 });
    await upsertGhanaListing(tourOther.id, { isActive: true, isFeatured: false, displayOrder: 5 });

    const approved5 = await prisma.review.create({
      data: {
        tourId: tourA.id,
        customerId,
        rating: 5,
        title: 'Excellent',
        comment: 'A genuinely excellent fixture tour.',
        photos: [],
        status: 'APPROVED',
      },
    });
    approvedReviewId = approved5.id;
    await prisma.review.create({
      data: {
        tourId: tourA.id,
        customerId,
        rating: 3,
        title: 'Fine',
        comment: 'A perfectly adequate fixture tour.',
        photos: [],
        status: 'APPROVED',
      },
    });
    const pendingReview = await prisma.review.create({
      data: {
        tourId: tourA.id,
        customerId,
        rating: 1,
        title: 'Awaiting moderation',
        comment: 'Must never appear on any public reviews endpoint.',
        photos: [],
        status: 'PENDING',
      },
    });
    pendingReviewId = pendingReview.id;

    await prisma.booking.create({
      data: {
        bookingNumber: BOOKING_NUMBER,
        source: 'GHANA',
        customerId,
        tourId: tourA.id,
        status: 'CONFIRMED',
        paymentStatus: 'SUCCEEDED',
        currency: 'USD',
        travelers: { adults: 2, children: 0, infants: 0 },
        travelDate: new Date('2026-12-01T09:00:00.000Z'),
        selectedTime: '09:00',
        subtotal: 120.5,
        grossAmount: 120.5,
        commissionRate: 0.1,
        platformCommission: 12.05,
        supplierPayout: 108.45,
        paidAt: new Date(),
      },
    });

    // Same supplier, real money — but simulated demo data that every revenue
    // figure excludes. Its value is deliberately enormous so an unfiltered
    // aggregate could not go unnoticed.
    await prisma.booking.create({
      data: {
        bookingNumber: SIMULATED_BOOKING_NUMBER,
        source: 'GHANA',
        customerId,
        tourId: tourA.id,
        status: 'CONFIRMED',
        paymentStatus: 'SUCCEEDED',
        isSimulated: true,
        currency: 'USD',
        travelers: { adults: 2, children: 0, infants: 0 },
        travelDate: new Date('2026-12-02T09:00:00.000Z'),
        selectedTime: '09:00',
        subtotal: 99999,
        grossAmount: 99999,
        commissionRate: 0,
        platformCommission: 0,
        supplierPayout: 99999,
        paidAt: new Date(),
      },
    });

    // A different customer's booking on a different supplier's tour — the
    // customer bookings list must never surface it.
    await prisma.booking.create({
      data: {
        bookingNumber: STRANGER_BOOKING_NUMBER,
        source: 'GHANA',
        customerId: strangerId,
        tourId: tourOther.id,
        status: 'CONFIRMED',
        paymentStatus: 'SUCCEEDED',
        currency: 'USD',
        travelers: { adults: 1, children: 0, infants: 0 },
        travelDate: new Date('2026-12-03T09:00:00.000Z'),
        selectedTime: '09:00',
        subtotal: 50,
        grossAmount: 50,
        commissionRate: 0.1,
        platformCommission: 5,
        supplierPayout: 45,
        paidAt: new Date(),
      },
    });

    await prisma.wishlistItem.create({ data: { userId: customerId, tourId: tourA.id } });
    await prisma.wishlistItem.create({ data: { userId: strangerId, tourId: tourB.id } });

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: INVOICE_NUMBER,
        supplierId,
        cycle: 'TWICE_MONTHLY',
        cycleStartDate: new Date(Date.UTC(2026, 9, 1)),
        cycleEndDate: new Date(Date.UTC(2026, 9, 15)),
        cycleLabel: 'Oct 1–15',
        invoicedAt: new Date(Date.UTC(2026, 9, 16)),
        paymentScheduledAt: new Date(Date.UTC(2026, 9, 20)),
        status: 'INVOICED',
        grossTotal: 100,
        commissionTotal: 17,
        netTotal: 83,
        currency: 'USD',
        bookingCount: 1,
      },
    });
    invoiceId = invoice.id;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Approving and marking paid both persist; put the invoice back.
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'INVOICED', approvedAt: null, approvedBy: null, paidAt: null, paidBy: null, reference: null },
    });
  });

  afterAll(async () => {
    await wipeFixtures().catch(() => {});
    await prisma.$disconnect();
  });

  // ── Public storefront ──────────────────────────────────────────────────
  describe('TravioGhana API — public endpoints', () => {
    it('GET /homepage returns 200', async () => {
      const res = await request(app).get('/api/travioghana/homepage');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('GET /tours returns 200 with listing', async () => {
      const res = await request(app).get('/api/travioghana/tours');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const slugs = res.body.data.tours.map((row) => row.tour.slug);
      expect(slugs).toContain(SLUG_A);
      expect(slugs).toContain(SLUG_B);
      // The listing row is live, but the supplier profile is still PENDING.
      expect(slugs).not.toContain(SLUG_UNLISTED);
      // …and this one is an approved supplier whose listing was switched off.
      expect(slugs).not.toContain(SLUG_UNPUBLISHED);
      expect(res.body.pagination.currentPage).toBe(1);
    });

    it('GET /tours prices the listing from the tour pricing blob it stores', async () => {
      const res = await request(app).get('/api/travioghana/tours');
      const row = res.body.data.tours.find((r) => r.tour.slug === SLUG_A);
      expect(row.tour).toMatchObject({
        id: tourA.id,
        title: TITLE_A,
        startingPrice: RETAIL_PRICE,
        currency: 'USD',
        category: 'Cultural',
      });
    });

    it('GET /tours/featured returns only the tours flagged isFeatured', async () => {
      const res = await request(app).get('/api/travioghana/tours/featured');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const slugs = res.body.data.tours.map((row) => row.tour.slug);
      expect(slugs).toContain(SLUG_A);
      expect(slugs).not.toContain(SLUG_B);
      expect(slugs).not.toContain(SLUG_UNLISTED);
    });

    it('GET /tours/sitemap returns 200', async () => {
      const res = await request(app).get('/api/travioghana/tours/sitemap');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('GET /tours/:slug returns 200 with tour detail', async () => {
      const res = await request(app).get(`/api/travioghana/tours/${SLUG_A}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('GET /tours/:slug resolves a tour id as well as a slug', async () => {
      // The Ghana override once matched on `slug` alone, so `/tours/{id}` —
      // the canonical URL both storefronts publish — 404'd on every tour page.
      const res = await request(app).get(`/api/travioghana/tours/${tourB.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tour.tour).toMatchObject({ id: tourB.id, slug: SLUG_B });
    });

    it('GET /tours/:slug returns 404 for unknown tour', async () => {
      await request(app).get('/api/travioghana/tours/does-not-exist').expect(404);
    });

    it('GET /tours/:slug 404s a listing switched off and a supplier still pending', async () => {
      await request(app).get(`/api/travioghana/tours/${SLUG_UNPUBLISHED}`).expect(404);
      await request(app).get(`/api/travioghana/tours/${SLUG_UNLISTED}`).expect(404);
    });

    it('GET /tours/:slug/reviews returns 200', async () => {
      const res = await request(app).get(`/api/travioghana/tours/${SLUG_A}/reviews`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('GET /tours/:slug/reviews returns only APPROVED reviews', async () => {
      const res = await request(app).get(`/api/travioghana/tours/${SLUG_A}/reviews`);

      const ids = (res.body.data.reviews || []).map((r) => r.id);
      expect(ids).not.toContain(pendingReviewId);
      expect(ids).toContain(approvedReviewId);
      expect(res.body.data.totalCount).toBe(2);
    });

    it('GET /tours/:slug/similar returns 200', async () => {
      const res = await request(app).get(`/api/travioghana/tours/${SLUG_A}/similar`);
      expect(res.status).toBe(200);
    });

    it('GET /tours/:slug/similar never returns the tour itself', async () => {
      const res = await request(app).get(`/api/travioghana/tours/${SLUG_A}/similar`);
      const slugs = res.body.data.tours.map((row) => row.tour.slug);
      expect(slugs).not.toContain(SLUG_A);
      expect(slugs).toContain(SLUG_B);
    });

    it('GET /tours/:slug/availability returns 200', async () => {
      const res = await request(app).get(`/api/travioghana/tours/${SLUG_A}/availability?startDate=2026-11-01&endDate=2026-11-10`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      // The listing → tour join, not a stub that answers for any slug.
      expect(res.body.data.tour).toMatchObject({ id: tourA.id, title: TITLE_A });
    });

    it('POST /contact returns 200 and sends email', async () => {
      const res = await request(app)
        .post('/api/travioghana/contact')
        .send({ name: 'Jane Doe', email: 'jane@test.com', message: 'This is a sufficiently long test message.' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('POST /contact returns 400 when message too short', async () => {
      const res = await request(app)
        .post('/api/travioghana/contact')
        .send({ name: 'Jane Doe', email: 'jane@test.com', message: 'short' });
      expect(res.status).toBe(400);
    });

    it('POST /subscribe returns 200', async () => {
      const res = await request(app).post('/api/travioghana/subscribe').send({ email: NEWSLETTER_EMAIL });
      expect(res.status).toBe(200);

      const row = await prisma.newsletterSubscriber.findUnique({ where: { email: NEWSLETTER_EMAIL } });
      expect(row).toMatchObject({ email: NEWSLETTER_EMAIL, subscribed: true });
    });

    it('POST /subscribe is idempotent', async () => {
      await request(app).post('/api/travioghana/subscribe').send({ email: NEWSLETTER_EMAIL_2 }).expect(200);
      const second = await request(app).post('/api/travioghana/subscribe').send({ email: NEWSLETTER_EMAIL_2 });

      expect(second.status).toBe(200);
      expect(second.body.message).toMatch(/already subscribed/i);
      expect(await prisma.newsletterSubscriber.count({ where: { email: NEWSLETTER_EMAIL_2 } })).toBe(1);
    });

    it('POST /track-click returns 204', async () => {
      const res = await request(app)
        .post('/api/travioghana/track-click')
        .send({ event: 'cta_book_now', target: SLUG_A });
      expect(res.status).toBe(204);
    });

    it('POST /checkout/calculate returns 200 with pricing', async () => {
      const res = await request(app)
        .post('/api/travioghana/checkout/calculate')
        .send({ tourId: tourA.id, travelDate: '2027-02-15', travelers: { adults: 2 } });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      // SameForEveryone @ RETAIL_PRICE, per person.
      expect(res.body.data.pricing.subtotal).toBe(RETAIL_PRICE * 2);
    });

    it('POST /checkout/calculate 400s a tour not published to this storefront', async () => {
      const res = await request(app)
        .post('/api/travioghana/checkout/calculate')
        .send({ tourId: tourUnpublished.id, travelDate: '2027-02-15', travelers: { adults: 2 } });
      expect(res.status).toBe(400);
    });
  });

  // ── Auth gating ────────────────────────────────────────────────────────
  describe('TravioGhana API — auth gating', () => {
    it.each([
      ['GET', '/api/travioghana/wishlist'],
      ['GET', '/api/travioghana/bookings'],
      ['GET', '/api/travioghana/supplier/dashboard'],
      ['GET', '/api/travioghana/supplier/settings'],
      ['GET', '/api/travioghana/admin/me'],
      ['GET', '/api/travioghana/admin/analytics/overview'],
      ['GET', '/api/travioghana/admin/tours'],
    ])('%s %s returns 401 without token', async (method, path) => {
      const res = await request(app)[method.toLowerCase()](path);
      expect(res.status).toBe(401);
    });

    it('customer cannot access supplier routes', async () => {
      // resolveSupplier finds neither a profile nor a membership for them.
      const res = await request(app).get('/api/travioghana/supplier/tours').set({ Authorization: `Bearer ${customerToken}` });
      expect(res.status).toBe(403);
    });

    it('supplier cannot access admin routes', async () => {
      const res = await request(app).get('/api/travioghana/admin/me').set({ Authorization: `Bearer ${supplierToken}` });
      expect(res.status).toBe(403);
    });

    it('a customer on an admin route is refused by the real permission wiring', async () => {
      // restrictTo('admin') rejects before any permission is consulted.
      const res = await request(app)
        .get('/api/travioghana/admin/finance/invoices')
        .set({ Authorization: `Bearer ${customerToken}` });
      expect(res.status).toBe(403);
    });
  });

  // ── Customer endpoints ─────────────────────────────────────────────────
  describe('TravioGhana API — customer endpoints', () => {
    it('GET /wishlist returns 200 and only their own items', async () => {
      const res = await request(app).get('/api/travioghana/wishlist').set({ Authorization: `Bearer ${customerToken}` });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      // The stranger wishlisted tourB; the scoped query must not surface it.
      const ids = res.body.data.tours.map((t) => t.id);
      expect(ids).toContain(tourA.id);
      expect(ids).not.toContain(tourB.id);
      expect(res.body.results).toBe(ids.length);
    });

    it('GET /bookings returns 200 and only their own bookings', async () => {
      const res = await request(app).get('/api/travioghana/bookings').set({ Authorization: `Bearer ${customerToken}` });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const numbers = res.body.data.bookings.map((b) => b.bookingNumber);
      expect(numbers).toContain(BOOKING_NUMBER);
      // Somebody else's booking, on a different supplier's tour.
      expect(numbers).not.toContain(STRANGER_BOOKING_NUMBER);
    });

    it('GET /bookings excludes simulated demo bookings', async () => {
      const res = await request(app).get('/api/travioghana/bookings').set({ Authorization: `Bearer ${customerToken}` });

      const numbers = res.body.data.bookings.map((b) => b.bookingNumber);
      expect(numbers).not.toContain(SIMULATED_BOOKING_NUMBER);
    });
  });

  // ── Supplier dashboard ─────────────────────────────────────────────────
  describe('TravioGhana API — supplier endpoints', () => {
    // A thunk: this describe body runs during collection, before beforeAll
    // has minted the tokens, so the header is built per request instead.
    const auth = () => ({ Authorization: `Bearer ${supplierToken}` });

    it('GET /dashboard returns 200', async () => {
      const res = await request(app).get('/api/travioghana/supplier/dashboard').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('GET /dashboard reports this supplier own tours, not another business', async () => {
      const res = await request(app).get('/api/travioghana/supplier/dashboard').set(auth());
      const slugs = (res.body.data.tours?.slugs || []).concat(
        (res.body.data.topProducts || []).map((p) => p.slug),
      );
      expect(slugs).not.toContain(SLUG_OTHER);
    });

    it('GET /monthly-revenue returns a continuous month window', async () => {
      const res = await request(app).get('/api/travioghana/supplier/monthly-revenue?months=3').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const months = res.body.data.months;
      expect(months).toHaveLength(3);
      expect(months[0].month).toMatch(/^\d{4}-\d{2}$/);
      // Ascending, and quiet months are present as zeros rather than skipped.
      expect(months.map((m) => m.month)).toEqual([...months.map((m) => m.month)].sort());
    });

    it('GET /monthly-revenue buckets paid revenue and ignores demo bookings', async () => {
      const res = await request(app).get('/api/travioghana/supplier/monthly-revenue').set(auth());

      const months = res.body.data.months;
      expect(months).toHaveLength(12);

      const total = months.reduce((sum, m) => sum + m.revenue, 0);
      // The real booking is 120.50; the simulated one is 99,999 and must not
      // be reachable through this figure at all.
      expect(total).toBeCloseTo(120.5, 2);
    });

    it('GET /tours returns 200', async () => {
      const res = await request(app).get('/api/travioghana/supplier/tours').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('GET /tours scopes to the signed-in supplier', async () => {
      const res = await request(app).get('/api/travioghana/supplier/tours').set(auth());

      const slugs = res.body.data.tours.map((t) => t.slug);
      expect(slugs).toContain(SLUG_A);
      expect(slugs).toContain(SLUG_B);
      expect(slugs).not.toContain(SLUG_OTHER);
      expect(slugs).not.toContain(SLUG_UNLISTED);
    });

    it('GET /tours includes drafts that have no storefront listing', async () => {
      const res = await request(app).get('/api/travioghana/supplier/tours').set(auth());

      const draft = res.body.data.tours.find((t) => t.slug === SLUG_DRAFT);
      expect(draft).toMatchObject({ status: 'DRAFT', storefront: null });
      // …and the published ones are tagged with where they appear.
      const published = res.body.data.tours.find((t) => t.slug === SLUG_A);
      expect(published.storefront).toBe('GHANA');
    });

    it('GET /tours honours limit up to 200 instead of capping at 50', async () => {
      const res = await request(app).get('/api/travioghana/supplier/tours?limit=200').set(auth());

      // `pagination.limit` echoes the effective take, which is exactly what
      // the old 50 cap reduced — the response proves the request was honoured.
      expect(res.body.pagination.limit).toBe(200);
      expect(res.body.data.tours.length).toBeGreaterThan(0);
    });

    it('GET /reviews returns 200 (uses customer relation)', async () => {
      const res = await request(app).get('/api/travioghana/supplier/reviews').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const reviews = res.body.data.reviews;
      expect(reviews.length).toBeGreaterThan(0);
      // The join has to survive: a null customer is what broke this page.
      expect(reviews[0].customer).toMatchObject({ id: customerId, name: 'TVG Customer' });
      expect(reviews[0].tour.id).toBe(tourA.id);
    });

    it('GET /reviews never surfaces another supplier reviews', async () => {
      const res = await request(app).get('/api/travioghana/supplier/reviews').set(auth());

      const tourIds = res.body.data.reviews.map((r) => r.tour.id);
      expect(tourIds).not.toContain(tourOther.id);
    });

    it('GET /availability/:tourId returns 200', async () => {
      const res = await request(app).get(`/api/travioghana/supplier/availability/${tourA.id}`).set(auth());
      expect(res.status).toBe(200);
    });

    it('GET /availability/:tourId 404s a tour owned by another supplier', async () => {
      await request(app).get(`/api/travioghana/supplier/availability/${tourOther.id}`).set(auth()).expect(404);
    });

    it('GET /settings returns 200', async () => {
      const res = await request(app).get('/api/travioghana/supplier/settings').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.supplier.supplierProfile).toMatchObject({ status: 'ACTIVE' });
    });

    it('GET /settings/business-profile returns 200', async () => {
      await request(app).get('/api/travioghana/supplier/settings/business-profile').set(auth()).expect(200);
    });

    it('GET /settings/notification-preferences returns 200', async () => {
      await request(app).get('/api/travioghana/supplier/settings/notification-preferences').set(auth()).expect(200);
    });

    it('GET /settings/tax-info returns 200', async () => {
      await request(app).get('/api/travioghana/supplier/settings/tax-info').set(auth()).expect(200);
    });

    it('GET /settings/booking-rules returns 200', async () => {
      await request(app).get('/api/travioghana/supplier/settings/booking-rules').set(auth()).expect(200);
    });

    it('GET /settings/team/my-role reports the owner with the profile id', async () => {
      const res = await request(app).get('/api/travioghana/supplier/settings/team/my-role').set(auth());
      expect(res.status).toBe(200);

      // The owner branch resolves SupplierProfile by userId, so `supplierId`
      // here is the PROFILE id — `role: 'admin'` is this endpoint's word for
      // "owns the business", not a platform admin. Both are load-bearing for
      // the supplier app, which uses supplierId as the workspace key.
      expect(res.body.data).toMatchObject({
        role: 'admin',
        isOwner: true,
        supplierId: supplierProfileId,
      });
      expect(res.body.data.storefronts).toContain('GHANA');
      // …and the profile id is genuinely distinct from the user id it hangs off.
      expect(res.body.data.supplierId).not.toBe(supplierId);
    });

    it('GET /settings/team/members returns 200', async () => {
      const res = await request(app).get('/api/travioghana/supplier/settings/team/members').set(auth());
      expect(res.status).toBe(200);
    });

    it('GET /special-offers returns 200', async () => {
      const res = await request(app).get('/api/travioghana/supplier/special-offers').set(auth());
      expect(res.status).toBe(200);
    });

    it('GET /cancellation/summary returns 200', async () => {
      await request(app).get('/api/travioghana/supplier/cancellation/summary').set(auth()).expect(200);
    });

    it('GET /finance/summary returns 200', async () => {
      const res = await request(app).get('/api/travioghana/supplier/finance/summary').set(auth());
      expect(res.status).toBe(200);
    });

    it('GET /payouts returns 200', async () => {
      await request(app).get('/api/travioghana/supplier/payouts').set(auth()).expect(200);
    });

    it('GET /notifications returns 200', async () => {
      await request(app).get('/api/travioghana/supplier/notifications').set(auth()).expect(200);
    });
  });

  // ── Admin console ──────────────────────────────────────────────────────
  describe('TravioGhana API — admin endpoints', () => {
    const auth = () => ({ Authorization: `Bearer ${adminToken}` });

    it('GET /me returns 200', async () => {
      const res = await request(app).get('/api/travioghana/admin/me').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      // getMe spreads the user straight into `data` rather than nesting it,
      // and the role carries its real permission keys — read back from
      // AdminRole → AdminRolePermission → AdminPermission.
      expect(res.body.data).toMatchObject({ id: adminId, email: ADMIN_EMAIL, roles: ['admin'] });
      expect(res.body.data.adminRole.name).toBe('super_admin');
      expect(res.body.data.adminRole.permissions).toEqual(expect.arrayContaining(['suppliers.view', 'tours.view']));
    });

    // ── Finance v3 invoices — the admin Invoices tab rewrites /admin/* to
    // THIS brand router, never the core /api/admin/finance one. All four
    // paths 404'd until the brand router grew the invoice routes. ──

    it('GET /admin/finance/invoices returns the invoice queue (was 404)', async () => {
      const res = await request(app).get('/api/travioghana/admin/finance/invoices').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const numbers = res.body.data.invoices.map((inv) => inv.invoiceNumber);
      expect(numbers).toContain(INVOICE_NUMBER);
    });

    it('GET /admin/finance/invoices/:id returns the invoice detail (was 404)', async () => {
      const res = await request(app).get(`/api/travioghana/admin/finance/invoices/${invoiceId}`).set(auth());
      expect(res.status).toBe(200);

      expect(res.body.data.invoice).toMatchObject({
        invoiceNumber: INVOICE_NUMBER,
        status: 'INVOICED',
        currency: 'USD',
      });
      // Decimal columns come back coerced, not as strings.
      expect(res.body.data.invoice.netTotal).toBe(83);
      expect(res.body.data.invoice.grossTotal).toBe(100);
      expect(res.body.data.invoice.supplier).toMatchObject({ id: supplierId, email: SUPPLIER_EMAIL });
    });

    it('PATCH /admin/finance/invoices/:id/approve records the approval (was 404)', async () => {
      const res = await request(app)
        .patch(`/api/travioghana/admin/finance/invoices/${invoiceId}/approve`)
        .set(auth());
      expect(res.status).toBe(200);

      // Read back from the table — the previous version asserted that
      // `invoice.update` had been CALLED with these arguments.
      const row = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      expect(row.status).toBe('APPROVED');
      expect(row.approvedBy).toBe(adminId);
      expectDate(row.approvedAt, 'row.approvedAt');
    });

    it('PATCH /admin/finance/invoices/:id/approve 409s a second approval', async () => {
      await request(app)
        .patch(`/api/travioghana/admin/finance/invoices/${invoiceId}/approve`)
        .set(auth())
        .expect(200);

      const second = await request(app)
        .patch(`/api/travioghana/admin/finance/invoices/${invoiceId}/approve`)
        .set(auth());
      expect(second.status).toBe(409);
    });

    it('PATCH /admin/finance/invoices/:id/mark-paid refuses until approved (was 404)', async () => {
      const res = await request(app)
        .patch(`/api/travioghana/admin/finance/invoices/${invoiceId}/mark-paid`)
        .set(auth())
        .send({ reference: INVOICE_PAID_REFERENCE });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('awaiting approval');

      // and nothing was written while refusing
      const row = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      expect(row.status).toBe('INVOICED');
      expect(row.reference).toBeNull();
    });

    it('PATCH /admin/finance/invoices/:id/mark-paid records the reference once approved', async () => {
      await request(app)
        .patch(`/api/travioghana/admin/finance/invoices/${invoiceId}/approve`)
        .set(auth())
        .expect(200);

      const res = await request(app)
        .patch(`/api/travioghana/admin/finance/invoices/${invoiceId}/mark-paid`)
        .set(auth())
        .send({ reference: INVOICE_PAID_REFERENCE });
      expect(res.status).toBe(200);

      const row = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      expect(row.status).toBe('PAID');
      expect(row.reference).toBe(INVOICE_PAID_REFERENCE);
      expect(row.paidBy).toBe(adminId);
    });

    it('GET /analytics/overview returns 200 and totals the brand money', async () => {
      const res = await request(app).get('/api/travioghana/admin/analytics/overview').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      // The SUM … FILTER aggregates run over every Booking in the brand scope;
      // this suite's fixture booking is paid today, so it has to be in them.
      // (Greater-than-or-equal, not equal: other suites' fixtures may be live
      // in the same database while this one runs.)
      expect(res.body.data.overview.revenue.today.revenue).toBeGreaterThanOrEqual(120.5);
      expect(res.body.data.overview.bookings.today).toBeGreaterThanOrEqual(1);
    });

    it('GET /tours returns 200', async () => {
      const res = await request(app).get('/api/travioghana/admin/tours').set(auth());
      expect(res.status).toBe(200);
    });

    it('GET /suppliers returns 200 with ghana suppliers', async () => {
      const res = await request(app).get('/api/travioghana/admin/suppliers').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      // The brand scope is `ghana`, so the pending business shows in the
      // admin queue even though the storefront refuses to list its tours.
      const ids = (res.body.data.suppliers || []).map((s) => s.userId || s.id);
      expect(ids).toContain(supplierId);
    });

    it('GET /suppliers/:id returns 200 with merged supplier shape', async () => {
      const res = await request(app).get(`/api/travioghana/admin/suppliers/${supplierId}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      // The handler spreads the profile AFTER the user, so `id` is the
      // SupplierProfile id and the User id survives in `userId`. That is the
      // contract the admin SPA relies on — it reads `supplier.userId` for
      // user-keyed calls and `supplier.id` for profile-keyed ones — so both
      // are pinned here rather than assuming `id` is the user.
      expect(res.body.data.supplier).toMatchObject({
        id: supplierProfileId,
        userId: supplierId,
        email: SUPPLIER_EMAIL,
        status: 'ACTIVE',
      });
      expect(res.body.data.supplier.id).not.toBe(res.body.data.supplier.userId);
    });

    it('GET /suppliers/:id/profile returns 200', async () => {
      const res = await request(app).get(`/api/travioghana/admin/suppliers/${supplierId}/profile`).set(auth());
      expect(res.status).toBe(200);
    });

    it('GET /ai/status returns 200 and counts the brand tours', async () => {
      const res = await request(app).get('/api/travioghana/admin/ai/status').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      // Two raw joins (Tour ⋈ listing table, and Attraction) plus a
      // tourImageAnalysis groupBy — a 200 here means all three really ran.
      expect(res.body.data.tours.total).toBeGreaterThan(0);
      expect(typeof res.body.data.attractions).toBe('object');
      expect(typeof res.body.data.imageAnalysis.total).toBe('number');
    });

    it('GET /ai/failed returns 200', async () => {
      const res = await request(app).get('/api/travioghana/admin/ai/failed').set(auth());
      expect(res.status).toBe(200);
    });

    it('GET /reviews/pending returns 200 and the moderation queue', async () => {
      // No status param means "All" by design (the queue has tabs), so the
      // filter has to be asked for explicitly to prove it exists at all.
      const res = await request(app).get('/api/travioghana/admin/reviews/pending?status=PENDING').set(auth());
      expect(res.status).toBe(200);

      // The one review this suite left awaiting moderation is the one that
      // must be here — and the approved ones must not be.
      const ids = (res.body.data.reviews || []).map((r) => r.id);
      expect(ids).toContain(pendingReviewId);
      expect(ids).not.toContain(approvedReviewId);
      expect(res.body.data.counts.pending).toBe(1);
    });

    it('GET /notifications returns 200', async () => {
      // The admin feed reads the AdminNotification model (not the customer
      // Notification model) so the bell/card show admin-scoped items.
      const res = await request(app).get('/api/travioghana/admin/notifications').set(auth());
      expect(res.status).toBe(200);
    });
  });
});
