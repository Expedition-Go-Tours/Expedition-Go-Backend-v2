/**
 * Expedition storefront — public API contract, against a REAL database.
 *
 * This suite previously mocked `prismaClient`, which made several assertions
 * unfalsifiable:
 *
 *   1. The lookup itself. `looks the tour up by slug OR id` asserted the shape
 *      of a `where` clause handed to `expeditionTour.findFirst`, i.e. that the
 *      code said "OR". Whether it *matched* was never observed: the mocked
 *      `findFirst` answered for any input, including the hardcoded cuid the
 *      legacy-id test sent. Here one tour is fetched by slug and a DIFFERENT
 *      tour by id, and the response says which one came back.
 *
 *   2. Every filter. `getTours` scopes to `status: ACTIVE` + an ACTIVE
 *      supplier profile + an active listing row; `getFeaturedTours` adds
 *      `isFeatured`; `/reviews` adds `status: APPROVED`. A
 *      `mockResolvedValue([row])` ignores all of them, so each test proved
 *      that a filter was constructed, never that it filters. Four fixtures
 *      exist precisely to be excluded: one whose supplier profile is still
 *      PENDING, one not yet published to the storefront, one featured and one
 *      not, and one review still awaiting moderation.
 *
 *   3. The read side of pricing. `startingPrice`/`currency` come from
 *      `cheapestRetailPrice(blob)`, which was mocked to return `undefined` —
 *      so a tour whose pricing blob could not be parsed at all would have
 *      passed. `tourHelpers` and `availabilityCalendar` are therefore the real
 *      modules here; they are business logic, and the assertions below are
 *      anchored to prices this suite wrote itself.
 *
 * Still mocked: `cacheHelper` (a pass-through, so every read hits the database
 * instead of a shared Redis holding a 300s entry from a previous run),
 * `emailService` and `queue` (the contact form must not send), `getConfig`,
 * `viewTracking`, `imageOptimizer` and the checkout-only payment helpers.
 *
 * Fixtures are keyed on an `exp-` prefix and removed in `afterAll`, so a
 * crashed run cannot leave counts behind. Runs against the isolated
 * `travio_test` (gated on TEST_DB_AVAILABLE).
 */
const request = require('supertest');

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
jest.mock('../../src/core/services/stripeHelpers', () => ({
  createPaymentIntent: jest.fn(() => Promise.resolve({ id: 'pi_test' })),
  createRefund: jest.fn(() => Promise.resolve({})),
  calculateCommission: jest.fn(() => 0),
}));
jest.mock('../../src/core/services/bookingHelpers', () => ({
  validateTravelerInfo: jest.fn(() => ({ isValid: true, errors: [] })),
  generateBookingNumber: jest.fn(() => 'EXP-BK-TEST'),
}));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'exp-';
const SUPPLIER_EMAIL = 'exp-supplier@test.invalid';
const PENDING_SUPPLIER_EMAIL = 'exp-pending-supplier@test.invalid';
const CUSTOMER_EMAIL = 'exp-customer@test.invalid';
const NEWSLETTER_EMAIL = 'exp-newsletter@test.invalid';
const NEWSLETTER_EMAIL_2 = 'exp-newsletter-2@test.invalid';

const SLUG_A = 'exp-cultural-cape-coast';
const SLUG_B = 'exp-cultural-kumasi';
const SLUG_UNLISTED = 'exp-unlisted-tour'; // supplier profile still PENDING
const SLUG_UNPUBLISHED = 'exp-unpublished-tour'; // listing row isActive: false

const TITLE_A = 'EXP Cultural Cape Coast';
const TITLE_B = 'EXP Cultural Kumasi';
const RETAIL_PRICE = 50;

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
  photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/exp.jpg'],
  coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/exp-cover.jpg',
  schedulesAndPricing: PRICING,
  bookingAndTickets: {},
  itineraryRegions: ['Greater Accra Region'],
  aiProcessingStatus: 'PENDING',
  categorization: { category: 'Cultural', subcategory: 'Historical Sites', activityType: 'Half-Day Tour' },
  theme: { primary: 'History & Culture' },
  productContent: { location: { city: 'Accra', country: 'Ghana' }, duration: 'Half day' },
};

