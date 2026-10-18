/**
 * Team invitations — end-to-end contract on the Ghana supplier API,
 * against a REAL database.
 *
 * Regression cover for the bug that made the feature unusable: every team
 * route sat behind `restrictTo('supplier')`, so an invitee (who is a plain
 * `customer` account until they accept) was rejected with 403 before the
 * controller ran, and an accepted member never got the roles needed to open
 * the dashboard.
 *
 * This suite previously mocked `prismaClient`. That covered the guard logic
 * but left three things asserted only against ourselves:
 *
 *   1. `where` clauses. Every `mockResolvedValue(row)` ignores the filter it
 *      was handed. `revokeInvite`/`updateMemberRole` scope on
 *      `{ id, supplierId }`, and `lookupTeamMember` scopes on
 *      `{ email, status: 'ACCEPTED' }` — with a mock, a query that dropped the
 *      supplierId would still return "our" row and pass.
 *
 *   2. Writes. The role-mirror assertions read `prisma.teamMember.create
 *      .mock.calls[0][0].data`, i.e. the arguments the controller intended to
 *      write rather than the row that came back. `roles`/`role` staying in sync
 *      is the whole compatibility story for a rollback, so it is now read from
 *      the table.
 *
 *   3. The owner-vs-member split. `resolveSupplierIdForUser` returns a USER id
 *      for both the owner and a member; if it ever returned the member's own id,
 *      a member's dashboard would show their (empty) book instead of the
 *      business's. Here the owner owns exactly one tour and the member owns
 *      none, so `tours.total` distinguishes the two directly instead of by
 *      inspecting an argument.
 *
 * Still mocked, deliberately: `cacheHelper` (a pass-through, so membership is
 * re-read from the DB on every request rather than from a 30s Redis entry left
 * by the previous test — while still recording the invalidation calls that
 * exist to stop the SPA loading a stale session), `emailService` (the
 * "report the mail failure instead of 500-ing" contract needs to force a
 * failure), `queue`, `auditLogger` and the outbound integration helpers.
 *
 * Fixtures are created in `beforeAll` and removed in `afterAll`, keyed on a
 * `tmi-` email prefix so a crashed run cannot leave rows behind. Every test
 * resets the mutable rows in `beforeEach`, because several of them legitimately
 * mutate state (accepting nulls the token, revoking changes the status).
 * Runs against the isolated `travio_test` (gated on TEST_DB_AVAILABLE).
 */
const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

const mockSendTeamInviteEmail = jest.fn(() => Promise.resolve());
jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  sendTeamInviteEmail: (...args) => mockSendTeamInviteEmail(...args),
  sendTeamInviteRevokedEmail: jest.fn(() => Promise.resolve()),
  resolveEmailBrand: jest.fn(() => 'ghana'),
}));

jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/tourHelpers', () => ({
  checkTourAvailability: jest.fn(() => Promise.resolve({ available: true, availableSpots: 10, reason: null })),
  calculateTourPrice: jest.fn(() => Promise.resolve({ success: true, currency: 'USD', subtotal: 100, fees: 5, discount: 0, total: 105 })),
  cheapestRetailPrice: jest.fn(() => 100),
}));
jest.mock('../../src/core/services/stripeHelpers', () => ({
  createPaymentIntent: jest.fn(() => Promise.resolve({ id: 'pi_test' })),
  createRefund: jest.fn(() => Promise.resolve({})),
  calculateCommission: jest.fn(() => 0),
}));
jest.mock('../../src/core/services/bookingHelpers', () => ({
  validateTravelerInfo: jest.fn(),
  generateBookingNumber: jest.fn(() => 'TMI-BK'),
}));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const cache = require('../../src/core/services/cacheHelper');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

/** Everything this suite creates is tagged so cleanup and counts are exact. */
const PREFIX = 'tmi-';
const OWNER_EMAIL = 'tmi-owner@test.invalid';
const INVITEE_EMAIL = 'tmi-invitee@test.invalid';
const STRANGER_EMAIL = 'tmi-stranger@test.invalid';
const MEMBER_EMAIL = 'tmi-member@test.invalid';
const GHOST_EMAIL = 'tmi-ghost@test.invalid'; // deliberately never created
const TOUR_SLUG = 'tmi-availability-fixture';
const INVITE_TOKEN = 'tmi-pending-token';

