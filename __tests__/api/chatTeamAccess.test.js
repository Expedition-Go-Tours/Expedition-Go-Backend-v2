/**
 * Chat is a shared route: customers, suppliers and team members all use it, so
 * the blanket gate above it deliberately lets every non-admin through. That
 * left the supplier's customer inbox readable by ANY accepted member — an
 * editor or a finance member got 200 with the business's threads, while the
 * dashboards hide the Customers page from them (it is gated on `chat.view`, i.e.
 * admin + support).
 *
 * The fix gates on "acting through a membership" rather than on the account
 * type, so customers, the owner and platform admins are untouched.
 *
 * This suite used to mock Prisma, with every `conversationParticipant.findMany`
 * returning `[]`. That was enough to prove the guard let a support member
 * through and named the owner's id in the where clause — but an empty inbox and
 * a properly scoped one are the same thing to a mock, so the property the fix
 * exists for was never actually measured. There were two businesses here, and
 * neither could be told apart from the other's.
 *
 * Running against `travio_test` gives each supplier a real conversation, so the
 * assertions are now about who sees WHAT:
 *
 *   - owner1 and owner2 each see only their own thread;
 *   - a support member of owner1 sees owner1's thread and not owner2's, and
 *     the mirror case holds for a support member of owner2;
 *   - the traveller sees both, because they are genuinely in both;
 *   - an editor and a finance member are refused before any query runs.
 *
 * Kept mocked: `cacheHelper` as a pass-through (membership is looked up through
 * a 30-second cache entry; leaving it real would let one test's membership leak
 * into the next), plus `queue`, `emailService`, `getConfig`, `auditLogger` and
 * `imageOptimizer`, none of which this route touches meaningfully.
 *
 * `config/jwt` is NOT mocked: tokens are minted for real users.
 *
 * Fixtures are keyed on a `cta-` prefix and removed in `afterAll`.
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

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const { signAccessToken } = require('../../config/jwt');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'cta-';

/** Two businesses, so "sees only its own" has something to be measured against. */
const OWNER1 = `${PREFIX}owner1`;
const OWNER2 = `${PREFIX}owner2`;
const SUPPORT1 = `${PREFIX}support1`;
const SUPPORT2 = `${PREFIX}support2`;
const EDITOR = `${PREFIX}editor`;
const FINANCE = `${PREFIX}finance`;
const TRAVELLER = `${PREFIX}traveller`;

const emailFor = (name) => `${name}@example.test`;

let convOwner1Id;
let convOwner2Id;
let tokens;

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

async function upsertUser(name, data) {
  return prisma.user.upsert({
    where: { email: emailFor(name) },
    update: data,
    create: { firebaseUid: `test-${name}`, email: emailFor(name), photoURL: '', active: true, ...data },
  });
}

async function upsertMember(name, supplierId, roles) {
  return prisma.teamMember.upsert({
    where: { supplierId_email: { supplierId, email: emailFor(name) } },
    update: { roles, role: roles[0], status: 'ACCEPTED' },
    create: {
      supplierId,
      email: emailFor(name),
      roles,
      role: roles[0],
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    },
  });
}

/** A `SUPPLIER_CUSTOMER` thread: that type is visible to both roles involved. */
async function upsertConversation(key, ownerId, travellerId) {
  const existing = await prisma.conversation.findFirst({
    where: { title: `${PREFIX}${key}` },
    include: { participants: true },
  });
  if (existing) return existing.id;

  const created = await prisma.conversation.create({
    data: {
      title: `${PREFIX}${key}`,
      type: 'SUPPLIER_CUSTOMER',
      brand: 'ghana',
      participants: { create: [{ userId: ownerId }, { userId: travellerId }] },
    },
    include: { participants: true },
  });
  return created.id;
}

