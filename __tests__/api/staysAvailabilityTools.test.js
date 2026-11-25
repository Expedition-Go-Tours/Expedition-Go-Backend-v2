/**
 * Stays availability tools — real HTTP, real database.
 *
 * Covers the endpoints behind the Availability submenu:
 *   calendar aggregate, bulk open/close, copy rates, restriction rules,
 *   value adds, focused rate-plan reads and guest/child pricing.
 *
 * The final block proves the saved fields are enforced at booking time, which
 * is the reason the new rule table exists at all.
 *
 * Fixtures are keyed on `savail-` and removed in afterAll.
 */
const request = require('supertest');

// The Stays app deliberately applies the upload limiter to supplier writes
// (20/hour by default). This suite makes enough writes to exhaust that budget,
// so raise it before the app is constructed; the limiter reads env at build
// time. Rate-limit behaviour itself is covered by apiVersioning.test.js.
process.env.RATELIMIT_UPLOAD_MAX = process.env.RATELIMIT_UPLOAD_MAX || '1000';
process.env.RATELIMIT_GLOBAL_MAX = process.env.RATELIMIT_GLOBAL_MAX || '10000';

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

const PREFIX = 'savail-';
let serial = 0;
const unique = (label) => {
  serial += 1;
  return `${PREFIX}${label}-${Date.now()}-${serial}`;
};

const STAYS = '/api/v1/travioghana/supplier/stays';

let ownerId;
let token;
let propertyId;

const auth = () => ({ Authorization: `Bearer ${token}` });
const url = (suffix) => `${STAYS}/properties/${propertyId}${suffix}`;

const baseData = () => ({
  currency: 'GHS',
  rooms: [
    { id: 'r1', name: 'Deluxe King Room', count: 2, price: 120 },
    { id: 'r2', name: 'Garden Suite', count: 1, price: 200 },
  ],
  ratePlans: [
    { id: 'plan-r1', roomId: 'r1', name: 'Standard rate', price: 120 },
    { id: 'plan-r2', roomId: 'r2', name: 'Suite rate', price: 200 },
  ],
});

beforeAll(async () => {
  if (!dbAvailable) return;

  const user = await prisma.user.create({
    data: {
      firebaseUid: unique('owner'),
      email: `${unique('owner')}@example.test`,
      name: 'Stays Availability Owner',
      roles: ['supplier'],
      active: true,
    },
  });
  ownerId = user.id;
  token = signAccessToken({ userId: ownerId });

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

  const property = await prisma.stayProperty.create({
    data: {
      supplierId: ownerId,
      name: unique('Availability Property'),
      status: 'ACTIVE',
      data: baseData(),
    },
  });
  propertyId = property.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;

  await prisma.stayBooking.deleteMany({ where: { propertyId } });
  await prisma.stayAvailabilityOverride.deleteMany({ where: { propertyId } });
  await prisma.stayRestrictionRule.deleteMany({ where: { propertyId } });
  await prisma.stayValueAdd.deleteMany({ where: { propertyId } });
  await prisma.stayProperty.update({ where: { id: propertyId }, data: { data: baseData() } });
});

