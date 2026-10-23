/**
 * `/settings/team/my-role` reports which storefronts the BUSINESS is live on,
 * so the supplier dashboard's "Live Site" control can offer a choice.
 *
 * The trap this file guards: `TeamMember.supplierId` is a User id, while the
 * owner branch returns a SupplierProfile id — same field name, two meanings.
 * And a member's own roles are always `['customer']`, because 'expedition' is
 * not in BRAND_ROLES and is therefore never inherited. The answer has to come
 * from the OWNER in every branch, or team members silently lose the menu.
 *
 * The previous version mocked `prismaClient` and drove both branches by
 * hand-setting `supplierProfile.findFirst` / `teamMember.findFirst`. That
 * reproduced the controller's OWN reading of the schema, so the trap could only
 * have been caught by the person writing the mock: `supplier: { roles }` in the
 * member branch is a relation include on `TeamMember.supplier`, and if that
 * relation resolved to something other than the owner User the stub would still
 * have returned whatever it was told to.
 *
 * Everything here is now created for real — two owner accounts each holding an
 * actual SupplierProfile, three separate members, and one admin — so both
 * meanings of `supplierId` are asserted against rows the database produced.
 */

const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

// Reads must reach the database rather than a shared Redis holding an entry
// from a previous run; it is a cache, not the data under test.
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  sendTeamInviteEmail: jest.fn(() => Promise.resolve()),
  sendTeamInviteRevokedEmail: jest.fn(() => Promise.resolve()),
  resolveEmailBrand: jest.fn(() => 'ghana'),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
const config = {};
// The supplier-creation answer is derived from the SAME `getConfig` keys the
// create path enforces with, so a dashboard can never advertise a capability
// the server would then refuse. Held in a map so each case turns the flag on
// its own terms; defaults come from the same `def` the service passes.
jest.mock('../../src/core/services/getConfig', () =>
  jest.fn(async (key, def) => (config[key] !== undefined ? config[key] : def)),
);
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const E = (n) => `mrs-${n}@test.invalid`;

const EMAILS = [
  E('owner-both'), E('owner-ghana'), E('owner-plain'), E('admin'),
  E('editor'), E('support'), E('nobody'),
];

let ownerBoth;
let ownerGhana;
let ownerPlain;
let profileBoth;
let profileGhana;
let profilePlain;

/** Every membership this suite creates, removed in afterAll. */
const created = { users: [], profiles: [], members: [] };

async function makeUser(email, roles) {
  const user = await prisma.user.create({
    data: {
      firebaseUid: `test-${email}`,
      name: `MRS ${email}`,
      email,
      roles,
      active: true,
      photoURL: '',
    },
  });
  created.users.push(user.id);
  return user;
}

async function makeProfile(userId) {
  const profile = await prisma.supplierProfile.create({
    data: {
      userId,
      status: 'ACTIVE',
      supplierType: 'TOUR_COMPANY',
      // The six required Json columns carry no shape this endpoint reads.
      businessInfo: {},
      operatingInfo: {},
      representativeInfo: {},
      businessDocuments: {},
      payoutInfo: {},
      compliance: {},
    },
  });
  created.profiles.push(profile.id);
  return profile;
}

async function makeMember(email, supplierId, roles) {
  const member = await prisma.teamMember.create({
    data: {
      email,
      supplierId,
      roles,
      role: roles[0] || null,
      status: 'ACCEPTED',
    },
  });
  created.members.push(member.id);
  return member;
}

const MY_ROLE = '/api/travioghana/supplier/settings/team/my-role';
const auth = (user) => ({ Authorization: `Bearer ${signAccessToken({ userId: user.id })}` });

