/**
 * Currency-safe reporting: no aggregate may add GHS to USD.
 *
 * A supplier can hold bookings in more than one currency. The dashboard still
 * needs one headline number, so each response keeps its legacy scalar fields
 * but scopes them to a single primary currency and adds a `currencies`
 * breakdown. This suite creates one GHS and one USD booking and asserts that
 * every total is either per-currency or labelled with the currency it covers.
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

const PREFIX = 'scur-';
let serial = 0;
const unique = (label) => {
  serial += 1;
  return `${PREFIX}${label}-${Date.now()}-${serial}`;
};

const BASE = '/api/v1/travioghana/supplier/stays';
let userId;
let propertyId;
let token;

const auth = () => ({ Authorization: `Bearer ${token}` });
const get = (path) => request(staysApp).get(`${BASE}${path}`).set(auth());

async function makeBooking({ currency, amount, payout }) {
  const checkIn = new Date();
  const checkOut = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return prisma.stayBooking.create({
    data: {
      bookingNumber: unique('SB'),
      supplierId: userId,
      propertyId,
      roomId: 'r1',
      roomName: 'Standard Room',
      guestName: unique('Guest'),
      checkIn,
      checkOut,
      nights: 1,
      guests: 1,
      amount,
      currency,
      status: 'COMPLETED',
      paymentStatus: 'SUCCEEDED',
      origin: 'SUPPLIER_CREATED',
      commissionRate: 0.15,
      platformCommission: Math.round((amount - payout) * 100) / 100,
      supplierPayout: payout,
      payoutStatus: 'ELIGIBLE',
    },
  });
}

beforeAll(async () => {
  if (!dbAvailable) return;

  const user = await prisma.user.create({
    data: {
      firebaseUid: unique('uid'),
      email: `${unique('owner')}@example.test`,
      name: 'Currency Reporting Owner',
      roles: ['supplier'],
      active: true,
    },
  });
  userId = user.id;
  token = signAccessToken({ userId });

  await prisma.supplierProfile.create({
    data: {
      userId,
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
      supplierId: userId,
      name: unique('Property'),
      status: 'ACTIVE',
      data: {
        currency: 'GHS',
        rooms: [{ id: 'r1', name: 'Standard Room', count: 2, price: 120 }],
        ratePlans: [{ id: 'plan-r1', roomId: 'r1', name: 'Standard rate', price: 120 }],
      },
    },
  });
  propertyId = property.id;

  await makeBooking({ currency: 'GHS', amount: 300, payout: 255 });
  await makeBooking({ currency: 'USD', amount: 100, payout: 85 });
});

afterAll(async () => {
  if (!dbAvailable) return;
  await prisma.stayBooking.deleteMany({ where: { supplierId: userId } });
  await prisma.stayProperty.deleteMany({ where: { id: propertyId } });
  await prisma.supplierProfile.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describeDb('currency-safe Stays reporting', () => {
  it('groups analytics summary earnings by currency', async () => {
    const res = await get('/analytics/summary');
    expect(res.status).toBe(200);
    const earnings = res.body.data.earnings;
    expect(earnings.currency).toBe('GHS');
    expect(earnings.mixedCurrencies).toBe(true);
    expect(earnings.totalEarnings).toBe(300);
    expect(earnings.currencies).toHaveLength(2);
    expect(earnings.currencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ currency: 'GHS', totalEarnings: 300 }),
      expect.objectContaining({ currency: 'USD', totalEarnings: 100 }),
    ]));
  });

  it('scopes the main analytics totals and exposes both currency buckets', async () => {
    const res = await get('/analytics');
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('GHS');
    expect(res.body.data.mixedCurrencies).toBe(true);
    expect(res.body.data.grossBookingValue).toBe(300);
    expect(res.body.data.currencies).toHaveLength(2);
    expect(res.body.data.currencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ currency: 'GHS', grossBookingValue: 300 }),
      expect.objectContaining({ currency: 'USD', grossBookingValue: 100 }),
    ]));
  });

  it('gives each property revenue per currency', async () => {
    const res = await get('/analytics/properties');
    expect(res.status).toBe(200);
    const row = res.body.data.properties.find((p) => p.propertyId === propertyId);
    expect(row.currency).toBe('GHS');
    expect(row.revenue).toBe(300);
    expect(row.revenueByCurrency).toEqual({ GHS: 300, USD: 100 });
  });

  it('returns a primary monthly series plus per-currency series', async () => {
    const res = await get('/analytics/monthly-revenue?months=1');
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('GHS');
    expect(res.body.data.mixedCurrencies).toBe(true);
    expect(res.body.data.months).toHaveLength(1);
    expect(res.body.data.months[0].revenue).toBe(300);
    expect(res.body.data.series).toEqual(expect.arrayContaining([
      expect.objectContaining({ currency: 'GHS' }),
      expect.objectContaining({ currency: 'USD' }),
    ]));
  });

  it('scopes the finance summary and lists each currency balance', async () => {
    const res = await get('/finance/summary');
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('GHS');
    expect(res.body.data.mixedCurrencies).toBe(true);
    expect(res.body.data.availableBalance).toEqual(
      expect.objectContaining({ amount: 255, currency: 'GHS', bookingCount: 1 }),
    );
    expect(res.body.data.currencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        currency: 'GHS',
        availableBalance: { amount: 255, bookingCount: 1 },
      }),
      expect.objectContaining({
        currency: 'USD',
        availableBalance: { amount: 85, bookingCount: 1 },
      }),
    ]));
  });

  it('scopes the earnings summary and exposes per-currency totals', async () => {
    const res = await get('/finance/earnings');
    expect(res.status).toBe(200);
    expect(res.body.data.summary.currency).toBe('GHS');
    expect(res.body.data.summary.mixedCurrencies).toBe(true);
    expect(res.body.data.summary.total).toBe(255);
    expect(res.body.data.summary.currencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ currency: 'GHS', total: 255 }),
      expect.objectContaining({ currency: 'USD', total: 85 }),
    ]));
  });
});