afterAll(async () => {
  if (!dbAvailable) return;

  await prisma.stayProperty.deleteMany({ where: { id: propertyId } });
  await prisma.supplierProfile.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

describeDb('Stays availability calendar aggregate', () => {
  it('returns rooms, rate plans, overrides and rules in one response', async () => {
    await prisma.stayAvailabilityOverride.create({
      data: {
        propertyId,
        roomId: 'r1',
        date: new Date('2027-03-02T00:00:00.000Z'),
        closed: true,
      },
    });
    await prisma.stayRestrictionRule.create({
      data: {
        propertyId,
        name: 'March stop sell',
        startDate: new Date('2027-03-01T00:00:00.000Z'),
        endDate: new Date('2027-03-31T00:00:00.000Z'),
        roomIds: ['r1'],
        stopSell: true,
      },
    });

    const res = await request(staysApp)
      .get(url('/calendar?from=2027-03-01&to=2027-03-05'))
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.rooms).toHaveLength(2);
    expect(res.body.data.ratePlans).toHaveLength(2);
    expect(res.body.data.overrides['r1|2027-03-02']).toEqual({ closed: true });
    expect(res.body.data.rules).toHaveLength(1);
    expect(res.body.data.rules[0]).toEqual(expect.objectContaining({
      name: 'March stop sell',
      stopSell: true,
      startDate: '2027-03-01',
    }));
  });

  it('filters the calendar to one room', async () => {
    const res = await request(staysApp)
      .get(url('/calendar?from=2027-03-01&to=2027-03-05&roomId=r2'))
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.rooms.map((room) => room.id)).toEqual(['r2']);
    expect(res.body.data.ratePlans.map((plan) => plan.id)).toEqual(['plan-r2']);
  });

  it('rejects a room that is not on the property', async () => {
    const res = await request(staysApp)
      .get(url('/calendar?from=2027-03-01&to=2027-03-05&roomId=missing'))
      .set(auth());

    expect(res.status).toBe(400);
  });
});

describeDb('Stays bulk open and close', () => {
  it('closes every room/date cell and reopens it', async () => {
    const close = await request(staysApp)
      .post(url('/availability/bulk'))
      .set(auth())
      .send({ action: 'close', roomIds: ['r1', 'r2'], from: '2027-04-01', to: '2027-04-03' });

    expect(close.status).toBe(200);
    expect(close.body.data.affected).toBe(6);
    expect(close.body.data.days).toBe(3);

    const closed = await prisma.stayAvailabilityOverride.findMany({
      where: { propertyId, date: { gte: new Date('2027-04-01T00:00:00.000Z') } },
    });
    expect(closed).toHaveLength(6);
    expect(closed.every((row) => row.closed)).toBe(true);

    const open = await request(staysApp)
      .post(url('/availability/bulk'))
      .set(auth())
      .send({ action: 'open', roomIds: ['r1', 'r2'], from: '2027-04-01', to: '2027-04-03' });

    expect(open.status).toBe(200);
    expect(open.body.data.affected).toBe(6);
    // Rows that only carried the closed flag are removed, not left as noise.
    expect(await prisma.stayAvailabilityOverride.count({ where: { propertyId } })).toBe(0);
  });

  it('preserves a price when a night is reopened', async () => {
    await prisma.stayAvailabilityOverride.create({
      data: {
        propertyId,
        roomId: 'r1',
        date: new Date('2027-04-10T00:00:00.000Z'),
        closed: true,
        price: 175,
      },
    });

    await request(staysApp)
      .post(url('/availability/bulk'))
      .set(auth())
      .send({ action: 'open', roomIds: ['r1'], from: '2027-04-10', to: '2027-04-10' })
      .expect(200);

    const row = await prisma.stayAvailabilityOverride.findFirst({
      where: { propertyId, roomId: 'r1', date: new Date('2027-04-10T00:00:00.000Z') },
    });
    expect(row.closed).toBe(false);
    expect(Number(row.price)).toBe(175);
  });

  it('rejects a range longer than the bulk limit', async () => {
    const res = await request(staysApp)
      .post(url('/availability/bulk'))
      .set(auth())
      .send({ action: 'close', roomIds: ['r1'], from: '2027-01-01', to: '2028-01-02' });

    expect(res.status).toBe(400);
  });
});

