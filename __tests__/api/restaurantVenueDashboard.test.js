/**
 * Owner dashboard — end-to-end contract against a REAL database.
 *
 * This is an endpoint smoke suite, not a service-level test. It drives the
 * Express app with signed tokens and checks that writes land in the database
 * and in the public projection. It covers the paths the dashboard actually
 * uses: membership scoping, business info/hours, replies and moderation, photo
 * moderation, structured menus, team invites, activity sanitization and
 * insights.
 *
 * Mocks are limited to outbound side effects (queue, mail, upload) and the
 * cache, which is made pass-through so each read hits the database. Audit
 * logging stays real: the activity assertions are meant to prove the feed
 * drops endpoint/IP/user-agent/hash metadata that the logger records.
 *
 * Every row is tagged with `rdv-smoke-` and removed in afterAll. Runs against
 * the isolated `travio_test` (gated on TEST_DB_AVAILABLE).
 */
const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

const mockVenuePhotoUrl =
  'https://res.cloudinary.com/travio/image/upload/v1/rdv-smoke/dining-room.jpg';
const mockSentMail = jest.fn(() => Promise.resolve());

jest.mock('../../src/core/services/cacheHelper', () => {
  const actual = jest.requireActual('../../src/core/services/cacheHelper');
  return {
    ...actual,
    getOrSet: jest.fn(async (_key, fetchFn) => fetchFn()),
    invalidateKey: jest.fn(async () => {}),
    invalidateKeys: jest.fn(async () => {}),
    invalidateRestaurantVenueCaches: jest.fn(async () => {}),
    invalidateHomepageSections: jest.fn(async () => {}),
  };
});

jest.mock('../../src/core/services/queue', () => ({
  QUEUE_NAMES: {},
  SCHEDULES: {},
  enqueueEvent: jest.fn(async () => {}),
  enqueueEmail: jest.fn(async () => {}),
  enqueueNotification: jest.fn(async () => {}),
  enqueueAggregation: jest.fn(async () => {}),
  enqueueCleanup: jest.fn(async () => {}),
  enqueueCreateStripeCustomer: jest.fn(async () => {}),
  enqueueWebhookRetry: jest.fn(async () => {}),
  enqueuePaypalWebhookRetry: jest.fn(async () => {}),
  enqueueContentSync: jest.fn(async () => {}),
  enqueueHomepagePrecompute: jest.fn(async () => {}),
  enqueueAiScoring: jest.fn(async () => {}),
  enqueueGhanaPublish: jest.fn(async () => {}),
  enqueueTravioAfricaPublish: jest.fn(async () => {}),
}));

jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(async () => {}),
  sendHtml: (...args) => mockSentMail(...args),
  resolveEmailBrand: jest.fn(() => 'ghana'),
}));

jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(async () => {}),
  emitToRoom: jest.fn(),
  getNotifications: jest.fn(async () => []),
  acknowledgeNotification: jest.fn(async () => {}),
  acknowledgeAll: jest.fn(async () => {}),
  getStats: jest.fn(async () => ({})),
  formatFields: jest.fn((fields) => fields),
}));

jest.mock('../../src/core/services/getConfig', () => jest.fn(async (_key, fallback) => fallback));

jest.mock('../../src/core/services/tourHelpers', () => ({
  checkTourAvailability: jest.fn(async () => ({ available: true, availableSpots: 10, reason: null })),
  calculateTourPrice: jest.fn(async () => ({
    success: true,
    currency: 'USD',
    subtotal: 100,
    fees: 5,
    discount: 0,
    total: 105,
  })),
  cheapestRetailPrice: jest.fn(() => 100),
}));

jest.mock('../../src/core/services/stripeHelpers', () => ({
  createPaymentIntent: jest.fn(async () => ({ id: 'pi_test' })),
  createRefund: jest.fn(async () => ({})),
  calculateCommission: jest.fn(() => 0),
}));

jest.mock('../../src/core/services/bookingHelpers', () => ({
  validateTravelerInfo: jest.fn(),
  generateBookingNumber: jest.fn(() => 'RDV-BK'),
}));

jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

