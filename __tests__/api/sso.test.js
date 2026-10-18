/**
 * `/api/sso` — the cross-storefront handoff that logs a user into
 * travioghana.com as they arrive from a tour click on expeditiongotours.com.
 *
 * This file used a hand-built express app with `prismaClient` mocked. That was
 * deliberate at the time — dragging the whole graph in meant mocking forty
 * models to test three HTTP behaviours — but it left the one thing the file's
 * own header admitted was unverified: *"the mount in app.js is verified at
 * runtime after deploy"*. Nothing asserted `/api/sso` was mounted at all, so
 * removing three lines from app.js would have left every test here green while
 * the handoff 404'd in production. Driving the REAL app closes that.
 *
 * The real database closes two more things a fixture could not:
 *
 *   - `exchangeTicket` selects `{ id, name, email, photoURL, roles,
 *     passwordHash, active }` off the user row and hands back `hasPassword:
 *     Boolean(user.passwordHash)`. Against a fixture that field is whatever the
 *     test wrote. Here it comes from the row.
 *   - The exchange then calls `storeRefreshToken`, and returns a refresh token
 *     that the receiving storefront will present on every subsequent request.
 *     The mocked `user.update` made that a no-op: a test could pass while the
 *     returned token was unusable. `validateRefreshToken` is now asked directly
 *     whether the database will honour it.
 *
 * Single-use is enforced with `SET NX`, and is deliberately left against REAL
 * Redis rather than a stub: CI provisions redis:7, and the second exchange of
 * the same ticket is exactly the behaviour that matters. That required
 * connecting Redis explicitly — `server.js` does it in production but tests
 * import `app.js`, and `setnx` returns `null` until a connection exists.
 * `exchangeTicket` reads `null` as "Redis is down" and allows the exchange by
 * design, so an un-armed run traded 200-for-200 and verified nothing. The
 * replay test now asserts 410 because the jti really was consumed.
 *
 * It is a per-process in-memory limiter on the mount (120 / 15 min), not a
 * shared counter, so repeated runs cannot exhaust it.
 */

process.env.ALLOWED_ORIGINS = 'https://www.travioghana.com,https://www.expeditiongotours.com';

const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

// `protect` reads `auth:user:${id}` through the cache helper. A pass-through
// makes every read reach the database — a cache, not the data under test.
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');
const redis = require('../../src/core/services/redisClient');
const { validateRefreshToken } = require('../../src/core/services/refreshTokenHelper');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const DEST = 'https://www.travioghana.com';
const ALLOWED = 'https://www.expeditiongotours.com';
const USER_EMAIL = 'sso-handoff@test.invalid';

let user;
let token;

describeDb('/api/sso (real app, real database)', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    await prisma.$connect();

    // `server.js` is what connects Redis in production; tests import `app.js`,
    // so nothing has. `setnx` returns null until then, and `exchangeTicket`
    // treats null as "Redis is down" and ALLOWS the exchange — a documented
    // fail-open. Left un-armed the replay test below would have passed for the
    // wrong reason (200 twice), and single-use would have gone unverified.
    await redis.connect();
    if (!redis.isReady()) {
      throw new Error(
        'Redis is not reachable — /api/sso single-use cannot be verified without it. '
        + 'Start it (docker start travio-redis) or set REDIS_URL.',
      );
    }

    // Remove any residue so the assertions below describe only this run.
    await prisma.user.deleteMany({ where: { email: USER_EMAIL } });

    user = await prisma.user.create({
      data: {
        firebaseUid: `test-${USER_EMAIL}`,
        name: 'Ama',
        email: USER_EMAIL,
        roles: ['customer'],
        active: true,
        photoURL: '',
      },
    });
    token = signAccessToken({ userId: user.id });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: USER_EMAIL } }).catch(() => {});
    await prisma.$disconnect();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  describe('POST /api/sso/mint', () => {
    it('requires a session — an anonymous visitor cannot mint a ticket', async () => {
      const res = await request(app).post('/api/sso/mint').send({ destination: DEST });

      expect(res.status).toBe(401);
      expect(res.body.data?.ticket).toBeUndefined();
    });

    it('issues a ticket for an allow-listed site, from the mounted route', async () => {
      // 200 rather than 404 is what proves `/api/sso` is wired into app.js.
      const res = await request(app)
        .post('/api/sso/mint')
        .set(auth())
        .send({ destination: DEST });

      expect(res.status).toBe(200);
      expect(res.body.data.destination).toBe(DEST);
      expect(res.body.data.expiresIn).toBe(120);
      expect(typeof res.body.data.ticket).toBe('string');
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('refuses to mint for a site we do not own', async () => {
      const res = await request(app)
        .post('/api/sso/mint')
        .set(auth())
        .send({ destination: 'https://attacker.example' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not an allowed site/);
    });

    it('rejects a missing destination', async () => {
      const res = await request(app).post('/api/sso/mint').set(auth()).send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/destination/);
    });
  });

  describe('POST /api/sso/exchange', () => {
    it('has no auth requirement, and the session it returns is genuinely usable', async () => {
      const minted = await request(app)
        .post('/api/sso/mint')
        .set(auth())
        .send({ destination: DEST });

      const res = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: minted.body.data.ticket, destination: DEST });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));

      // The identity comes off the real row, not a fixture.
      expect(res.body.data.user).toMatchObject({
        id: user.id,
        email: USER_EMAIL,
        roles: ['customer'],
      });
      expect(typeof res.body.data.user.hasPassword).toBe('boolean');

      // The refresh token must be one the database will actually honour —
      // `storeRefreshToken` is a real write, and a silent failure here would
      // strand every handed-off session on its first refresh.
      const accepted = await validateRefreshToken(user.id, res.body.data.refreshToken);
      expect(accepted).toBe(true);

      // And the access token must be accepted by a protected route.
      const roundTrip = await request(app)
        .post('/api/sso/mint')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .send({ destination: DEST });
      expect(roundTrip.status).toBe(200);
    });

    it('refuses a ticket minted for another site', async () => {
      const res = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: 'irrelevant', destination: 'https://attacker.example' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not an allowed site/);
    });

    it('rejects a replayed ticket', async () => {
      const minted = await request(app)
        .post('/api/sso/mint')
        .set(auth())
        .send({ destination: DEST });

      // First exchange consumes the jti in real Redis via SET NX.
      await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: minted.body.data.ticket, destination: DEST })
        .expect(200);

      const replay = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: minted.body.data.ticket, destination: DEST });

      expect(replay.status).toBe(410);
      expect(replay.body.message).toMatch(/already been used/);
    });

    it('rejects a ticket whose destination does not match the request', async () => {
      const minted = await request(app)
        .post('/api/sso/mint')
        .set(auth())
        .send({ destination: ALLOWED });

      const res = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: minted.body.data.ticket, destination: DEST });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/different site/);
    });

    it('rejects a malformed ticket', async () => {
      const res = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: 'not-a-jwt', destination: DEST });

      expect(res.status).toBe(401);
    });
  });
});