describeDb('Stays copy rates', () => {
  it('previews, applies and respects overwrite', async () => {
    await prisma.stayAvailabilityOverride.create({
      data: {
        propertyId,
        roomId: 'r1',
        date: new Date('2027-05-01T00:00:00.000Z'),
        price: 150,
        count: 2,
      },
    });

    const preview = await request(staysApp)
      .post(url('/availability/copy'))
      .set(auth())
      .send({
        roomIds: ['r1'],
        sourceFrom: '2027-05-01',
        sourceTo: '2027-05-01',
        targetStart: '2027-06-01',
        fields: ['price', 'count'],
        dryRun: true,
      });

    expect(preview.status).toBe(200);
    expect(preview.body.data.wouldCopy).toBe(1);
    expect(preview.body.data.preview[0]).toEqual({
      roomId: 'r1',
      date: '2027-06-01',
      fields: { price: 150, count: 2 },
    });
    expect(await prisma.stayAvailabilityOverride.count({
      where: { propertyId, date: new Date('2027-06-01T00:00:00.000Z') },
    })).toBe(0);

    const applied = await request(staysApp)
      .post(url('/availability/copy'))
      .set(auth())
      .send({
        roomIds: ['r1'],
        sourceFrom: '2027-05-01',
        sourceTo: '2027-05-01',
        targetStart: '2027-06-01',
        fields: ['price', 'count'],
      });

    expect(applied.status).toBe(200);
    expect(applied.body.data.copied).toBe(1);

    const target = await prisma.stayAvailabilityOverride.findFirst({
      where: { propertyId, roomId: 'r1', date: new Date('2027-06-01T00:00:00.000Z') },
    });
    expect(Number(target.price)).toBe(150);
    expect(target.count).toBe(2);

    // A later source price change must not overwrite an existing target unless
    // the caller explicitly opts in.
    await prisma.stayAvailabilityOverride.update({
      where: { id: target.id },
      data: { price: 999 },
    });

    const safe = await request(staysApp)
      .post(url('/availability/copy'))
      .set(auth())
      .send({
        roomIds: ['r1'],
        sourceFrom: '2027-05-01',
        sourceTo: '2027-05-01',
        targetStart: '2027-06-01',
        fields: ['price'],
      });
    expect(safe.status).toBe(200);
    expect(safe.body.data.copied).toBe(0);
    expect(safe.body.data.skipped).toBe(1);

    const forced = await request(staysApp)
      .post(url('/availability/copy'))
      .set(auth())
      .send({
        roomIds: ['r1'],
        sourceFrom: '2027-05-01',
        sourceTo: '2027-05-01',
        targetStart: '2027-06-01',
        fields: ['price'],
        overwrite: true,
      });
    expect(forced.status).toBe(200);
    expect(forced.body.data.copied).toBe(1);

    const refreshed = await prisma.stayAvailabilityOverride.findFirst({
      where: { propertyId, roomId: 'r1', date: new Date('2027-06-01T00:00:00.000Z') },
    });
    expect(Number(refreshed.price)).toBe(150);
  });

  it('rejects a room that is not on the property', async () => {
    const res = await request(staysApp)
      .post(url('/availability/copy'))
      .set(auth())
      .send({
        roomIds: ['missing'],
        sourceFrom: '2027-05-01',
        sourceTo: '2027-05-01',
        targetStart: '2027-06-01',
      });

    expect(res.status).toBe(400);
  });
});

