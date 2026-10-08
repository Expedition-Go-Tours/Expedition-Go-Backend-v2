/**
 * Funnel engine unit tests.
 *
 * computeFunnel runs exactly seven prisma.$queryRaw calls inside one
 * Promise.all (steps, views/day, checkouts/day, bookings/day, median, abandoned
 * overview, abandoned byTour) — the mock queue below feeds them in order.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  $queryRaw: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const { computeFunnel } = require('../../src/core/services/funnelEngine');

const day1 = new Date('2026-10-01');
const day2 = new Date('2026-10-02');

const SCENARIO = {
  steps: [
    { step: 'viewed', users: 500 },
    { step: 'checkout_started', users: 60 },
    { step: 'booking_completed', users: 12 },
  ],
  viewsByDay: [
    { day: day2, users: 300 },
    { day: day1, users: 200 },
  ],
  checkoutsByDay: [{ day: day1, users: 40 }, { day: day2, users: 20 }],
  bookingsByDay: [{ day: day1, users: 9 }, { day: day2, users: 3 }],
  median: [{ median_minutes: 8 }],
  abandoned: [{ checkouts: 48, value: 12500 }],
  byTour: [
    { tourId: 't1', tourTitle: 'Cape Coast', checkouts: 20, value: 5200 },
    { tourId: 't2', tourTitle: 'Kakum', checkouts: 12, value: 3100 },
  ],
};

function mockScenario(overrides = {}) {
  prisma.$queryRaw
    .mockReset()
    .mockResolvedValueOnce(overrides.steps ?? SCENARIO.steps)
    .mockResolvedValueOnce(overrides.viewsByDay ?? SCENARIO.viewsByDay)
    .mockResolvedValueOnce(overrides.checkoutsByDay ?? SCENARIO.checkoutsByDay)
    .mockResolvedValueOnce(overrides.bookingsByDay ?? SCENARIO.bookingsByDay)
    .mockResolvedValueOnce(overrides.median ?? SCENARIO.median)
    .mockResolvedValueOnce(overrides.abandoned ?? SCENARIO.abandoned)
    .mockResolvedValueOnce(overrides.byTour ?? SCENARIO.byTour);
}

describe('computeFunnel', () => {
  const startDate = new Date('2026-09-01');

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('computes the 3-step funnel (no cart step) with correct rates', async () => {
    mockScenario();

    const result = await computeFunnel({ startDate, brand: { key: 'ghana', source: 'GHANA', role: 'ghana' } });

    expect(result.funnel.map((f) => f.step)).toEqual(['viewed', 'checkout_started', 'booking_completed']);
    expect(result.funnel[0]).toMatchObject({ step: 'viewed', users: 500, overallPct: 100, dropOff: null });
    expect(result.conversionRates).toEqual({ viewToCheckout: 12, checkoutToBook: 20, overall: 2.4 });
    expect(result.funnel[1].dropOff).toBe('88.0%'); // 100 - 12
    expect(result.funnel[2].dropOff).toBe('80.0%'); // 100 - 20
  });

  it('merges the three per-day series, filling gaps with zeroes and sorting by day', async () => {
    mockScenario({
      viewsByDay: [{ day: day2, users: 300 }], // day1 missing on views
      checkoutsByDay: [{ day: day1, users: 40 }], // day2 missing on checkouts
      bookingsByDay: [{ day: day1, users: 9 }],
    });

    const result = await computeFunnel({ startDate, brand: null });

    expect(result.dailyTrend).toEqual([
      { day: day1.toISOString().slice(0, 10), views: 0, checkouts: 40, bookings: 9 },
      { day: day2.toISOString().slice(0, 10), views: 300, checkouts: 0, bookings: 0 },
    ]);
  });

  it('reports the biggest step-pair leak by absolute user count', async () => {
    mockScenario(); // viewed 500 → checkout 60 (−440), checkout 60 → booked 12 (−48)

    const result = await computeFunnel({ startDate, brand: null });

    expect(result.insights.biggestDropOff).toEqual({
      from: 'viewed',
      to: 'checkout_started',
      users: 440,
      rate: 88,
    });
  });

  it('picks the checkout→booking leak when it is the larger absolute drop', async () => {
    mockScenario({
      steps: [
        { step: 'viewed', users: 100 },
        { step: 'checkout_started', users: 90 },
        { step: 'booking_completed', users: 10 },
      ],
    });

    const result = await computeFunnel({ startDate, brand: null });

    expect(result.insights.biggestDropOff).toEqual({
      from: 'checkout_started',
      to: 'booking_completed',
      users: 80,
      rate: 88.9,
    });
  });

  it('maps median checkout time and abandoned-checkout insights', async () => {
    mockScenario({
      median: [{ median_minutes: 8 }],
      abandoned: [{ checkouts: 48, value: 12500 }],
      byTour: [
        { tourId: 't1', tourTitle: 'Cape Coast', checkouts: 20, value: 5200 },
        { tourId: 't2', tourTitle: null, checkouts: 12, value: 3100 },
      ],
    });

    const result = await computeFunnel({ startDate, brand: null });

    expect(result.insights.medianTimeToBookMinutes).toBe(8);
    expect(result.insights.abandoned.checkouts).toBe(48);
    expect(result.insights.abandoned.value).toBe(12500);
    expect(result.insights.abandoned.byTour[0].tourTitle).toBe('Cape Coast');
    expect(result.insights.abandoned.byTour[1].tourTitle).toBe('Unknown');
  });

  it('handles an empty window without throwing', async () => {
    prisma.$queryRaw.mockReset();
    prisma.$queryRaw.mockResolvedValue([]);

    const result = await computeFunnel({ startDate, brand: null });

    expect(result.funnel.map((f) => f.users)).toEqual([0, 0, 0]);
    expect(result.conversionRates.overall).toBe(0);
    expect(result.dailyTrend).toEqual([]);
    expect(result.insights.abandoned).toEqual({ checkouts: 0, value: 0, byTour: [] });
    expect(result.insights.medianTimeToBookMinutes).toBe(0);
  });

  it('issues exactly seven queries in one batch', async () => {
    mockScenario();

    await computeFunnel({ startDate, brand: null });

    // All seven run concurrently (single Promise.all), so accounting is stable.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(7);
  });
});