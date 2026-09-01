jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('child_process', () => ({ execSync: jest.fn(() => '') }));

const mockPrisma = {
  booking: {
    aggregate: jest.fn().mockResolvedValue({
      _count: 5,
      _sum: { grossAmount: 1250.75, platformCommission: 187.61, supplierPayout: 1063.14 },
    }),
    count: jest.fn().mockResolvedValue(3),
    groupBy: jest.fn().mockImplementation(({ by }) => {
      if (by && by[0] === 'status') {
        return Promise.resolve([
          { status: 'CONFIRMED', _count: 4 },
          { status: 'REFUNDED', _count: 1 },
        ]);
      }
      return Promise.resolve([
        { tourId: 't1', _sum: { grossAmount: 600 } },
        { tourId: 't2', _sum: { grossAmount: 400 } },
      ]);
    }),
  },
  user: { count: jest.fn().mockResolvedValue(8) },
  supplierProfile: {
    count: jest.fn().mockResolvedValue(2),
    groupBy: jest.fn().mockResolvedValue([
      { status: 'APPROVED', _count: 5 },
      { status: 'ACTIVE', _count: 12 },
    ]),
  },
  review: {
    aggregate: jest.fn().mockResolvedValue({ _count: 9, _avg: { rating: 4.6 } }),
  },
  payout: {
    aggregate: jest.fn().mockResolvedValue({ _count: 3, _sum: { amount: 900 } }),
  },
  tour: {
    findUnique: jest.fn().mockImplementation(({ where }) => {
      const tours = { t1: { title: 'Serengeti Safari' }, t2: { title: 'Zanzibar Beach' } };
      return Promise.resolve(tours[where.id] || { title: 'Unknown Tour' });
    }),
  },
  dispute: {
    count: jest.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3),
  },
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../../utils/discordNotifier', () => ({
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/mimoClient', () => ({
  callMimo: jest.fn(() => Promise.resolve('AI summary: revenue strong, 2 disputes open.')),
}));

const { notifyDiscord } = require('../../utils/discordNotifier');
const { callMimo } = require('../../utils/mimoClient');
const { execSync } = require('child_process');