describeDb('Stays dynamic restriction rules', () => {
  it('creates, updates, lists and deletes a rule', async () => {
    const created = await request(staysApp)
      .post(url('/restriction-rules'))
      .set(auth())
      .send({
        name: 'Weekend minimum',
        startDate: '2027-03-01',
        endDate: '2027-03-31',
        weekdays: ['friday', 'saturday'],
        roomIds: ['r1'],
        minStay: 3,
      });

    expect(created.status).toBe(201);
    expect(created.body.data.rule).toEqual(expect.objectContaining({
      name: 'Weekend minimum',
      minStay: 3,
      weekdays: ['friday', 'saturday'],
      stopSell: false,
      isActive: true,
    }));
    const { id } = created.body.data.rule;

    const updated = await request(staysApp)
      .patch(url(`/restriction-rules/${id}`))
      .set(auth())
      .send({ maxStay: 5, stopSell: true });

    expect(updated.status).toBe(200);
    expect(updated.body.data.rule).toEqual(expect.objectContaining({
      minStay: 3,
      maxStay: 5,
      stopSell: true,
    }));

    const list = await request(staysApp).get(url('/restriction-rules')).set(auth());
    expect(list.status).toBe(200);
    expect(list.body.data.rules).toHaveLength(1);
    expect(list.body.data.rooms).toHaveLength(2);

    await request(staysApp).delete(url(`/restriction-rules/${id}`)).set(auth()).expect(200);
    const empty = await request(staysApp).get(url('/restriction-rules')).set(auth());
    expect(empty.body.data.rules).toHaveLength(0);
  });

  it('rejects a rule with no effect and a maximum below the minimum', async () => {
    const empty = await request(staysApp)
      .post(url('/restriction-rules'))
      .set(auth())
      .send({ startDate: '2027-03-01', endDate: '2027-03-31', roomIds: ['r1'] });
    expect(empty.status).toBe(400);

    const inverted = await request(staysApp)
      .post(url('/restriction-rules'))
      .set(auth())
      .send({ roomIds: ['r1'], minStay: 4, maxStay: 2 });
    expect(inverted.status).toBe(400);
  });

  it('returns 404 for a rule on another property', async () => {
    const res = await request(staysApp)
      .patch(url('/restriction-rules/nope'))
      .set(auth())
      .send({ stopSell: true });
    expect(res.status).toBe(404);
  });
});

describeDb('Stays value adds', () => {
  it('creates, updates, lists and deletes a value add', async () => {
    const created = await request(staysApp)
      .post(url('/value-adds'))
      .set(auth())
      .send({
        name: 'Breakfast',
        description: 'Buffet for one guest',
        price: 45,
        unit: 'PER_PERSON',
      });

    expect(created.status).toBe(201);
    expect(created.body.data.valueAdd).toEqual(expect.objectContaining({
      name: 'Breakfast',
      description: 'Buffet for one guest',
      price: 45,
      unit: 'PER_PERSON',
      isActive: true,
    }));
    const { id } = created.body.data.valueAdd;

    const updated = await request(staysApp)
      .patch(url(`/value-adds/${id}`))
      .set(auth())
      .send({ price: 50, isActive: false });
    expect(updated.status).toBe(200);
    expect(updated.body.data.valueAdd).toEqual(expect.objectContaining({
      price: 50,
      isActive: false,
      unit: 'PER_PERSON',
    }));

    const list = await request(staysApp).get(url('/value-adds')).set(auth());
    expect(list.status).toBe(200);
    expect(list.body.data.valueAdds).toHaveLength(1);

    await request(staysApp).delete(url(`/value-adds/${id}`)).set(auth()).expect(200);
    const empty = await request(staysApp).get(url('/value-adds')).set(auth());
    expect(empty.body.data.valueAdds).toHaveLength(0);
  });

  it('rejects a missing name, a missing price and an invalid unit', async () => {
    await request(staysApp).post(url('/value-adds')).set(auth())
      .send({ price: 10 }).expect(400);
    await request(staysApp).post(url('/value-adds')).set(auth())
      .send({ name: 'Late checkout' }).expect(400);
    await request(staysApp).post(url('/value-adds')).set(auth())
      .send({ name: 'Late checkout', price: 10, unit: 'HOURLY' }).expect(400);
  });
});

