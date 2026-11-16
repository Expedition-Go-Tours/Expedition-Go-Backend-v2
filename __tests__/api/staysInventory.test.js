/**
 * Stays inventory correctness — real HTTP, real PostGIS database, real
 * transactions. Runs against the Stays API application directly, which also
 * proves the accommodation app can serve requests without the Platform API.
 *
 * What this suite protects, and why the previous implementation failed:
 *
 *  1. CONCURRENCY. `createBooking` used to do `count()` then `create()` on two
 *     separate connections. Two requests arriving together both observed
 *     "0 of 1 rooms booked" and both inserted. Five parallel requests against a
 *     one-room property must now produce exactly one 201.
 *  2. PER-DATE COUNT. A `StayAvailabilityOverride.count` of 1 has to bind even
 *     when the room's payload says 5.
 *  3. PER-DATE PRICE. A date priced above the rate plan must be charged at the
 *     override price.
 *  4. PER-DATE MIN STAY. A two-night request against a three-night minimum has
 *     to be refused.
 *
 * The 2nd–5th cases also exercise the legacy `/api/...` prefix; the race uses
 * `/api/v1/...`, so both spellings are proven against the same router.
 *
 * Fixtures are keyed on `sinv-` and removed in `afterAll`.
 */
const request = require('supertest');

// Keep the suite off Redis. `cacheHelper` is used by `protect` (user lookup)
// and by `resolveSupplier` (team context); both fall back to calling the
// loader, which is exactly what a real request does on a cold cache.
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

const PREFIX = 'sinv-';
let serial = 0;
const unique = (label) => {
  serial += 1;
  return `${PREFIX}${label}-${Date.now()}-${serial}`;
};

let ownerId;
let token;

const auth = () => ({ Authorization: `Bearer ${token}` });

const LEGACY_STAYS = '/api/travioghana/supplier/stays';
const V1_STAYS = '/api/v1/travioghana/supplier/stays';

const createdPropertyIds = [];

async function makeProperty({ capacity = 1, price = 120 } = {}) {
  const property = await prisma.stayProperty.create({
    data: {
      supplierId: ownerId,
      name: unique('Property'),
      status: 'ACTIVE',
      data: {
        currency: 'GHS',
        rooms: [{ id: 'r1', name: 'Deluxe King Room', count: capacity, price }],
        ratePlans: [{ id: 'plan-r1', roomId: 'r1', name: 'Standard rate', price }],
      },
    },
  });
  createdPropertyIds.push(property.id);
  return property;
}

async function makeOverride(propertyId, dateKey, overrides = {}) {
  return prisma.stayAvailabilityOverride.create({
    data: {
      propertyId,
      roomId: 'r1',
      date: new Date(`${dateKey}T00:00:00.000Z`),
      closed: overrides.closed ?? false,
      count: overrides.count ?? null,
      price: overrides.price ?? null,
      minStay: overrides.minStay ?? null,
    },
  });
}

function bookingBody(propertyId, overrides = {}) {
  return {
    propertyId,
    roomId: 'r1',
    guestName: 'Ama Mensah',
    checkIn: '2027-03-10',
    checkOut: '2027-03-12',
    guests: 2,
    ...overrides,
  };
}

const postBooking = (prefix, body) =>
  request(staysApp).post(`${prefix}/bookings`).set(auth()).send(body);

beforeAll(async () => {
  if (!dbAvailable) return;

  const user = await prisma.user.create({
    data: {
      firebaseUid: unique('owner'),
      email: `${unique('owner')}@example.test`,
      name: 'Stays Inventory Owner',
      roles: ['supplier'],
      active: true,
    },
  });
  ownerId = user.id;

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

  token = signAccessToken({ userId: ownerId });
});