describeDb('GET /settings/team/my-role — storefronts (real DB)', () => {
  jest.setTimeout(30000);

  let admin;
  let editor;
  let support;
  let nobody;

  beforeAll(async () => {
    await prisma.$connect();

    // Clear residue from a previous run so membership lookups are unambiguous.
    await prisma.teamMember.deleteMany({ where: { email: { in: EMAILS } } });
    await prisma.supplierProfile.deleteMany({ where: { user: { email: { in: EMAILS } } } });
    await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });

    ownerBoth = await makeUser(E('owner-both'), ['supplier', 'ghana', 'expedition']);
    ownerGhana = await makeUser(E('owner-ghana'), ['supplier', 'ghana']);
    // Holds a profile and the base supplier role, but no brand role at all —
    // the only shape in which a member's storefronts can legitimately be empty.
    ownerPlain = await makeUser(E('owner-plain'), ['supplier']);
    admin = await makeUser(E('admin'), ['admin']);
    editor = await makeUser(E('editor'), ['customer']);
    support = await makeUser(E('support'), ['customer']);
    nobody = await makeUser(E('nobody'), ['customer']);

    profileBoth = await makeProfile(ownerBoth.id);
    profileGhana = await makeProfile(ownerGhana.id);
    profilePlain = await makeProfile(ownerPlain.id);

    await makeMember(E('editor'), ownerBoth.id, ['editor']);
    await makeMember(E('support'), ownerPlain.id, ['support']);
    // `nobody` has no SupplierProfile and no TeamMember row on purpose.
  });

  afterAll(async () => {
    await prisma.teamMember.deleteMany({ where: { id: { in: created.members } } }).catch(() => {});
    await prisma.supplierProfile.deleteMany({ where: { id: { in: created.profiles } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('maps an owner with both brand roles to Travio Ghana first, then Expedition', async () => {
    const res = await request(app).get(MY_ROLE).set(auth(ownerBoth));

    expect(res.status).toBe(200);
    expect(res.body.data.storefronts).toEqual(['GHANA', 'EXPEDITION']);
    expect(res.body.data.isOwner).toBe(true);

    // On the owner branch `supplierId` is a SupplierProfile id…
    expect(res.body.data.supplierId).toBe(profileBoth.id);
    expect(res.body.data.supplierId).not.toBe(ownerBoth.id);
  });

  it('maps an owner with only the ghana role to a single storefront', async () => {
    const res = await request(app).get(MY_ROLE).set(auth(ownerGhana));

    expect(res.status).toBe(200);
    expect(res.body.data.storefronts).toEqual(['GHANA']);
    expect(res.body.data.supplierId).toBe(profileGhana.id);
  });

  it('reads the OWNER roles for a team member, whose own roles never carry expedition', async () => {
    // The member is a plain `customer`: 'expedition' is not in BRAND_ROLES, so
    // accepting the invite never copies it onto them.
    expect(editor.roles).toEqual(['customer']);

    const res = await request(app).get(MY_ROLE).set(auth(editor));

    expect(res.status).toBe(200);
    expect(res.body.data.isOwner).toBe(false);
    expect(res.body.data.roles).toEqual(['editor']);

    // …while on the member branch the same field is the OWNER's User id.
    expect(res.body.data.supplierId).toBe(ownerBoth.id);
    expect(res.body.data.supplierId).not.toBe(profileBoth.id);

    // The storefronts came from the owner's roles, read through the
    // `TeamMember.supplier` relation — not from the member's own.
    expect(res.body.data.storefronts).toEqual(['GHANA', 'EXPEDITION']);
  });

  it('returns an empty list for a team member whose owner has no brand roles', async () => {
    const res = await request(app).get(MY_ROLE).set(auth(support));

    expect(res.status).toBe(200);
    expect(res.body.data.isOwner).toBe(false);
    expect(res.body.data.roles).toEqual(['support']);
    expect(res.body.data.storefronts).toEqual([]);

    // The owner genuinely holds no brand role, so nothing can be inherited.
    expect(res.body.data.supplierId).toBe(ownerPlain.id);
    expect(res.body.data.supplierId).not.toBe(profilePlain.id);
  });

  it('returns an empty list for an admin, who is not a supplier', async () => {
    const res = await request(app).get(MY_ROLE).set(auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.data.storefronts).toEqual([]);
    expect(res.body.data.isOwner).toBe(true);
    expect(res.body.data.supplierId).toBeUndefined();
  });

  it('always ships the key, so the dashboard can distinguish "none" from "not answered"', async () => {
    // No supplier profile and no membership: the pre-existing "nobody" answer.
    const res = await request(app).get(MY_ROLE).set(auth(nobody));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('storefronts');
    expect(res.body.data.storefronts).toEqual([]);
    expect(res.body.data.isOwner).toBe(false);
    expect(res.body.data.supplierId).toBeUndefined();
  });
});

/**
 * Whether the dashboard may offer supplier-created bookings at all.
 *
 * The answer must come from the same config the create path enforces with,
 * because the backend refuses the create when the flag is off. Advertising the
 * flow anyway earns a 403 — this is the field that lets the UI stay honest.
 */
describeDb('GET /settings/team/my-role — supplier-created bookings flag (real DB)', () => {
  jest.setTimeout(30000);

  // Declared here as well as in the first describe: each suite owns its users
  // so one cannot depend on the other's setup order.
  let flagOwnerGhana;
  let flagOwnerPlain;
  let flagEditor;
  let flagAdmin;

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.teamMember.deleteMany({ where: { email: { in: EMAILS } } });
    await prisma.supplierProfile.deleteMany({ where: { user: { email: { in: EMAILS } } } });
    await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });

    flagOwnerGhana = await makeUser(E('owner-both'), ['supplier', 'ghana', 'expedition']);
    flagOwnerPlain = await makeUser(E('owner-plain'), ['supplier']);
    flagEditor = await makeUser(E('editor'), ['customer']);
    flagAdmin = await makeUser(E('admin'), ['admin']);

    await makeProfile(flagOwnerGhana.id);
    await makeProfile(flagOwnerPlain.id);
    await makeMember(E('editor'), flagOwnerGhana.id, ['editor']);

    config['feature.supplierCreatedBookings.ghana'] = 'true';
  });

  afterAll(async () => {
    delete config['feature.supplierCreatedBookings.ghana'];
    await prisma.teamMember.deleteMany({ where: { id: { in: created.members } } }).catch(() => {});
    await prisma.supplierProfile.deleteMany({ where: { id: { in: created.profiles } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('offers the flow to an owner whose brand is enabled', async () => {
    const res = await request(app).get(MY_ROLE).set(auth(flagOwnerGhana));

    expect(res.status).toBe(200);
    expect(res.body.data.supplierCreatedBookings).toBe(true);
  });

  it('inherits the owner\'s answer for a team member, never the member\'s own roles', async () => {
    // The member is only `['customer']`; the flag follows the OWNER's brands.
    const res = await request(app).get(MY_ROLE).set(auth(flagEditor));

    expect(res.status).toBe(200);
    expect(res.body.data.isOwner).toBe(false);
    expect(res.body.data.supplierCreatedBookings).toBe(true);
  });

  it('keeps the answer false for every brand that is not enabled', async () => {
    // A supplier holding no brand role at all, and the flag off for their brand.
    const res = await request(app).get(MY_ROLE).set(auth(flagOwnerPlain));

    expect(res.status).toBe(200);
    expect(res.body.data.storefronts).toEqual([]);
    expect(res.body.data.supplierCreatedBookings).toBe(false);
  });

  it('is false for an admin, who has no brand to enable it for', async () => {
    const res = await request(app).get(MY_ROLE).set(auth(flagAdmin));

    expect(res.status).toBe(200);
    expect(res.body.data.supplierCreatedBookings).toBe(false);
  });
});
