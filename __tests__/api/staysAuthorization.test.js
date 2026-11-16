/**
 * Stays authorization matrix — real HTTP, real database, real JWTs.
 *
 * The route-presence check in staysBootstrap proves that an unauthenticated
 * request gets 401. It cannot prove that the supplier scoping works for the
 * three identities that matter:
 *
 *   owner            → sees the supplier's properties
 *   accepted member  → sees them only with stays.view
 *   member w/o it    → 403, not a filtered/empty 200
 *   non-member       → 403 at resolveSupplier, never another supplier's data
 *
 * It also proves the write boundary: a member with stays.view but not
 * stays.bookings cannot create a reservation, while an editor can.
 *
 * Fixtures are keyed on `sauth-` and removed in afterAll.
 */
const request = require('supertest');

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_key, loader) => loader()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
  _clearMemory: jest.fn(),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
  isRedisAvailable: jest.fn(() => Promise.resolve(false)),
}));

const staysApp = require('../../apps/stays-api/app');
const prisma = require('../../src/core/services/prismaClient');
const { signAccessToken } = require('../../config/jwt');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'sauth-';
let serial = 0;
const unique = (label) => {
  serial += 1;
  return `${PREFIX}${label}-${Date.now()}-${serial}`;
};

const V1_STAYS = '/api/v1/travioghana/supplier/stays';
const LEGACY_STAYS = '/api/travioghana/supplier/stays';

let ownerId;
let property;
let editorToken;
let viewerToken;
let noViewToken;
let nonMemberToken;
let ownerToken;

const userIds = [];