afterAll(async () => {
  if (!dbAvailable) return;

  await prisma.stayBooking.deleteMany({ where: { supplierId: ownerId } });
  for (const id of createdPropertyIds) {
    // Availability overrides cascade from the property.
    await prisma.stayProperty.deleteMany({ where: { id } });
  }
  await prisma.supplierProfile.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

describeDb('Stays inventory allocation', () => {
  it('allows exactly one of five concurrent bookings for a single room', async () => {
    const property = await makeProperty({ capacity: 1 });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postBooking(V1_STAYS, bookingBody(property.id))),
    );

    const statuses = responses.map((r) => r.status);
    const created = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 400);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    // No 500s: a serialization conflict must be retried or reported as a
    // business "no rooms available", never as a server fault.
    expect(statuses.every((s) => s === 201 || s === 400)).toBe(true);

    const stored = await prisma.stayBooking.count({
      where: { propertyId: property.id, status: { in: ['NEW', 'CONFIRMED', 'CHECKED_IN'] } },
    });
    expect(stored).toBe(1);
  });

  it('honours a per-date count override that is lower than the room count', async () => {
    const property = await makeProperty({ capacity: 5 });
    await makeOverride(property.id, '2027-04-11', { count: 1 });

    const first = await postBooking(LEGACY_STAYS, bookingBody(property.id, {
      checkIn: '2027-04-10',
      checkOut: '2027-04-12',
    }));
    expect(first.status).toBe(201);

    const second = await postBooking(LEGACY_STAYS, bookingBody(property.id, {
      checkIn: '2027-04-10',
      checkOut: '2027-04-12',
    }));
    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/No rooms are available for 2027-04-11/);
  });

  it('charges a per-date price override instead of the rate-plan price', async () => {
    const property = await makeProperty({ capacity: 2, price: 120 });
    await makeOverride(property.id, '2027-05-11', { price: 250 });

    const res = await postBooking(LEGACY_STAYS, bookingBody(property.id, {
      checkIn: '2027-05-10',
      checkOut: '2027-05-12',
    }));

    expect(res.status).toBe(201);
    // 2027-05-10 base 120 + 2027-05-11 override 250.
    expect(res.body.data.booking.amount).toBe(370);
  });

  it('refuses a stay shorter than the date minimum', async () => {
    const property = await makeProperty({ capacity: 2 });
    await makeOverride(property.id, '2027-06-10', { minStay: 3 });

    const res = await postBooking(LEGACY_STAYS, bookingBody(property.id, {
      checkIn: '2027-06-10',
      checkOut: '2027-06-12',
    }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/minimum stay of 3 night/i);
    expect(await prisma.stayBooking.count({ where: { propertyId: property.id } })).toBe(0);
  });

  it('refuses a closed night', async () => {
    const property = await makeProperty({ capacity: 2 });
    await makeOverride(property.id, '2027-07-10', { closed: true });

    const res = await postBooking(LEGACY_STAYS, bookingBody(property.id, {
      checkIn: '2027-07-10',
      checkOut: '2027-07-12',
    }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/blocked for this room/);
  });
});

describeDb('Stays API authentication and prefix parity', () => {
  it('rejects unauthenticated calls identically on both prefixes', async () => {
    const legacy = await request(staysApp).get(`${LEGACY_STAYS}/properties`);
    const versioned = await request(staysApp).get(`${V1_STAYS}/properties`);

    expect(legacy.status).toBe(401);
    expect(versioned.status).toBe(401);
    expect(versioned.body.message).toBe(legacy.body.message);
    expect(legacy.headers['x-api-version']).toBe('legacy');
    expect(versioned.headers['x-api-version']).toBe('v1');
  });

  it('serves the same properties and bookings through both prefixes', async () => {
    await makeProperty({ capacity: 1 });

    const legacy = await request(staysApp).get(`${LEGACY_STAYS}/properties`).set(auth());
    const versioned = await request(staysApp).get(`${V1_STAYS}/properties`).set(auth());

    expect(legacy.status).toBe(200);
    expect(versioned.status).toBe(200);
    expect(versioned.body).toEqual(legacy.body);
  });

  it('does not expose Platform (Tours) routes', async () => {
    const res = await request(staysApp).get('/api/v1/tours');
    expect(res.status).toBe(404);
  });
});