describe('dailyDigest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MIMO_API_KEY;
    delete process.env.DIGEST_PERIOD;
    // Reset dispute mock for each test
    mockPrisma.dispute.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);
    // Reset multi-purpose booking mocks after clearAllMocks wiped implementations
    mockPrisma.booking.aggregate.mockResolvedValue({
      _count: 5,
      _sum: { grossAmount: 1250.75, platformCommission: 187.61, supplierPayout: 1063.14 },
    });
    mockPrisma.booking.count.mockResolvedValue(3);
    mockPrisma.booking.groupBy.mockImplementation(({ by }) => {
      if (by && by[0] === 'status') {
        return Promise.resolve([
          { status: 'CONFIRMED', _count: 4 },
          { status: 'REFUNDED', _count: 1 },
        ]);
      }
      return Promise.resolve([
        { tourId: 't1', _sum: { grossAmount: 600 } },
        { tourId: 't2', _sum: { grossAmount: 400 } },
      ]);
    });
    mockPrisma.review.aggregate.mockResolvedValue({ _count: 9, _avg: { rating: 4.6 } });
    mockPrisma.payout.aggregate.mockResolvedValue({ _count: 3, _sum: { amount: 900 } });
    mockPrisma.supplierProfile.groupBy.mockResolvedValue([
      { status: 'APPROVED', _count: 5 },
      { status: 'ACTIVE', _count: 12 },
    ]);
  });

  it('posts fallback description when MIMO_API_KEY is not set', async () => {
    const { main } = require('../../scripts/dailyDigest');
    await main();

    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    const [, desc, opts] = notifyDiscord.mock.calls[0];
    expect(desc).toContain('Bookings');
    expect(desc).toContain('Revenue');
    expect(desc).toContain('Signups');
    expect(opts.title).toContain('Daily Digest');
    expect(opts.fields.length).toBeGreaterThan(9);
  });

  it('uses AI summary when MIMO_API_KEY is set', async () => {
    process.env.MIMO_API_KEY = 'test-key';
    const { main } = require('../../scripts/dailyDigest');
    await main();

    expect(callMimo).toHaveBeenCalledTimes(1);
    expect(callMimo).toHaveBeenCalledWith(expect.objectContaining({
      maxTokens: 1024,
      temperature: 0.2,
    }));
    const [, desc] = notifyDiscord.mock.calls[0];
    expect(desc).toBe('AI summary: revenue strong, 2 disputes open.');
  });

  it('falls back when MiMo throws', async () => {
    process.env.MIMO_API_KEY = 'test-key';
    callMimo.mockRejectedValueOnce(new Error('API down'));
    const { main } = require('../../scripts/dailyDigest');
    await main();

    const [, desc] = notifyDiscord.mock.calls[0];
    expect(desc).toContain('Bookings');
    expect(desc).toContain('Revenue');
  });

  it('includes dispute fields in embed', async () => {
    const { main } = require('../../scripts/dailyDigest');
    await main();

    const [, , opts] = notifyDiscord.mock.calls[0];
    const disputesOpened = opts.fields.find((f) => f.name === 'Disputes opened');
    const openDisputes = opts.fields.find((f) => f.name === 'Open disputes');
    expect(disputesOpened).toBeDefined();
    expect(openDisputes).toBeDefined();
  });

  it('includes enriched revenue fields (commission, supplier payout)', async () => {
    const { main } = require('../../scripts/dailyDigest');
    await main();

    const [, , opts] = notifyDiscord.mock.calls[0];
    const commission = opts.fields.find((f) => f.name === 'Commission');
    const payout = opts.fields.find((f) => f.name === 'Supplier payout');
    expect(commission.value).toContain('187.61');
    expect(payout.value).toContain('1063.14');
  });

  it('includes status breakdown, reviews, payouts, pay-later', async () => {
    const { main } = require('../../scripts/dailyDigest');
    await main();

    const [, , opts] = notifyDiscord.mock.calls[0];
    const statuses = opts.fields.find((f) => f.name === 'Statuses');
    const reviews = opts.fields.find((f) => f.name === 'New reviews');
    const payouts = opts.fields.find((f) => f.name === 'Payouts');
    const payLater = opts.fields.find((f) => f.name === 'Pay-later');
    expect(statuses.value).toContain('CONFIRMED=4');
    expect(statuses.value).toContain('REFUNDED=1');
    expect(reviews.value).toContain('avg 4.6');
    expect(payouts.value).toContain('900');
    expect(payLater.value).toBe('3');
  });

  it('handles backup log failures gracefully', async () => {
    execSync.mockImplementation(() => { throw new Error('no such file'); });
    const { main } = require('../../scripts/dailyDigest');
    await main();

    const [, , opts] = notifyDiscord.mock.calls[0];
    const backupField = opts.fields.find((f) => f.name === 'Last backup');
    expect(backupField.value).toBe('no backups recorded');
  });

  it('returns weekly digest when DIGEST_PERIOD=week', async () => {
    process.env.DIGEST_PERIOD = 'week';
    const { main } = require('../../scripts/dailyDigest');
    await main();

    const [, , opts] = notifyDiscord.mock.calls[0];
    expect(opts.title).toContain('Weekly Digest');
    const bookingsField = opts.fields.find((f) => f.name.includes('7 days'));
    expect(bookingsField).toBeDefined();
  });

  it('collectDigest returns payload without posting', async () => {
    const { collectDigest } = require('../../scripts/dailyDigest');
    const payload = await collectDigest();
    expect(notifyDiscord).not.toHaveBeenCalled();
    expect(payload.title).toContain('Digest');
    expect(payload.fields.length).toBeGreaterThan(9);
  });
});