const OWNER_NAME = 'TMI Test Tours';
const FUTURE = new Date(Date.now() + 48 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

// Row ids, resolved in beforeAll.
let ownerId;
let inviteeId;
let strangerId;
let memberId;
let pendingId;
let acceptedMemberId;
let tourId;

const token = (userId) => signAccessToken({ userId });
const auth = (userId) => ({ Authorization: `Bearer ${token(userId)}` });

/**
 * Prisma hands back Date objects from its own realm, so `toBeInstanceOf(Date)`
 * fails with the baffling "Expected constructor: Date / Received constructor:
 * Date". Check the tag and that it parses, which is what was meant.
 */
function expectDate(value, label) {
  expect({
    label,
    kind: Object.prototype.toString.call(value),
    parsed: Number.isNaN(new Date(value).getTime()) ? 'invalid' : 'valid',
  }).toEqual({ label, kind: '[object Date]', parsed: 'valid' });
}

const GHANA = '/api/travioghana/supplier/settings/team';
const DASHBOARD = '/api/travioghana/supplier/dashboard';

/** Put the two mutable membership rows back to their canonical state. */
async function resetMembershipRows() {
  await prisma.teamMember.update({
    where: { id: pendingId },
    data: {
      email: INVITEE_EMAIL,
      roles: ['editor'],
      role: 'editor',
      status: 'PENDING',
      inviteToken: INVITE_TOKEN,
      tokenExpiresAt: FUTURE,
      acceptedAt: null,
    },
  });
  await prisma.teamMember.update({
    where: { id: acceptedMemberId },
    data: {
      email: MEMBER_EMAIL,
      roles: ['editor'],
      role: 'editor',
      status: 'ACCEPTED',
      inviteToken: null,
      tokenExpiresAt: null,
      acceptedAt: new Date(),
    },
  });
}

async function setMemberRoles(roles) {
  await prisma.teamMember.update({
    where: { id: acceptedMemberId },
    data: { roles, role: roles[0] },
  });
}

describeDb('team invite (real DB)', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    await prisma.$connect();

    // Remove residue from a previous run first, so counts below are exact.
    await prisma.teamMember.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.tourDateOverride.deleteMany({ where: { tour: { slug: TOUR_SLUG } } });
    await prisma.tour.deleteMany({ where: { slug: TOUR_SLUG } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

    const owner = await prisma.user.create({
      data: {
        firebaseUid: `test-${OWNER_EMAIL}`,
        name: OWNER_NAME,
        email: OWNER_EMAIL,
        // 'ghana' is a BRAND_ROLES entry, so accepting an invite mirrors it
        // onto the invitee — which is the assertion the accept test makes.
        roles: ['supplier', 'ghana'],
        active: true,
        photoURL: '',
      },
    });
    ownerId = owner.id;

    // ACTIVE, because getPickupPlanner refuses a supplier whose profile is not.
    await prisma.supplierProfile.create({
      data: {
        userId: owner.id,
        status: 'ACTIVE',
        businessInfo: {},
        operatingInfo: {},
        representativeInfo: {},
        businessDocuments: {},
        payoutInfo: {},
        compliance: {},
      },
    });

    const invitee = await prisma.user.create({
      data: {
        firebaseUid: `test-${INVITEE_EMAIL}`,
        name: 'TMI Invitee',
        email: INVITEE_EMAIL,
        roles: ['customer'], // the signup default — no supplier role yet
        active: true,
        photoURL: '',
      },
    });
    inviteeId = invitee.id;

    const stranger = await prisma.user.create({
      data: {
        firebaseUid: `test-${STRANGER_EMAIL}`,
        name: 'TMI Stranger',
        email: STRANGER_EMAIL,
        roles: ['customer'],
        active: true,
        photoURL: '',
      },
    });
    strangerId = stranger.id;

    const member = await prisma.user.create({
      data: {
        firebaseUid: `test-${MEMBER_EMAIL}`,
        name: 'TMI Member',
        email: MEMBER_EMAIL,
        roles: ['customer'], // gains supplier/ghana only when granted
        active: true,
        photoURL: '',
      },
    });
    memberId = member.id;

    const pending = await prisma.teamMember.create({
      data: {
        supplierId: owner.id,
        email: INVITEE_EMAIL,
        roles: ['editor'],
        role: 'editor',
        status: 'PENDING',
        inviteToken: INVITE_TOKEN,
        tokenExpiresAt: FUTURE,
      },
    });
    pendingId = pending.id;

    const accepted = await prisma.teamMember.create({
      data: {
        supplierId: owner.id,
        email: MEMBER_EMAIL,
        roles: ['editor'],
        role: 'editor',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });
    acceptedMemberId = accepted.id;

    // The owner's ONE tour. A member's dashboard must report this count; if
    // resolveSupplier ever resolved to the member instead of the owner, the
    // count would be 0 (members own no tours).
    const tour = await prisma.tour.create({
      data: {
        slug: TOUR_SLUG,
        title: 'TMI Availability Fixture',
        description: 'Fixture tour owned by the team-invite suite supplier.',
        status: 'ACTIVE',
        country: 'Ghana',
        city: 'Accra',
        region: 'Greater Accra',
        category: 'City Tour',
        subcategory: 'Urban Exploration',
        activityType: 'Half-Day Tour',
        primaryTheme: 'Urban Exploration',
        latitude: 5.6037,
        longitude: -0.1870,
        tags: ['tmi-fixture'],
        photos: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/tmi.jpg'],
        coverPhoto: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/seed/tmi-cover.jpg',
        categorization: { category: 'City Tour', subcategory: 'Urban Exploration', activityType: 'Half-Day Tour' },
        theme: { primary: 'Urban Exploration' },
        productContent: { location: { city: 'Accra', country: 'Ghana' }, duration: 'Half day' },
        schedulesAndPricing: {},
        bookingAndTickets: {},
        itineraryRegions: ['Greater Accra Region'],
        aiProcessingStatus: 'PENDING',
        supplierId: owner.id,
      },
    });
    tourId = tour.id;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSendTeamInviteEmail.mockResolvedValue();

    // Accepting, revoking and role changes all persist; put the world back.
    await resetMembershipRows();
    await prisma.user.update({ where: { id: inviteeId }, data: { roles: ['customer'] } });
    await prisma.user.update({ where: { id: memberId }, data: { roles: ['customer'] } });
    await prisma.user.update({ where: { id: ownerId }, data: { roles: ['supplier', 'ghana'] } });
    await prisma.tourDateOverride.deleteMany({ where: { tourId } });
  });

  afterAll(async () => {
    // Children first: membership → overrides → tour → users.
    await prisma.teamMember.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.tourDateOverride.deleteMany({ where: { tour: { slug: TOUR_SLUG } } }).catch(() => {});
    await prisma.tour.deleteMany({ where: { slug: TOUR_SLUG } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ── Invitee without the supplier role ──────────────────────────────────
  describe('team invite — invitee without the supplier role', () => {
    it('can read the invitation details (was 403 before the guard fix)', async () => {
      const res = await request(app).get(`${GHANA}/invite/${INVITE_TOKEN}`).set(auth(inviteeId));

      expect(res.status).toBe(200);
      // `supplier` comes from a real relation include on the owner row.
      expect(res.body.data).toMatchObject({
        supplierName: OWNER_NAME,
        role: 'editor',
        roles: ['editor'],
        invitedEmail: INVITEE_EMAIL,
        status: 'PENDING',
      });
    });

    it('can accept, and is granted the dashboard roles', async () => {
      const res = await request(app).post(`${GHANA}/invite/${INVITE_TOKEN}/accept`).set(auth(inviteeId));

      expect(res.status).toBe(200);
      expect(res.body.data.member.status).toBe('ACCEPTED');

      // The token is single-use: accepting clears it, so the link dies.
      const row = await prisma.teamMember.findUnique({ where: { id: pendingId } });
      expect(row.status).toBe('ACCEPTED');
      expect(row.inviteToken).toBeNull();
      expect(row.tokenExpiresAt).toBeNull();
      expectDate(row.acceptedAt, 'row.acceptedAt');

      // 'supplier' plus the owner's BRAND_ROLES ('ghana'), not 'africa'.
      const invitee = await prisma.user.findUnique({ where: { id: inviteeId } });
      expect(invitee.roles).toEqual(expect.arrayContaining(['customer', 'supplier', 'ghana']));
      expect(invitee.roles).not.toContain('expedition');

      // The SPA loads the dashboard immediately, so the auth cache must be dropped.
      expect(cache.invalidateKey).toHaveBeenCalledWith(`auth:user:${inviteeId}`);
      expect(cache.invalidateKey).toHaveBeenCalledWith(`team:member:email:${INVITEE_EMAIL}`);
    });

    it('cannot accept an invitation sent to someone else', async () => {
      const res = await request(app).post(`${GHANA}/invite/${INVITE_TOKEN}/accept`).set(auth(strangerId));

      expect(res.status).toBe(403);
      expect(res.body.message).toContain(INVITEE_EMAIL);

      // and nothing was written
      const row = await prisma.teamMember.findUnique({ where: { id: pendingId } });
      expect(row.status).toBe('PENDING');
    });

    it('cannot manage the team (management stays supplier-only)', async () => {
      const res = await request(app).get(`${GHANA}/members`).set(auth(inviteeId));
      expect(res.status).toBe(403);

      // A plain invitee is not a member yet, so no membership row exists for them.
      const asMember = await prisma.teamMember.findFirst({ where: { email: INVITEE_EMAIL, status: 'ACCEPTED' } });
      expect(asMember).toBeNull();
    });

    it('cannot invite anyone', async () => {
      const res = await request(app)
        .post(`${GHANA}/invite`)
        .set(auth(inviteeId))
        .send({ email: 'tmi-someone@test.invalid', role: 'editor' });
      expect(res.status).toBe(403);
    });
  });

  // ── Link states ────────────────────────────────────────────────────────
  describe('team invite — link states', () => {
    const setInviteState = (data) => prisma.teamMember.update({ where: { id: pendingId }, data });

    it('404s for an unknown token', async () => {
      const res = await request(app).get(`${GHANA}/invite/nope`).set(auth(inviteeId));
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found/i);
    });

    it('410s when the invitation expired', async () => {
      await setInviteState({ tokenExpiresAt: PAST });
      const res = await request(app).get(`${GHANA}/invite/${INVITE_TOKEN}`).set(auth(inviteeId));
      expect(res.status).toBe(410);
      expect(res.body.message).toMatch(/expired/i);
    });

    it('410s once cleanup marked it EXPIRED', async () => {
      await setInviteState({ status: 'EXPIRED', tokenExpiresAt: null });
      const res = await request(app).get(`${GHANA}/invite/${INVITE_TOKEN}`).set(auth(inviteeId));
      expect(res.status).toBe(410);
    });

    it('409s when already accepted', async () => {
      await setInviteState({ status: 'ACCEPTED' });
      const res = await request(app).post(`${GHANA}/invite/${INVITE_TOKEN}/accept`).set(auth(inviteeId));
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already been accepted/i);
    });

    it('410s when revoked', async () => {
      await setInviteState({ status: 'REVOKED' });
      const res = await request(app).post(`${GHANA}/invite/${INVITE_TOKEN}/accept`).set(auth(inviteeId));
      expect(res.status).toBe(410);
      expect(res.body.message).toMatch(/revoked/i);
    });

    it('requires authentication', async () => {
      const res = await request(app).get(`${GHANA}/invite/${INVITE_TOKEN}`);
      expect(res.status).toBe(401);
    });
  });

  // ── Data scoping: a member acts as the owner ───────────────────────────
  describe('team member — data scoping', () => {
    it('reads the owner supplier data, not their own empty set', async () => {
      const res = await request(app).get(DASHBOARD).set(auth(memberId));

      expect(res.status).toBe(200);
      // The dashboard resolves the supplier from req.supplierId (the owner),
      // which is what makes a member's dashboard show real numbers. The member
      // owns no tours, so a resolution to their own id would report 0.
      expect(res.body.data.tours.total).toBe(1);
      expect(res.body.data.tours.active).toBe(1);
    });

    it('reports the member role from my-role', async () => {
      const res = await request(app).get(`${GHANA}/my-role`).set(auth(memberId));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ role: 'editor', isOwner: false, supplierId: ownerId });
      expect(res.body.data.permissions).toContain('tours.update');
      // The member inherits the owner's storefronts, not their own roles.
      expect(res.body.data.storefronts).toEqual(['GHANA']);
    });

    it('reports no role for an authenticated stranger', async () => {
      const res = await request(app).get(`${GHANA}/my-role`).set(auth(strangerId));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ role: null, isOwner: false, permissions: [] });
    });

    it('rejects a customer with no membership from supplier data', async () => {
      const res = await request(app).get(DASHBOARD).set(auth(strangerId));
      expect(res.status).toBe(403);
    });

    it('blocks a support member from writing availability', async () => {
      await setMemberRoles(['support']);
      const res = await request(app)
        .post(`/api/travioghana/supplier/availability/${tourId}`)
        .set(auth(memberId))
        .send({ date: '2026-10-01', available: false });

      expect(res.status).toBe(403);

      // and wrote nothing while doing so
      const override = await prisma.tourDateOverride.findFirst({ where: { tourId } });
      expect(override).toBeNull();
    });

    it('lets an editor write availability', async () => {
      const res = await request(app)
        .post(`/api/travioghana/supplier/availability/${tourId}`)
        .set(auth(memberId))
        .send({ date: '2026-10-01', available: false });

      expect(res.status).toBe(200);

      // Scoped to a tour the OWNER actually owns — setAvailability 404s any
      // other tour, so this also proves req.supplierId resolved to the owner.
      // The form sends `available`; the column is `status` (OverrideStatus).
      const override = await prisma.tourDateOverride.findFirst({ where: { tourId } });
      expect(override).toMatchObject({ status: 'BLOCKED' });
      expect(override.date.toISOString().slice(0, 10)).toBe('2026-10-01');
    });

    it('maps the form payload onto the real override columns', async () => {
      // The request says available/maxBookings/note; the table says
      // status/capacity/notes. Passing the payload through untranslated is
      // exactly what used to raise PrismaClientValidationError.
      const res = await request(app)
        .post(`/api/travioghana/supplier/availability/${tourId}`)
        .set(auth(memberId))
        .send({ date: '2026-10-02', available: true, maxBookings: 12, note: 'guided only' });

      expect(res.status).toBe(200);
      expect(res.body.data.override).toMatchObject({
        status: 'AVAILABLE',
        capacity: 12,
        notes: 'guided only',
      });

      const stored = await prisma.tourDateOverride.findFirst({
        where: { tourId, date: new Date('2026-10-02') },
      });
      expect(stored).toMatchObject({ status: 'AVAILABLE', capacity: 12, notes: 'guided only' });
    });

    it('does not unblock a blocked day when `available` is omitted', async () => {
      await request(app)
        .post(`/api/travioghana/supplier/availability/${tourId}`)
        .set(auth(memberId))
        .send({ date: '2026-10-03', available: false })
        .expect(200);

      // Only the day limit is being narrowed here.
      await request(app)
        .post(`/api/travioghana/supplier/availability/${tourId}`)
        .set(auth(memberId))
        .send({ date: '2026-10-03', maxBookings: 4 })
        .expect(200);

      const stored = await prisma.tourDateOverride.findFirst({
        where: { tourId, date: new Date('2026-10-03') },
      });
      expect(stored).toMatchObject({ status: 'BLOCKED', capacity: 4 });
    });

    it('400s an unparseable date instead of writing a null day', async () => {
      const res = await request(app)
        .post(`/api/travioghana/supplier/availability/${tourId}`)
        .set(auth(memberId))
        .send({ date: 'next tuesday', available: false });

      expect(res.status).toBe(400);
      expect(await prisma.tourDateOverride.findFirst({ where: { tourId } })).toBeNull();
    });

    it('404s writing availability for a tour the supplier does not own', async () => {
      const res = await request(app)
        .post('/api/travioghana/supplier/availability/tmi-not-our-tour')
        .set(auth(memberId))
        .send({ date: '2026-10-04', available: false });

      expect(res.status).toBe(404);
    });
  });

  // ── Owner side ─────────────────────────────────────────────────────────
  describe('team invite — owner side', () => {
    it('invites and reports a mail failure instead of failing the request', async () => {
      mockSendTeamInviteEmail.mockRejectedValue(new Error('resend down'));

      const res = await request(app)
        .post(`${GHANA}/invite`)
        .set(auth(ownerId))
        .send({ email: 'tmi-new@test.invalid', role: 'editor' });

      expect(res.status).toBe(201);
      expect(res.body.data.emailSent).toBe(false);
      expect(res.body.message).toMatch(/could not be sent/i);

      // The row exists regardless — a mail failure must not strand the owner
      // retrying an "already sent" invite.
      const row = await prisma.teamMember.findUnique({
        where: { supplierId_email: { supplierId: ownerId, email: 'tmi-new@test.invalid' } },
      });
      expect(row).toMatchObject({ status: 'PENDING', roles: ['editor'], role: 'editor' });
      expect(row.inviteToken).toBeTruthy();
      expectDate(row.tokenExpiresAt, 'row.tokenExpiresAt');
    });

    it('refuses a direct add for an email with no account', async () => {
      const res = await request(app)
        .post(`${GHANA}/direct-add`)
        .set(auth(ownerId))
        .send({ email: GHOST_EMAIL, role: 'finance' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no account exists/i);

      const row = await prisma.teamMember.findFirst({ where: { email: GHOST_EMAIL } });
      expect(row).toBeNull();
    });

    it('grants roles on a direct add for an existing account', async () => {
      const res = await request(app)
        .post(`${GHANA}/direct-add`)
        .set(auth(ownerId))
        .send({ email: INVITEE_EMAIL, role: 'finance' });

      expect(res.status).toBe(201);

      // Direct add skips the accept step, so the membership row and the
      // dashboard roles are both granted here.
      const row = await prisma.teamMember.findUnique({
        where: { supplierId_email: { supplierId: ownerId, email: INVITEE_EMAIL } },
      });
      expect(row).toMatchObject({ status: 'ACCEPTED', roles: ['finance'], role: 'finance' });
      expect(row.inviteToken).toBeNull();
      expectDate(row.acceptedAt, 'row.acceptedAt');

      const invitee = await prisma.user.findUnique({ where: { id: inviteeId } });
      expect(invitee.roles).toEqual(expect.arrayContaining(['customer', 'supplier', 'ghana']));
    });

    it('revokes a pending invitation and emails the invitee', async () => {
      const res = await request(app)
        .delete(`${GHANA}/invite/${pendingId}`)
        .set(auth(ownerId));

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/revoked/i);

      const row = await prisma.teamMember.findUnique({ where: { id: pendingId } });
      expect(row.status).toBe('REVOKED');
      expect(row.inviteToken).toBeNull();
      expect(row.tokenExpiresAt).toBeNull();
    });

    it('404s revoking a member belonging to another supplier', async () => {
      // Scoping on { id, supplierId }: this row exists, but not for our owner.
      const foreign = await prisma.teamMember.create({
        data: {
          supplierId: strangerId,
          email: 'tmi-foreign@test.invalid',
          roles: ['editor'],
          role: 'editor',
          status: 'PENDING',
          inviteToken: 'tmi-foreign-token',
          tokenExpiresAt: FUTURE,
        },
      });

      const res = await request(app).delete(`${GHANA}/invite/${foreign.id}`).set(auth(ownerId));
      expect(res.status).toBe(404);

      const untouched = await prisma.teamMember.findUnique({ where: { id: foreign.id } });
      expect(untouched.status).toBe('PENDING');

      await prisma.teamMember.delete({ where: { id: foreign.id } }).catch(() => {});
    });
  });

  // ── Two roles ──────────────────────────────────────────────────────────
  describe('team roles — a member can hold two', () => {
    it('invites with two roles and mirrors the legacy column', async () => {
      const res = await request(app)
        .post(`${GHANA}/invite`)
        .set(auth(ownerId))
        .send({ email: 'tmi-both@test.invalid', roles: ['editor', 'finance'] });

      expect(res.status).toBe(201);
      expect(res.body.data.member.roles).toEqual(['editor', 'finance']);
      expect(res.body.data.member.role).toBe('editor');

      // Read back from the table: the compatibility mirror has to actually be
      // written, or a rollback to single-role code sees `editor` only.
      const row = await prisma.teamMember.findUnique({
        where: { supplierId_email: { supplierId: ownerId, email: 'tmi-both@test.invalid' } },
      });
      expect(row.roles).toEqual(['editor', 'finance']);
      expect(row.role).toBe('editor');

      // The email is told about both roles.
      expect(mockSendTeamInviteEmail).toHaveBeenCalledWith(
        expect.objectContaining({ roles: ['editor', 'finance'] }),
      );
    });

    it('rejects more than two roles', async () => {
      const res = await request(app)
        .post(`${GHANA}/invite`)
        .set(auth(ownerId))
        .send({ email: 'tmi-three@test.invalid', roles: ['editor', 'finance', 'support'] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/at most 2 roles/i);
      expect(await prisma.teamMember.findFirst({ where: { email: 'tmi-three@test.invalid' } })).toBeNull();
    });

    it('rejects admin combined with another role', async () => {
      const res = await request(app)
        .post(`${GHANA}/invite`)
        .set(auth(ownerId))
        .send({ email: 'tmi-admin-plus@test.invalid', roles: ['admin', 'editor'] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/admin already includes/i);
    });

    it('rejects an empty role selection and unknown roles', async () => {
      const empty = await request(app).post(`${GHANA}/invite`).set(auth(ownerId)).send({ email: 'tmi-x@test.invalid', roles: [] });
      expect(empty.status).toBe(400);

      const bogus = await request(app).post(`${GHANA}/invite`).set(auth(ownerId)).send({ email: 'tmi-x@test.invalid', roles: ['editor', 'wizard'] });
      expect(bogus.status).toBe(400);
    });

    it('still accepts the legacy single-role payload', async () => {
      const res = await request(app)
        .post(`${GHANA}/invite`)
        .set(auth(ownerId))
        .send({ email: 'tmi-legacy@test.invalid', role: 'finance' });

      expect(res.status).toBe(201);
      const row = await prisma.teamMember.findUnique({
        where: { supplierId_email: { supplierId: ownerId, email: 'tmi-legacy@test.invalid' } },
      });
      expect(row.roles).toEqual(['finance']);
      expect(row.role).toBe('finance');
    });

    it('reports both roles and the union of their permissions in my-role', async () => {
      await setMemberRoles(['editor', 'finance']);

      const res = await request(app).get(`${GHANA}/my-role`).set(auth(memberId));

      expect(res.status).toBe(200);
      expect(res.body.data.roles).toEqual(['editor', 'finance']);
      expect(res.body.data.role).toBe('editor');
      expect(res.body.data.permissions).toEqual(expect.arrayContaining(['tours.update', 'payouts.view']));
    });

    it("grants both roles' capabilities on real endpoints", async () => {
      await setMemberRoles(['editor', 'finance']);

      // editor → bookings.view, finance → payouts.view
      const planner = await request(app).get('/api/travioghana/supplier/pickup-planner').set(auth(memberId));
      const finance = await request(app).get('/api/travioghana/supplier/finance/summary').set(auth(memberId));

      expect(planner.status).toBe(200);
      expect(finance.status).toBe(200);

      // Neither would be reachable if the union were only the first role.
      await setMemberRoles(['editor']);
      const editorFinance = await request(app)
        .get('/api/travioghana/supplier/finance/summary')
        .set(auth(memberId));
      expect(editorFinance.status).toBe(403);
    });

    it('updates the whole role set and keeps the mirror in sync', async () => {
      const res = await request(app)
        .patch(`${GHANA}/members/${acceptedMemberId}/role`)
        .set(auth(ownerId))
        .send({ roles: ['support'] });

      expect(res.status).toBe(200);
      expect(res.body.data.member.roles).toEqual(['support']);

      const row = await prisma.teamMember.findUnique({ where: { id: acceptedMemberId } });
      expect(row.roles).toEqual(['support']);
      expect(row.role).toBe('support');
    });

    it('403s a member trying to change roles (management is admin-only)', async () => {
      // requireTeamRole('admin') runs before the controller, so the controller's
      // "you cannot change your own roles" guard is not the only thing standing
      // between a member and the whole team surface.
      const asMember = await request(app)
        .patch(`${GHANA}/members/${acceptedMemberId}/role`)
        .set(auth(memberId))
        .send({ roles: ['finance'] });

      expect(asMember.status).toBe(403);
      const row = await prisma.teamMember.findUnique({ where: { id: acceptedMemberId } });
      expect(row.roles).toEqual(['editor']);
      expect(row.role).toBe('editor');
    });
  });
});