jest.mock('../../middleware/uploadMiddleware', () => {
  const actual = jest.requireActual('../../middleware/uploadMiddleware');
  return {
    ...actual,
    uploadVenuePhotos: (req, _res, next) => {
      req.files = [{ path: mockVenuePhotoUrl }];
      next();
    },
  };
});

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'rdv-smoke-';
const SLUG = `${PREFIX}primary`;
const OTHER_SLUG = `${PREFIX}other`;
const PAUSED_SLUG = `${PREFIX}paused`;

const OWNER_EMAIL = `${PREFIX}owner@test.invalid`;
const MANAGER_EMAIL = `${PREFIX}manager@test.invalid`;
const REVIEWER_EMAIL = `${PREFIX}reviewer@test.invalid`;
const INVITEE_EMAIL = `${PREFIX}invitee@test.invalid`;
const STRANGER_EMAIL = `${PREFIX}stranger@test.invalid`;
const OTHER_OWNER_EMAIL = `${PREFIX}other-owner@test.invalid`;

const OWNER_ROUTE = `/api/restaurant-venues/${SLUG}`;
const DASHBOARD_ROUTE = `${OWNER_ROUTE}/dashboard`;
const ADMIN_ROUTE = '/api/admin/restaurant-venues';

let ownerId;
let managerId;
let reviewerId;
let inviteeId;
let strangerId;
let venueId;
let otherVenueId;
let pausedVenueId;
let reviewId;
let adminId;
let ownerMemberId;
let inviteeMemberId;

const token = (userId) => signAccessToken({ userId });
const auth = (userId) => ({ Authorization: `Bearer ${token(userId)}` });

async function createUser(email, name) {
  const user = await prisma.user.create({
    data: {
      firebaseUid: `test-${email}`,
      name,
      email,
      roles: ['customer'],
      active: true,
      photoURL: '',
    },
  });
  return user.id;
}

async function createVenue(slug, name, status) {
  const venue = await prisma.restaurantVenue.create({
    data: {
      slug,
      name,
      status,
      city: 'Accra',
      region: 'Greater Accra',
      cuisines: ['Ghanaian'],
      listings: {
        create: { brand: 'ghana', isActive: true },
      },
    },
  });
  return venue.id;
}

async function publicVenue() {
  const res = await request(app).get(`${OWNER_ROUTE}?brand=ghana`);
  expect(res.status).toBe(200);
  return res.body.data.venue;
}

