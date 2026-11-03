/**
 * The notification inbox is PER-ACCOUNT, against a REAL database.
 *
 * A member's inbox is their own rows, filtered to the categories assigned to
 * their role — that filter is the permission. The routes additionally required
 * `notifications.view`, so a custom role that had categories assigned but did
 * not carry the view key was refused with a 403 on every poll of the header
 * bell, and the fan-out skipped it entirely: notifications assigned to the
 * role that never arrived, with nothing on screen but "Failed to load".
 *
 * These pin both halves: the inbox opens for such a member and returns only
 * the categories they were assigned, and the fan-out delivers the assigned
 * category while still skipping the one they were not.
 *
 * Fixtures are keyed on a `nin-` prefix and removed in `afterAll`.
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
const notificationService = require('../../src/core/services/notificationService');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'nin-';
const LIST = '/api/travioghana/supplier/notifications';

let owner;
let member;
let token;
let memberUserId;

const emailFor = (name) => `${PREFIX}${name}@example.test`;

async function upsertUser(name, data) {
  return prisma.user.upsert({
    where: { email: emailFor(name) },
    update: data,
    // firebaseUid is unique across the WHOLE database, and every DB-gated
    // suite runs against the same test database: `test-owner` would collide
    // with the other suites' owners and fail the create.
    create: { firebaseUid: `${PREFIX}${name}`, email: emailFor(name), photoURL: '', active: true, ...data },
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

describeDb('notification inbox without notifications.view (real DB)', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    await prisma.$connect();

    owner = await upsertUser('owner', { name: 'NIN Owner', roles: ['supplier'] });
    member = await upsertUser('member', { name: 'NIN Member', roles: ['customer'] });
    await upsertProfile(owner);
    memberUserId = member.id;

    // A custom role with the inbox categories assigned but WITHOUT the
    // `notifications.view` key — the exact shape the role builder can save.
    const teamMember = await prisma.teamMember.upsert({
      where: { supplierId_email: { supplierId: owner.id, email: emailFor('member') } },
      update: { roles: [], role: '', notificationCategories: ['bookings'], status: 'ACCEPTED' },
      create: {
        supplierId: owner.id,
        email: emailFor('member'),
        roles: [],
        role: '',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        notificationCategories: ['bookings'],
      },
    });

    const existingRole = await prisma.teamRole.findFirst({
      where: { supplierId: owner.id, slug: `${PREFIX}reader` },
    });
    const customRole = existingRole || await prisma.teamRole.create({
      data: {
        supplierId: owner.id,
        name: 'NIN Reader',
        slug: `${PREFIX}reader`,
        permissions: ['bookings.view'],
        notificationCategories: ['bookings'],
      },
    });
    await prisma.teamMemberRole.upsert({
      where: { memberId_roleId: { memberId: teamMember.id, roleId: customRole.id } },
      update: {},
      create: { memberId: teamMember.id, roleId: customRole.id },
    });

    await prisma.notification.deleteMany({ where: { userId: memberUserId, title: { startsWith: PREFIX } } });
    await prisma.notification.createMany({
      data: [
        {
          userId: memberUserId,
          type: 'BOOKING_CONFIRMED',
          title: `${PREFIX}assigned`,
          message: 'A category this role was assigned',
        },
        {
          userId: memberUserId,
          type: 'REVIEW_RECEIVED',
          title: `${PREFIX}unassigned`,
          message: 'A category this role was not assigned',
        },
      ],
    });

    token = signAccessToken({ userId: memberUserId });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: memberUserId, title: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.teamMember.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.teamRole.deleteMany({ where: { slug: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.supplierProfile.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => {});
    await prisma.$disconnect();
  });

  const fetchInbox = () =>
    request(app).get(LIST).set({ Authorization: `Bearer ${token}` }).query({ limit: 50 });

  const titlesIn = (res) => res.body.data.notifications.map((n) => n.title);

  it('opens the inbox for a member without notifications.view', async () => {
    const res = await fetchInbox();

    // Before the guard came off this was a 403 on every poll of the bell.
    expect(res.status).toBe(200);
    expect(titlesIn(res)).toContain(`${PREFIX}assigned`);
  });

  it('returns only the categories assigned to the role', async () => {
    const res = await fetchInbox();

    expect(res.status).toBe(200);
    expect(titlesIn(res)).toContain(`${PREFIX}assigned`);
    expect(titlesIn(res)).not.toContain(`${PREFIX}unassigned`);
  });

  it('delivers the assigned category to that member, and skips the one it was not', async () => {
    await notificationService.fanOutToTeamMembers({
      userId: owner.id,
      type: 'BOOKING_CONFIRMED',
      title: `${PREFIX}fanout-assigned`,
      message: 'Delivered by the fan-out',
    });
    await notificationService.fanOutToTeamMembers({
      userId: owner.id,
      type: 'REVIEW_RECEIVED',
      title: `${PREFIX}fanout-unassigned`,
      message: 'Must not be delivered',
    });

    const rows = await prisma.notification.findMany({
      where: { userId: memberUserId, title: { startsWith: `${PREFIX}fanout` } },
      select: { title: true },
    });
    const delivered = rows.map((row) => row.title);

    expect(delivered).toContain(`${PREFIX}fanout-assigned`);
    expect(delivered).not.toContain(`${PREFIX}fanout-unassigned`);
  });

  it('leaves the mark-all-read path working (it reads the same team context)', async () => {
    const res = await request(app)
      .patch(`${LIST}/mark-all-read`)
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);

    const unread = await prisma.notification.count({
      where: { userId: memberUserId, readAt: null, title: { startsWith: `${PREFIX}assigned` } },
    });
    expect(unread).toBe(0);
  });
});