describeDb('Stays rate plans and per-guest pricing', () => {
  it('lists rooms and plans, then saves guest and child pricing without losing either', async () => {
    const list = await request(staysApp).get(url('/rate-plans')).set(auth());
    expect(list.status).toBe(200);
    expect(list.body.data.rooms).toHaveLength(2);
    expect(list.body.data.ratePlans).toHaveLength(2);

    const guest = await request(staysApp)
      .patch(url('/rate-plans/plan-r1/guest-pricing'))
      .set(auth())
      .send({ baseGuests: 2, singleGuestDiscount: 15, extraAdult: 40 });
    expect(guest.status).toBe(200);
    expect(guest.body.data.ratePlan).toEqual(expect.objectContaining({
      baseGuests: 2,
      singleGuestDiscount: 15,
      extraAdult: 40,
    }));

    const child = await request(staysApp)
      .patch(url('/rate-plans/plan-r1/child-pricing'))
      .set(auth())
      .send({ extraChild: 25 });
    expect(child.status).toBe(200);
    // The child save must keep the guest fields written a moment earlier.
    expect(child.body.data.ratePlan).toEqual(expect.objectContaining({
      extraChild: 25,
      baseGuests: 2,
      singleGuestDiscount: 15,
      extraAdult: 40,
    }));

    const stored = await prisma.stayProperty.findUnique({ where: { id: propertyId } });
    const plan = stored.data.ratePlans.find((row) => row.id === 'plan-r1');
    expect(plan).toEqual(expect.objectContaining({
      extraChild: 25,
      baseGuests: 2,
      singleGuestDiscount: 15,
      extraAdult: 40,
    }));
  });

  it('rejects an empty guest-pricing body and negative amounts', async () => {
    await request(staysApp)
      .patch(url('/rate-plans/plan-r1/guest-pricing'))
      .set(auth())
      .send({})
      .expect(400);

    await request(staysApp)
      .patch(url('/rate-plans/plan-r1/child-pricing'))
      .set(auth())
      .send({ extraChild: -5 })
      .expect(400);
  });

  it('returns 404 for a plan on another property', async () => {
    await request(staysApp)
      .patch(url('/rate-plans/missing/guest-pricing'))
      .set(auth())
      .send({ extraAdult: 10 })
      .expect(404);
  });
});

describeDb('Stays booking enforcement', () => {
  const booking = (overrides = {}) => ({
    propertyId,
    roomId: 'r1',
    guestName: 'Ama Mensah',
    checkIn: '2027-07-10',
    checkOut: '2027-07-12',
    guests: 2,
    ...overrides,
  });

  it('refuses a stop-sell night created through the API', async () => {
    await request(staysApp)
      .post(url('/restriction-rules'))
      .set(auth())
      .send({
        name: 'Sold out',
        startDate: '2027-07-10',
        endDate: '2027-07-12',
        roomIds: ['r1'],
        stopSell: true,
      })
      .expect(201);

    const res = await request(staysApp)
      .post(`${STAYS}/bookings`)
      .set(auth())
      .send(booking());

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/closed to sale/);
    expect(await prisma.stayBooking.count({ where: { propertyId } })).toBe(0);
  });

  it('refuses a closed-to-arrival date and a too-short stay', async () => {
    await request(staysApp)
      .post(url('/restriction-rules'))
      .set(auth())
      .send({ roomIds: ['r1'], closedToArrival: true })
      .expect(201);

    const closedArrival = await request(staysApp)
      .post(`${STAYS}/bookings`)
      .set(auth())
      .send(booking());
    expect(closedArrival.status).toBe(400);
    expect(closedArrival.body.message).toMatch(/closed to arrival/);

    await prisma.stayRestrictionRule.deleteMany({ where: { propertyId } });

    await request(staysApp)
      .post(url('/restriction-rules'))
      .set(auth())
      .send({
        startDate: '2027-07-10',
        endDate: '2027-07-10',
        roomIds: ['r1'],
        minStay: 3,
      })
      .expect(201);

    const tooShort = await request(staysApp)
      .post(`${STAYS}/bookings`)
      .set(auth())
      .send(booking());
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.message).toMatch(/minimum stay of 3 night/i);
  });

  it('enforces the rate plan minimum that the builder saved', async () => {
    await request(staysApp)
      .patch(url('/rate-plans/plan-r1'))
      .set(auth())
      .send({
        id: 'plan-r1',
        roomId: 'r1',
        name: 'Standard rate',
        price: 120,
        minStay: 4,
      })
      .expect(200);

    const res = await request(staysApp)
      .post(`${STAYS}/bookings`)
      .set(auth())
      .send(booking());

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/minimum stay of 4 night/i);
  });
});