describeDb('chat access for team members', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    await prisma.$connect();

    tokens = {};

    const owner1 = await upsertUser(OWNER1, { name: 'CTA Owner One', roles: ['supplier'] });
    const owner2 = await upsertUser(OWNER2, { name: 'CTA Owner Two', roles: ['supplier'] });
    const support1 = await upsertUser(SUPPORT1, { name: 'CTA Support One', roles: ['customer'] });
    const support2 = await upsertUser(SUPPORT2, { name: 'CTA Support Two', roles: ['customer'] });
    const editor = await upsertUser(EDITOR, { name: 'CTA Editor', roles: ['customer'] });
    const finance = await upsertUser(FINANCE, { name: 'CTA Finance', roles: ['customer'] });
    const traveller = await upsertUser(TRAVELLER, { name: 'CTA Traveller', roles: ['customer'] });

    // `chat.view` is admin + support: the owner passes because they own a
    // supplier profile, and the support members pass on their role. Editor and
    // finance deliberately have neither.
    await upsertMember(SUPPORT1, owner1.id, ['support']);
    await upsertMember(SUPPORT2, owner2.id, ['support']);
    await upsertMember(EDITOR, owner1.id, ['editor']);
    await upsertMember(FINANCE, owner1.id, ['finance']);

    convOwner1Id = await upsertConversation('conv-one', owner1.id, traveller.id);
    convOwner2Id = await upsertConversation('conv-two', owner2.id, traveller.id);

    for (const [who, user] of Object.entries({ owner1, owner2, support1, support2, editor, finance, traveller })) {
      tokens[who] = signAccessToken({ userId: user.id });
    }
  });

  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.teamMember.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  const idsIn = (res) => res.body.data.conversations.map((c) => c.id);

  it('refuses the supplier inbox to a member without chat.view (editor)', async () => {
    const res = await request(app).get('/api/chat/conversations').set(auth('editor'));

    expect(res.status).toBe(403);
  });

  it('refuses it to a finance member too', async () => {
    const res = await request(app).get('/api/chat/conversations').set(auth('finance'));

    expect(res.status).toBe(403);
  });

  it('serves owner one their own thread, and not the other business’s', async () => {
    const res = await request(app).get('/api/chat/conversations').set(auth('owner1'));

    expect(res.status).toBe(200);
    const ids = idsIn(res);
    expect(ids).toContain(convOwner1Id);
    // The leak the mocked suite could not express: a second supplier's thread
    // is real, present, and must not appear here.
    expect(ids).not.toContain(convOwner2Id);
  });

  it('serves owner two their own thread, and not the other business’s', async () => {
    const res = await request(app).get('/api/chat/conversations').set(auth('owner2'));

    expect(res.status).toBe(200);
    const ids = idsIn(res);
    expect(ids).toContain(convOwner2Id);
    expect(ids).not.toContain(convOwner1Id);
  });

  it('serves a support member the OWNER\'s thread, not the other business\'s', async () => {
    const res = await request(app).get('/api/chat/conversations').set(auth('support1'));

    expect(res.status).toBe(200);
    const ids = idsIn(res);
    // The membership, not the member's own account, decides whose inbox this
    // is — and it is scoped to that one account.
    expect(ids).toContain(convOwner1Id);
    expect(ids).not.toContain(convOwner2Id);
    // The member is in no conversation of their own, so nothing of theirs can
    // be mixed in either.
    expect(ids).toEqual([convOwner1Id]);
  });

  it('scopes a second business\'s support member the same way, in reverse', async () => {
    const res = await request(app).get('/api/chat/conversations').set(auth('support2'));

    expect(res.status).toBe(200);
    expect(idsIn(res)).toEqual([convOwner2Id]);
  });

  it('leaves a traveller alone — chat is their route too, and both threads are theirs', async () => {
    const res = await request(app).get('/api/chat/conversations').set(auth('traveller'));

    expect(res.status).toBe(200);
    const ids = idsIn(res);
    expect(ids).toContain(convOwner1Id);
    expect(ids).toContain(convOwner2Id);
  });

  it('rejects a caller with no token at all', async () => {
    const res = await request(app).get('/api/chat/conversations');

    expect(res.status).toBe(401);
  });

  it('rejects a forged token', async () => {
    const res = await request(app)
      .get('/api/chat/conversations')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(401);
  });
});