let supplierId;
let pendingSupplierId;
let customerId;
let tourA;
let tourB;
let tourUnlisted;
let tourUnpublished;
let approvedReviewId;
let pendingReviewId;

async function upsertUser(email, data) {
  return prisma.user.upsert({
    where: { email },
    update: data,
    create: { firebaseUid: `test-${email}`, email, photoURL: '', active: true, ...data },
  });
}

async function upsertTour(slug, data) {
  return prisma.tour.upsert({
    where: { slug },
    update: { ...baseTour, ...data },
    create: { slug, ...baseTour, ...data },
  });
}

async function upsertListing(tourId, data) {
  return prisma.expeditionTour.upsert({
    where: { tourId },
    update: data,
    create: { tourId, ...data },
  });
}

describeDb('Expedition API (real DB)', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    await prisma.$connect();

    // Children first: reviews → listings → tours → subscribers → users.
    await prisma.review.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } });
    await prisma.expeditionTour.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } });
    await prisma.tour.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.newsletterSubscriber.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

    const supplier = await upsertUser(SUPPLIER_EMAIL, {
      name: 'EXP Supplier',
      roles: ['supplier'],
    });
    supplierId = supplier.id;
    await prisma.supplierProfile.upsert({
      where: { userId: supplier.id },
      update: { status: 'ACTIVE' },
      create: {
        userId: supplier.id,
        status: 'ACTIVE',
        businessInfo: {},
        operatingInfo: {},
        representativeInfo: {},
        businessDocuments: {},
        payoutInfo: {},
        compliance: {},
      },
    });

    // Owns SLUG_UNLISTED. The listing is live, but the business has not been
    // approved, so nothing on the storefront may show it.
    const pendingSupplier = await upsertUser(PENDING_SUPPLIER_EMAIL, {
      name: 'EXP Pending Supplier',
      roles: ['supplier'],
    });
    pendingSupplierId = pendingSupplier.id;
    await prisma.supplierProfile.upsert({
      where: { userId: pendingSupplier.id },
      update: { status: 'PENDING' },
      create: {
        userId: pendingSupplier.id,
        status: 'PENDING',
        businessInfo: {},
        operatingInfo: {},
        representativeInfo: {},
        businessDocuments: {},
        payoutInfo: {},
        compliance: {},
      },
    });

    const customer = await upsertUser(CUSTOMER_EMAIL, {
      name: 'EXP Customer',
      roles: ['customer'],
    });
    customerId = customer.id;

    tourA = await upsertTour(SLUG_A, {
      title: TITLE_A,
      description: 'Fixture tour A — featured, with reviews.',
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
      title: 'EXP Unlisted Tour',
      description: 'Live listing on an unapproved supplier.',
      category: 'Cultural',
      city: 'Accra',
      region: 'Greater Accra',
      supplierId: pendingSupplierId,
    });
    tourUnpublished = await upsertTour(SLUG_UNPUBLISHED, {
      title: 'EXP Unpublished Tour',
      description: 'Approved supplier, listing switched off.',
      category: 'Cultural',
      city: 'Accra',
      region: 'Greater Accra',
      supplierId,
    });

    await upsertListing(tourA.id, { isActive: true, isFeatured: true, displayOrder: 1 });
    await upsertListing(tourB.id, { isActive: true, isFeatured: false, displayOrder: 2 });
    await upsertListing(tourUnlisted.id, { isActive: true, isFeatured: false, displayOrder: 3 });
    await upsertListing(tourUnpublished.id, { isActive: false, isFeatured: false, displayOrder: 4 });

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
    const pending = await prisma.review.create({
      data: {
        tourId: tourA.id,
        customerId,
        rating: 1,
        title: 'Awaiting moderation',
        comment: 'Must never appear on the public reviews endpoint.',
        photos: [],
        status: 'PENDING',
      },
    });
    pendingReviewId = pending.id;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await prisma.review.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } }).catch(() => {});
    await prisma.expeditionTour.deleteMany({ where: { tour: { slug: { startsWith: PREFIX } } } }).catch(() => {});
    await prisma.tour.deleteMany({ where: { slug: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.newsletterSubscriber.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ── Public catalogue ───────────────────────────────────────────────────
  describe('GET /api/expedition/tours', () => {
    it('returns both live tours and hides the unapproved supplier', async () => {
      const res = await request(app).get('/api/expedition/tours').expect(200);

      expect(res.body.status).toBe('success');
      const slugs = res.body.data.tours.map((row) => row.tour.slug);

      expect(slugs).toContain(SLUG_A);
      expect(slugs).toContain(SLUG_B);
      // The listing row is active, but the supplier profile is still PENDING —
      // a filter a mockResolvedValue could never enforce.
      expect(slugs).not.toContain(SLUG_UNLISTED);
      // …and this one is an approved supplier whose listing was switched off.
      expect(slugs).not.toContain(SLUG_UNPUBLISHED);

      expect(res.body.pagination.totalCount).toBeGreaterThanOrEqual(2);
      expect(res.body.pagination.currentPage).toBe(1);
    });

    it('prices the listing from the tour pricing blob it stores', async () => {
      const res = await request(app).get('/api/expedition/tours').expect(200);

      const row = res.body.data.tours.find((r) => r.tour.slug === SLUG_A);
      expect(row.tour).toMatchObject({
        id: tourA.id,
        title: TITLE_A,
        startingPrice: RETAIL_PRICE,
        currency: 'USD',
        category: 'Cultural',
      });
    });
  });

  describe('GET /api/expedition/tours/featured', () => {
    it('returns only the tours flagged isFeatured', async () => {
      const res = await request(app).get('/api/expedition/tours/featured').expect(200);

      expect(res.body.status).toBe('success');
      const slugs = res.body.data.tours.map((row) => row.tour.slug);

      expect(slugs).toContain(SLUG_A);
      expect(slugs).not.toContain(SLUG_B);
      expect(slugs).not.toContain(SLUG_UNLISTED);
    });
  });

  describe('GET /api/expedition/tours/:slug', () => {
    it('returns 200 for a slug lookup', async () => {
      const res = await request(app).get(`/api/expedition/tours/${SLUG_A}`).expect(200);

      expect(res.body.status).toBe('success');
      const { data } = res.body;
      // The ExpeditionTour listing row wraps the tour it publishes:
      // data.tour = { id, displayOrder, isFeatured, tour, tourSchema }
      expect(data.tour).toMatchObject({ isFeatured: true, displayOrder: 1 });
      expect(data.tour.tour).toMatchObject({
        id: tourA.id,
        slug: SLUG_A,
        title: TITLE_A,
        startingPrice: RETAIL_PRICE,
        currency: 'USD',
        category: 'Cultural',
        city: 'Cape Coast',
      });
      expect(data.tour.tourSchema.offers).toMatchObject({
        price: RETAIL_PRICE,
        priceCurrency: 'USD',
      });
    });

    it('returns 200 for a tour id lookup (legacy id URLs)', async () => {
      const res = await request(app).get(`/api/expedition/tours/${tourA.id}`).expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.tour.tour).toMatchObject({ id: tourA.id, slug: SLUG_A });
    });

    it('looks the tour up by slug OR id', async () => {
      // Two DIFFERENT tours through the two branches — the mocked version
      // asserted the `where` clause, so it passed whether or not the OR
      // actually matched anything.
      const bySlug = await request(app).get(`/api/expedition/tours/${SLUG_B}`).expect(200);
      const byId = await request(app).get(`/api/expedition/tours/${tourA.id}`).expect(200);

      expect(bySlug.body.data.tour.tour).toMatchObject({ id: tourB.id, slug: SLUG_B });
      expect(byId.body.data.tour.tour).toMatchObject({ id: tourA.id, slug: SLUG_A });
    });

    it('returns 404 when the tour does not resolve', async () => {
      await request(app).get('/api/expedition/tours/exp-does-not-exist').expect(404);
    });

    it('excludes the unpublished listing', async () => {
      await request(app).get(`/api/expedition/tours/${SLUG_UNPUBLISHED}`).expect(404);
    });

    it('excludes the unapproved supplier', async () => {
      await request(app).get(`/api/expedition/tours/${SLUG_UNLISTED}`).expect(404);
    });

    it('counts every review row, moderated or not', async () => {
      const res = await request(app).get(`/api/expedition/tours/${SLUG_A}`).expect(200);

      // `_count: { select: { reviews } }` is deliberately unfiltered — three
      // rows exist (2 APPROVED, 1 PENDING) — whereas `/reviews` below is scoped
      // to APPROVED and reports two. The two numbers can therefore differ.
      expect(res.body.data.tour.tour.reviewCount).toBe(3);
    });
  });

  // ── Contact form ───────────────────────────────────────────────────────
  describe('POST /api/expedition/contact', () => {
    it('returns 200 on valid submission', async () => {
      const res = await request(app)
        .post('/api/expedition/contact')
        .send({ name: 'John', email: 'john@test.com', message: 'Hello, I have a question about your tours.' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('400s an invalid email', async () => {
      const res = await request(app)
        .post('/api/expedition/contact')
        .send({ name: 'John', email: 'not-an-email', message: 'Hello, I have a question about your tours.' });
      expect(res.status).toBe(400);
    });

    it('400s a message below the minimum length', async () => {
      const res = await request(app)
        .post('/api/expedition/contact')
        .send({ name: 'John', email: 'john@test.com', message: 'too short' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/expedition/track-click', () => {
    it('returns 204', async () => {
      const res = await request(app)
        .post('/api/expedition/track-click')
        .send({ event: 'cta', target: SLUG_A });
      expect(res.status).toBe(204);
    });
  });

  // ── Checkout ───────────────────────────────────────────────────────────
  describe('POST /api/expedition/checkout/calculate', () => {
    it('returns 200 on valid request', async () => {
      const res = await request(app)
        .post('/api/expedition/checkout/calculate')
        .send({ tourId: tourA.id, travelDate: '2027-02-15', travelers: { adults: 2 } })
        .expect(200);

      expect(res.body.data.available).toBe(true);
      expect(res.body.data.pricing).toMatchObject({ currency: 'USD' });
      expect(res.body.data.travelerSummary).toMatchObject({ adults: 2, total: 2 });
      // SameForEveryone @ RETAIL_PRICE, per person.
      expect(res.body.data.pricing.subtotal).toBe(RETAIL_PRICE * 2);
      expect(res.body.data.pricing.total).toBe(
        res.body.data.pricing.subtotal + res.body.data.pricing.fees - res.body.data.pricing.discounts,
      );
    });

    it('404s an unknown tour', async () => {
      const res = await request(app)
        .post('/api/expedition/checkout/calculate')
        .send({ tourId: 'exp-no-such-tour', travelDate: '2027-02-15', travelers: { adults: 2 } });

      expect(res.status).toBe(404);
    });

    it('400s a tour whose listing is switched off', async () => {
      // The tour exists and its supplier is approved — only the storefront
      // publication flag is off, which is a different check from the 404 above.
      const res = await request(app)
        .post('/api/expedition/checkout/calculate')
        .send({ tourId: tourUnpublished.id, travelDate: '2027-02-15', travelers: { adults: 2 } });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not available on/i);
    });
  });

  // ── Auth-gated: the gate is the contract ───────────────────────────────
  describe('Expedition API — auth-gated endpoints', () => {
    it('POST /api/expedition/checkout/confirm 401s without auth token', async () => {
      const res = await request(app)
        .post('/api/expedition/checkout/confirm')
        .send({ tourId: tourA.id, travelDate: '2027-02-15', travelers: { adults: 2, phoneNumber: '+123', location: 'Test' }, paymentMethodId: 'pm_123' });
      expect(res.status).toBe(401);
    });

    it('GET /api/expedition/wishlist 401s without auth token', async () => {
      await request(app).get('/api/expedition/wishlist').expect(401);
    });

    it('GET /api/expedition/bookings 401s without auth token', async () => {
      await request(app).get('/api/expedition/bookings').expect(401);
    });

    it('GET /api/expedition/bookings/:id 401s without auth token', async () => {
      await request(app).get('/api/expedition/bookings/booking-1').expect(401);
    });

    it('PATCH /api/expedition/bookings/:id/cancel 401s without auth token', async () => {
      await request(app).patch('/api/expedition/bookings/booking-1/cancel').expect(401);
    });
  });

  // ── Newsletter ─────────────────────────────────────────────────────────
  describe('POST /api/expedition/subscribe', () => {
    it('creates a subscriber on valid email', async () => {
      const res = await request(app)
        .post('/api/expedition/subscribe')
        .send({ email: NEWSLETTER_EMAIL, name: 'John' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Thank you');

      const row = await prisma.newsletterSubscriber.findUnique({ where: { email: NEWSLETTER_EMAIL } });
      expect(row).toMatchObject({ email: NEWSLETTER_EMAIL, name: 'John', subscribed: true });
    });

    it('is idempotent — a repeat subscribe does not create a second row', async () => {
      await request(app).post('/api/expedition/subscribe').send({ email: NEWSLETTER_EMAIL_2 }).expect(200);
      const second = await request(app).post('/api/expedition/subscribe').send({ email: NEWSLETTER_EMAIL_2 });

      expect(second.status).toBe(200);
      expect(second.body.message).toMatch(/already subscribed/i);

      // `email` is @unique, but the branch that answers "already subscribed"
      // is what keeps a re-submit from 500ing on the constraint.
      const rows = await prisma.newsletterSubscriber.findMany({ where: { email: NEWSLETTER_EMAIL_2 } });
      expect(rows).toHaveLength(1);
    });

    it('returns 400 on invalid email', async () => {
      const res = await request(app)
        .post('/api/expedition/subscribe')
        .send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
    });
  });

  // ── Availability ───────────────────────────────────────────────────────
  describe('GET /api/expedition/tours/:slug/availability', () => {
    it('returns 200 with the calendar for a real tour', async () => {
      const res = await request(app)
        .get(`/api/expedition/tours/${SLUG_A}/availability?startDate=2026-11-01&endDate=2026-11-07`);

      expect(res.status).toBe(200);
      // The ExpeditionTour → Tour join, not a stub that answers for any slug.
      expect(res.body.data.tour).toEqual({ id: tourA.id, title: TITLE_A });
      expect(Array.isArray(res.body.data.calendar)).toBe(true);
      expect(res.body.data.startDate).toBe('2026-11-01');
      expect(res.body.data.endDate).toBe('2026-11-07');
    });

    it('returns 404 for non-existent tour', async () => {
      await request(app)
        .get('/api/expedition/tours/exp-non-existent/availability?startDate=2026-11-01&endDate=2026-11-07')
        .expect(404);
    });
  });

  // ── Discovery ──────────────────────────────────────────────────────────
  describe('GET /api/expedition/tours/:slug/reviews', () => {
    it('returns only APPROVED reviews, with a real customer join', async () => {
      const res = await request(app).get(`/api/expedition/tours/${SLUG_A}/reviews`).expect(200);

      expect(res.body.data.totalCount).toBe(2);
      expect(res.body.data.averageRating).toBe(4); // (5 + 3) / 2

      const ids = res.body.data.reviews.map((r) => r.id);
      expect(ids).not.toContain(pendingReviewId);
      expect(ids).toContain(approvedReviewId);

      expect(res.body.data.reviews[0].customer).toMatchObject({
        id: customerId,
        name: 'EXP Customer',
      });
      expect(res.body.pagination).toMatchObject({ currentPage: 1, totalCount: 2 });
    });

    it('returns 404 for non-existent tour', async () => {
      await request(app).get('/api/expedition/tours/exp-non-existent/reviews').expect(404);
    });
  });

  describe('GET /api/expedition/tours/:slug/similar', () => {
    it('returns 200 with similar tours that are not the tour itself', async () => {
      const res = await request(app).get(`/api/expedition/tours/${SLUG_A}/similar`).expect(200);

      const tours = res.body.data.tours;
      expect(tours.length).toBeGreaterThan(0);

      const slugs = tours.map((row) => row.tour.slug);
      expect(slugs).not.toContain(SLUG_A);
      expect(slugs).not.toContain(SLUG_UNLISTED);
      // Same category ('Cultural') is one of the candidate signals.
      expect(slugs).toContain(SLUG_B);
      for (const row of tours) {
        expect(row.tour.title).toBeTruthy();
        expect(row.tour.slug).toBeTruthy();
      }
    });

    it('returns 404 for non-existent tour', async () => {
      await request(app).get('/api/expedition/tours/exp-non-existent/similar').expect(404);
    });
  });
});