describeDb('restaurant owner dashboard (real DB, real HTTP)', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    await prisma.$connect();

    // Remove residue from an interrupted run before creating fixtures.
    for (const slug of [SLUG, OTHER_SLUG, PAUSED_SLUG]) {
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { resourceId: slug },
            { metadata: { path: ['venueId'], equals: slug } },
          ],
        },
      });
      await prisma.restaurantVenue.deleteMany({ where: { slug } });
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

    [ownerId, managerId, reviewerId, inviteeId, strangerId] = await Promise.all([
      createUser(OWNER_EMAIL, 'RDV Smoke Owner'),
      createUser(MANAGER_EMAIL, 'RDV Smoke Manager'),
      createUser(REVIEWER_EMAIL, 'RDV Smoke Reviewer'),
      createUser(INVITEE_EMAIL, 'RDV Smoke Invitee'),
      createUser(STRANGER_EMAIL, 'RDV Smoke Stranger'),
    ]);
    const otherOwnerId = await createUser(OTHER_OWNER_EMAIL, 'RDV Smoke Other Owner');

    [venueId, otherVenueId, pausedVenueId] = await Promise.all([
      createVenue(SLUG, 'RDV Smoke Kitchen', 'ACTIVE'),
      createVenue(OTHER_SLUG, 'RDV Smoke Other Kitchen', 'ACTIVE'),
      createVenue(PAUSED_SLUG, 'RDV Smoke Paused Kitchen', 'PAUSED'),
    ]);

    for (const [venue, userId, role] of [
      [venueId, ownerId, 'OWNER'],
      [venueId, managerId, 'MANAGER'],
      [otherVenueId, otherOwnerId, 'OWNER'],
      [pausedVenueId, ownerId, 'OWNER'],
    ]) {
      const member = await prisma.restaurantVenueMember.create({
        data: { venueId: venue, userId, role, status: 'ACTIVE' },
      });
      if (venue === venueId && role === 'OWNER') ownerMemberId = member.id;
    }

    const review = await prisma.restaurantVenueReview.create({
      data: {
        venueId,
        authorId: reviewerId,
        rating: 2,
        title: 'Cold lunch',
        body: 'The food arrived cold and nobody checked on us.',
        visitKey: `${PREFIX}visit`,
        status: 'APPROVED',
        moderatedAt: new Date(),
      },
    });
    reviewId = review.id;

    const admin = await prisma.user.findUnique({
      where: { email: 'expdeveloper2@gmail.com' },
      select: { id: true, roles: true, adminRoleId: true },
    });
    if (!admin || !admin.roles.includes('admin') || !admin.adminRoleId) {
      throw new Error('Seeded super admin is missing; run npm run test:db:up first');
    }
    adminId = admin.id;
  });

  afterAll(async () => {
    for (const venue of [venueId, otherVenueId, pausedVenueId].filter(Boolean)) {
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { resourceId: venue },
            { metadata: { path: ['venueId'], equals: venue } },
          ],
        },
      });
    }
    await prisma.restaurantVenue.deleteMany({
      where: { slug: { startsWith: PREFIX } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  it('scopes dashboard access by active membership and role', async () => {
    const owner = await request(app).get(`${DASHBOARD_ROUTE}?brand=ghana`).set(auth(ownerId));
    expect(owner.status).toBe(200);
    expect(owner.body.data.session.membership.role).toBe('OWNER');
    expect(owner.body.data.session.permissions).toContain('team.manage');
    expect(owner.body.data.session.venue.slug).toBe(SLUG);

    const manager = await request(app)
      .get(`${DASHBOARD_ROUTE}/session?brand=ghana`)
      .set(auth(managerId));
    expect(manager.status).toBe(200);
    expect(manager.body.data.membership.role).toBe('MANAGER');
    expect(manager.body.data.permissions).toContain('reviews.reply');
    expect(manager.body.data.permissions).not.toContain('team.manage');

    const stranger = await request(app).get(`${DASHBOARD_ROUTE}?brand=ghana`).set(auth(strangerId));
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe('NOT_A_VENUE_MEMBER');

    const otherVenue = await request(app)
      .get(`/api/restaurant-venues/${OTHER_SLUG}/dashboard?brand=ghana`)
      .set(auth(ownerId));
    expect(otherVenue.status).toBe(403);

    // A paused listing is still editable through the authenticated dashboard.
    const paused = await request(app)
      .get(`/api/restaurant-venues/${PAUSED_SLUG}/dashboard/session?brand=ghana`)
      .set(auth(ownerId));
    expect(paused.status).toBe(200);
    expect(paused.body.data.venue.status).toBe('PAUSED');
  });

  it('publishes business info and hours immediately, and permits ACTIVE/PAUSED only', async () => {
    const hours = {
      monday: { open: '09:00', close: '21:00' },
      tuesday: { open: '09:00', close: '21:00' },
    };
    const patched = await request(app)
      .patch(OWNER_ROUTE)
      .set(auth(ownerId))
      .send({
        description: 'A real description from the owner dashboard.',
        phone: '+233 30 000 0000',
        website: 'https://example.com/restaurant',
        menuUrl: 'https://example.com/menu',
        hours,
        cuisines: ['Ghanaian', 'Continental'],
      });
    expect(patched.status).toBe(200);

    const detail = await publicVenue();
    expect(detail.description).toBe('A real description from the owner dashboard.');
    expect(detail.hours).toEqual(hours);
    expect(detail.menuUrl).toBe('https://example.com/menu');
    expect(detail.cuisines).toContain('Continental');

    const managerHours = { ...hours, wednesday: { open: '11:00', close: '20:00' } };
    const byManager = await request(app)
      .patch(OWNER_ROUTE)
      .set(auth(managerId))
      .send({ hours: managerHours });
    expect(byManager.status).toBe(200);
    expect((await publicVenue()).hours).toEqual(managerHours);

    const paused = await request(app)
      .patch(OWNER_ROUTE)
      .set(auth(ownerId))
      .send({ status: 'PAUSED' });
    expect(paused.status).toBe(200);
    expect((await request(app).get(`${DASHBOARD_ROUTE}/session?brand=ghana`).set(auth(ownerId))).status).toBe(200);

    const resumed = await request(app)
      .patch(OWNER_ROUTE)
      .set(auth(ownerId))
      .send({ status: 'ACTIVE' });
    expect(resumed.status).toBe(200);
    const resumedRow = await prisma.restaurantVenue.findUnique({
      where: { id: venueId },
      select: { status: true },
    });
    expect(resumedRow.status).toBe('ACTIVE');
    expect((await publicVenue()).id).toBe(venueId);
  });

  it('rejects bad replies, moderates replies and records an owner report', async () => {
    const list = await request(app)
      .get(`${DASHBOARD_ROUTE}/reviews?brand=ghana`)
      .set(auth(ownerId));
    expect(list.status).toBe(200);
    expect(list.body.data.reviews).toHaveLength(1);
    expect(list.body.data.reviews[0].id).toBe(reviewId);
    expect(list.body.data.reviews[0].response).toBeNull();

    const withLink = await request(app)
      .post(`${DASHBOARD_ROUTE}/reviews/${reviewId}/responses?brand=ghana`)
      .set(auth(ownerId))
      .send({ body: 'Please visit https://example.com to make this right for you.' });
    expect(withLink.status).toBe(400);
    expect(withLink.body.code).toBe('REPLY_CONTAINS_URL');

    const withEmail = await request(app)
      .post(`${DASHBOARD_ROUTE}/reviews/${reviewId}/responses?brand=ghana`)
      .set(auth(ownerId))
      .send({ body: 'Write to manager@example.com and we will fix this immediately.' });
    expect(withEmail.status).toBe(400);
    expect(withEmail.body.code).toBe('REPLY_CONTAINS_EMAIL');

    const replyBody = 'We are sorry the meal arrived cold. We have spoken with the kitchen team.';
    const created = await request(app)
      .post(`${DASHBOARD_ROUTE}/reviews/${reviewId}/responses?brand=ghana`)
      .set(auth(ownerId))
      .send({ body: replyBody });
    expect(created.status).toBe(201);
    const responseId = created.body.data.response.id;
    expect(created.body.data.response.status).toBe('PENDING');

    const pendingOwner = await request(app)
      .get(`${DASHBOARD_ROUTE}/reviews?filter=pending&brand=ghana`)
      .set(auth(ownerId));
    expect(pendingOwner.body.data.reviews).toHaveLength(1);

    const pendingAdmin = await request(app)
      .get(`${ADMIN_ROUTE}/responses/pending?limit=50`)
      .set(auth(adminId));
    expect(pendingAdmin.status).toBe(200);
    expect(pendingAdmin.body.data.responses.some((row) => row.id === responseId)).toBe(true);

    const published = await request(app)
      .patch(`${ADMIN_ROUTE}/responses/${responseId}/moderate`)
      .set(auth(adminId))
      .send({ action: 'publish' });
    expect(published.status).toBe(200);
    expect(published.body.data.response.status).toBe('PUBLISHED');

    const afterPublish = await request(app)
      .get(`${DASHBOARD_ROUTE}/reviews/${reviewId}?brand=ghana`)
      .set(auth(ownerId));
    expect(afterPublish.body.data.review.response.status).toBe('PUBLISHED');

    const removed = await request(app)
      .delete(`${DASHBOARD_ROUTE}/responses/${responseId}?brand=ghana`)
      .set(auth(ownerId));
    expect(removed.status).toBe(200);
    expect(removed.body.data.response.status).toBe('REMOVED');

    const replacement = await request(app)
      .post(`${DASHBOARD_ROUTE}/reviews/${reviewId}/responses?brand=ghana`)
      .set(auth(ownerId))
      .send({ body: 'We have changed our check process and hope you will give us another try.' });
    expect(replacement.status).toBe(201);

    const report = await request(app)
      .post(`${OWNER_ROUTE}/reviews/${reviewId}/report?brand=ghana`)
      .set(auth(ownerId))
      .send({ reason: 'Contested', detail: 'The visit details do not match our records.' });
    expect(report.status).toBe(201);
    expect(report.body.data.report.reviewId).toBe(reviewId);
    const reportRow = await prisma.restaurantVenueReviewReport.findUnique({
      where: { id: report.body.data.report.id },
      select: { review: { select: { venueId: true } } },
    });
    expect(reportRow.review.venueId).toBe(venueId);
  });

  it('keeps owner photos moderated and publishes the table into the storefront projection', async () => {
    const before = await publicVenue();
    expect(before.photos).toHaveLength(0);

    const uploaded = await request(app)
      .post(`${DASHBOARD_ROUTE}/photos?brand=ghana`)
      .set(auth(ownerId))
      .attach('photos', Buffer.from('not-a-real-image'), 'dining-room.jpg');
    expect(uploaded.status).toBe(201);
    const photoId = uploaded.body.data.photos[0].id;
    expect(uploaded.body.data.photos[0].status).toBe('PENDING');
    expect((await publicVenue()).photos).toHaveLength(0);

    const pendingAdmin = await request(app)
      .get(`${ADMIN_ROUTE}/photos/pending?limit=100`)
      .set(auth(adminId));
    expect(pendingAdmin.status).toBe(200);
    expect(pendingAdmin.body.data.photos.some((row) => row.id === photoId)).toBe(true);

    const published = await request(app)
      .patch(`${ADMIN_ROUTE}/photos/${photoId}/moderate`)
      .set(auth(adminId))
      .send({ action: 'publish' });
    expect(published.status).toBe(200);

    const after = await publicVenue();
    expect(after.photos).toEqual([mockVenuePhotoUrl]);
    expect(after.coverPhoto).toBe(mockVenuePhotoUrl);
  });

  it('saves a structured menu and publishes it to the public detail without losing menuUrl', async () => {
    const menuPayload = {
      name: 'Main menu',
      currency: 'GHS',
      sections: [
        {
          title: 'Mains',
          items: [
            { name: 'Jollof', description: 'Smoky party jollof', priceMinor: 1250, dietary: [] },
            { name: 'Soup of the day', priceMinor: null },
          ],
        },
      ],
    };
    const saved = await request(app)
      .put(`${DASHBOARD_ROUTE}/menu?brand=ghana`)
      .set(auth(ownerId))
      .send(menuPayload);
    expect(saved.status).toBe(200);
    const menuId = saved.body.data.menu.id;
    expect(saved.body.data.menu.status).toBe('DRAFT');
    expect((await publicVenue()).menus).toHaveLength(0);

    const published = await request(app)
      .post(`${DASHBOARD_ROUTE}/menu/${menuId}/publish?brand=ghana`)
      .set(auth(ownerId));
    expect(published.status).toBe(200);

    const detail = await publicVenue();
    expect(detail.menuUrl).toBe('https://example.com/menu');
    expect(detail.menus).toHaveLength(1);
    expect(detail.menus[0].currency).toBe('GHS');
    expect(detail.menus[0].sections[0].items[0].priceMinor).toBe(1250);
    expect(detail.menus[0].sections[0].items[1].priceMinor).toBeNull();
  });

  it('returns real insights and sanitizes the venue activity feed', async () => {
    await prisma.auditLog.create({
      data: {
        userId: ownerId,
        action: 'restaurantVenue.updatedByOwner',
        resource: 'RestaurantVenue',
        resourceId: venueId,
        metadata: {
          venueId,
          fields: ['hours'],
          ipAddress: '203.0.113.9',
          userAgent: 'rdv-smoke-agent',
          endpoint: { method: 'PATCH', url: OWNER_ROUTE },
          hash: 'rdv-smoke-hash',
        },
      },
    });

    const insights = await request(app)
      .get(`${DASHBOARD_ROUTE}/insights?days=30&brand=ghana`)
      .set(auth(ownerId));
    expect(insights.status).toBe(200);
    expect(insights.body.data.current.count).toBe(1);
    expect(insights.body.data.current.averageRating).toBe(2);
    expect(insights.body.data.current.negative).toBe(1);
    expect(insights.body.data.hasData).toBe(true);
    expect(JSON.stringify(insights.body.data)).not.toMatch(/\bviews\b|competitor|impressions?\b/i);

    const activity = await request(app)
      .get(`${DASHBOARD_ROUTE}/activity?type=hours&brand=ghana`)
      .set(auth(ownerId));
    expect(activity.status).toBe(200);
    expect(activity.body.data.activity.length).toBeGreaterThan(0);
    for (const item of activity.body.data.activity) {
      expect(item.details.fields).toContain('hours');
    }
    const serialized = JSON.stringify(activity.body.data.activity);
    for (const leaked of ['ipAddress', 'userAgent', 'endpoint', 'hash', 'venueId', '203.0.113.9']) {
      expect(serialized).not.toContain(leaked);
    }

    const otherActivity = await request(app)
      .get(`/api/restaurant-venues/${OTHER_SLUG}/dashboard/activity?brand=ghana`)
      .set(auth(ownerId));
    expect(otherActivity.status).toBe(403);
  });

  it('invites, accepts and transfers ownership with owner-only guards', async () => {
    mockSentMail.mockClear();

    const invited = await request(app)
      .post(`${DASHBOARD_ROUTE}/team/invites?brand=ghana`)
      .set(auth(ownerId))
      .send({ email: INVITEE_EMAIL, role: 'MANAGER' });
    expect(invited.status).toBe(201);
    expect(invited.body.data.invite.status).toBe('PENDING');
    expect(invited.body.data.invite.tokenHash).toBeUndefined();

    const mail = mockSentMail.mock.calls.find(([args]) => args.to === INVITEE_EMAIL);
    expect(mail).toBeDefined();
    const tokenMatch = mail[0].text.match(/token=([^)\s]+)/);
    expect(tokenMatch).toBeTruthy();
    const inviteToken = tokenMatch[1];

    const mismatch = await request(app)
      .post('/api/restaurant-venues/team/invites/accept')
      .set(auth(strangerId))
      .send({ token: inviteToken });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe('INVITE_EMAIL_MISMATCH');

    const accepted = await request(app)
      .post('/api/restaurant-venues/team/invites/accept')
      .set(auth(inviteeId))
      .send({ token: inviteToken });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.membership.role).toBe('MANAGER');
    inviteeMemberId = accepted.body.data.membership.id;

    const team = await request(app).get(`${DASHBOARD_ROUTE}/team?brand=ghana`).set(auth(ownerId));
    expect(team.status).toBe(200);
    expect(team.body.data.members.some((row) => row.id === inviteeMemberId)).toBe(true);

    const managerInvite = await request(app)
      .post(`${DASHBOARD_ROUTE}/team/invites?brand=ghana`)
      .set(auth(inviteeId))
      .send({ email: STRANGER_EMAIL });
    expect(managerInvite.status).toBe(403);
    expect(managerInvite.body.code).toBe('VENUE_OWNER_ONLY');

    const lastOwner = await request(app)
      .patch(`${DASHBOARD_ROUTE}/team/members/${ownerMemberId}?brand=ghana`)
      .set(auth(ownerId))
      .send({ role: 'MANAGER' });
    expect(lastOwner.status).toBe(409);
    expect(lastOwner.body.code).toBe('LAST_OWNER');

    const transferred = await request(app)
      .post(`${DASHBOARD_ROUTE}/team/members/${inviteeMemberId}/transfer?brand=ghana`)
      .set(auth(ownerId));
    expect(transferred.status).toBe(200);
    expect(transferred.body.data.ownerMemberId).toBe(inviteeMemberId);

    const oldOwner = await request(app)
      .get(`${DASHBOARD_ROUTE}/session?brand=ghana`)
      .set(auth(ownerId));
    expect(oldOwner.body.data.membership.role).toBe('MANAGER');
    expect(oldOwner.body.data.permissions).not.toContain('team.manage');
  });
});