async function makeUser(label, roles = ['supplier']) {
  const email = `${unique(label)}@example.test`;
  const user = await prisma.user.create({
    data: {
      firebaseUid: unique(`${label}-uid`),
      email,
      name: `${label} user`,
      roles,
      active: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeMember({ email, roles, role, customRoleId }) {
  return prisma.teamMember.create({
    data: {
      supplierId: ownerId,
      email,
      roles,
      role,
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      ...(customRoleId
        ? { customRoles: { create: { roleId: customRoleId } } }
        : {}),
    },
  });
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

const getProperties = (token, prefix = V1_STAYS) =>
  request(staysApp).get(`${prefix}/properties`).set(auth(token));

const postBooking = (token, body) =>
  request(staysApp).post(`${V1_STAYS}/bookings`).set(auth(token)).send(body);

beforeAll(async () => {
  if (!dbAvailable) return;

  const owner = await makeUser('owner');
  ownerId = owner.id;
  ownerToken = signAccessToken({ userId: ownerId });

  await prisma.supplierProfile.create({
    data: {
      userId: ownerId,
      businessInfo: {},
      operatingInfo: {},
      representativeInfo: {},
      businessDocuments: {},
      payoutInfo: {},
      compliance: {},
    },
  });

  property = await prisma.stayProperty.create({
    data: {
      supplierId: ownerId,
      name: unique('Property'),
      status: 'ACTIVE',
      data: {
        currency: 'GHS',
        rooms: [{ id: 'r1', name: 'Standard Room', count: 2, price: 120 }],
        ratePlans: [{ id: 'plan-r1', roomId: 'r1', name: 'Standard rate', price: 120 }],
      },
    },
  });

  const editor = await makeUser('editor');
  editorToken = signAccessToken({ userId: editor.id });
  await makeMember({ email: editor.email, roles: ['editor'], role: 'editor' });

  // A custom role grants viewing only. `finance` deliberately lacks the stays
  // permissions, so the union is exactly what the custom role adds.
  const viewerRole = await prisma.teamRole.create({
    data: {
      supplierId: ownerId,
      name: 'Stays viewer',
      slug: unique('stays-viewer'),
      permissions: ['stays.view'],
    },
  });
  const viewer = await makeUser('viewer');
  viewerToken = signAccessToken({ userId: viewer.id });
  await makeMember({
    email: viewer.email,
    roles: ['finance'],
    role: 'finance',
    customRoleId: viewerRole.id,
  });

  const noView = await makeUser('noview');
  noViewToken = signAccessToken({ userId: noView.id });
  await makeMember({ email: noView.email, roles: ['finance'], role: 'finance' });

  const nonMember = await makeUser('nonmember');
  nonMemberToken = signAccessToken({ userId: nonMember.id });
});

afterAll(async () => {
  if (!dbAvailable) return;

  await prisma.stayBooking.deleteMany({ where: { propertyId: property.id } });
  await prisma.stayProperty.deleteMany({ where: { id: property.id } });
  await prisma.teamMember.deleteMany({ where: { supplierId: ownerId } });
  await prisma.teamRole.deleteMany({ where: { supplierId: ownerId } });
  await prisma.supplierProfile.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describeDb('Stays authorization matrix', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(staysApp).get(`${V1_STAYS}/properties`);
    expect(res.status).toBe(401);
  });

  it('lets the supplier owner list their properties', async () => {
    const res = await getProperties(ownerToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.properties)).toBe(true);
    expect(res.body.data.properties.some((p) => p.id === property.id)).toBe(true);
  });

  it('lets an accepted editor list properties', async () => {
    const res = await getProperties(editorToken, LEGACY_STAYS);
    expect(res.status).toBe(200);
    expect(res.body.data.properties.some((p) => p.id === property.id)).toBe(true);
  });

  it('lets a member with a custom stays.view role list properties', async () => {
    const res = await getProperties(viewerToken);
    expect(res.status).toBe(200);
    expect(res.body.data.properties.some((p) => p.id === property.id)).toBe(true);
  });

  it('refuses a member without stays.view', async () => {
    const res = await getProperties(noViewToken);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permission/i);
  });

  it('refuses a supplier with no membership or profile', async () => {
    const res = await getProperties(nonMemberToken);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/supplier access required/i);
  });

  it('refuses a view-only member creating a booking', async () => {
    const res = await postBooking(viewerToken, {
      propertyId: property.id,
      roomId: 'r1',
      guestName: 'Permission Test',
      checkIn: '2027-09-10',
      checkOut: '2027-09-12',
      guests: 2,
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permission/i);
    expect(await prisma.stayBooking.count({ where: { propertyId: property.id } })).toBe(0);
  });

  it('lets an editor create a booking on the supplier property', async () => {
    const res = await postBooking(editorToken, {
      propertyId: property.id,
      roomId: 'r1',
      guestName: 'Authorized Editor',
      checkIn: '2027-09-10',
      checkOut: '2027-09-12',
      guests: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.booking.propertyId).toBe(property.id);
  });

  it('does not leak another supplier through the member context', async () => {
    // The member resolves to the owner's supplier only. A property owned by a
    // different supplier must never appear in the list.
    const other = await prisma.user.create({
      data: {
        firebaseUid: unique('other-uid'),
        email: `${unique('other')}@example.test`,
        name: 'Other Supplier',
        roles: ['supplier'],
        active: true,
      },
    });
    userIds.push(other.id);
    await prisma.supplierProfile.create({
      data: {
        userId: other.id,
        businessInfo: {},
        operatingInfo: {},
        representativeInfo: {},
        businessDocuments: {},
        payoutInfo: {},
        compliance: {},
      },
    });
    const otherProperty = await prisma.stayProperty.create({
      data: {
        supplierId: other.id,
        name: unique('Other Property'),
        status: 'ACTIVE',
        data: { currency: 'GHS', rooms: [{ id: 'r1', count: 1, price: 100 }], ratePlans: [] },
      },
    });

    try {
      const res = await getProperties(editorToken);
      expect(res.status).toBe(200);
      expect(res.body.data.properties.some((p) => p.id === otherProperty.id)).toBe(false);
    } finally {
      await prisma.stayProperty.deleteMany({ where: { id: otherProperty.id } });
      await prisma.supplierProfile.deleteMany({ where: { userId: other.id } });
    }
  });
});
