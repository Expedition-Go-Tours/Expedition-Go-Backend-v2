jest.mock('../../utils/prismaClient', () => ({
  booking: { updateMany: jest.fn() },
}));

jest.mock('../../utils/getConfig');

const prisma = require('../../utils/prismaClient');
const getConfig = require('../../utils/getConfig');
const {
  getCurrentCycle,
  getPreviousCycle,
  getRequestWindow,
  getClearanceBufferDays,
  sweepEarningsEligibility,
  formatCycleLabel,
} = require('../../utils/payoutCycles');

describe('formatCycleLabel', () => {
  it('formats a within-month range', () => {
    expect(formatCycleLabel(new Date(2026, 7, 1), new Date(2026, 7, 15))).toBe('Aug 1–15');
  });

  it('formats a cross-month range', () => {
    expect(formatCycleLabel(new Date(2026, 0, 16), new Date(2026, 0, 31))).toBe('Jan 16–31');
    expect(formatCycleLabel(new Date(2026, 11, 16), new Date(2027, 0, 5))).toBe('Dec 16 – Jan 5');
  });
});

describe('getCurrentCycle', () => {
  it('returns cycle A during the first half of the month', () => {
    const cycle = getCurrentCycle(new Date(2026, 7, 10));
    expect(cycle.slot).toBe('A');
    expect(cycle.start).toEqual(new Date(2026, 7, 1));
    expect(cycle.end).toEqual(new Date(2026, 7, 15, 23, 59, 59, 999));
    expect(cycle.label).toBe('Aug 1–15');
  });

  it('treats the 15th as still cycle A', () => {
    expect(getCurrentCycle(new Date(2026, 7, 15)).slot).toBe('A');
  });

  it('returns cycle B from the 16th through end of month', () => {
    const cycle = getCurrentCycle(new Date(2026, 7, 20));
    expect(cycle.slot).toBe('B');
    expect(cycle.start).toEqual(new Date(2026, 7, 16));
    expect(cycle.end).toEqual(new Date(2026, 7, 31, 23, 59, 59, 999));
    expect(cycle.label).toBe('Aug 16–31');
  });

  it('handles February correctly', () => {
    expect(getCurrentCycle(new Date(2028, 1, 25)).end.getDate()).toBe(29);
    expect(getCurrentCycle(new Date(2026, 1, 25)).end.getDate()).toBe(28);
  });
});

describe('getPreviousCycle', () => {
  it('returns cycle A of the current month when currently in slot B', () => {
    const prev = getPreviousCycle(new Date(2026, 7, 20));
    expect(prev.slot).toBe('A');
    expect(prev.label).toBe('Aug 1–15');
  });

  it('returns cycle B of the previous month when currently in slot A', () => {
    const prev = getPreviousCycle(new Date(2026, 7, 10));
    expect(prev.slot).toBe('B');
    expect(prev.label).toBe('Jul 16–31');
  });

  it('wraps to December of the prior year in January', () => {
    const prev = getPreviousCycle(new Date(2026, 0, 5));
    expect(prev.slot).toBe('B');
    expect(prev.label).toBe('Dec 16–31');
    expect(prev.end.getFullYear()).toBe(2025);
  });
});

describe('getRequestWindow', () => {
  beforeEach(() => {
    getConfig.mockReset();
    getConfig.mockImplementation(async (key, fallback) => fallback);
  });

  it('opens the cycle-A window between the 16th and 20th', async () => {
    const win = await getRequestWindow(new Date(2026, 7, 18));
    expect(win.open).toBe(true);
    expect(win.cycle.slot).toBe('A');
    expect(win.cycle.label).toBe('Aug 1–15');
    expect(win.start).toEqual(new Date(2026, 7, 16));
    expect(win.end).toEqual(new Date(2026, 7, 20, 23, 59, 59, 999));
  });

  it('opens the cycle-B window between the 1st and 5th, pointing at last month', async () => {
    const win = await getRequestWindow(new Date(2026, 7, 3));
    expect(win.open).toBe(true);
    expect(win.cycle.slot).toBe('B');
    expect(win.cycle.label).toBe('Jul 16–31');
  });

  it('points the January cycle-B window at December of the prior year', async () => {
    const win = await getRequestWindow(new Date(2026, 0, 4));
    expect(win.open).toBe(true);
    expect(win.cycle.slot).toBe('B');
    expect(win.cycle.label).toBe('Dec 16–31');
  });

  it('reports the next cycle-A window as upcoming between the two windows', async () => {
    const win = await getRequestWindow(new Date(2026, 7, 12));
    expect(win.open).toBe(false);
    // Next opening is cycle A of September
    expect(win.cycle.slot).toBe('A');
    expect(win.cycle.label).toBe('Sep 1–15');
    expect(win.start.getMonth()).toBe(8);
  });

  it('reports the upcoming cycle-B window early in the month after it closed', async () => {
    // Day 6-15 falls through to next cycle-A window; day 21+ also closed
    const win = await getRequestWindow(new Date(2026, 7, 25));
    expect(win.open).toBe(false);
    expect(win.cycle.slot).toBe('A');
  });

  it('honors custom configured window days', async () => {
    getConfig.mockImplementation(async (key) =>
      key === 'payout.window_cycle1_days' ? '17,19' : null
    );
    const win = await getRequestWindow(new Date(2026, 7, 18));
    expect(win.open).toBe(true);
    expect(win.start).toEqual(new Date(2026, 7, 17));
    expect(win.end).toEqual(new Date(2026, 7, 19, 23, 59, 59, 999));

    const outside = await getRequestWindow(new Date(2026, 7, 16));
    expect(outside.open).toBe(false);
  });

  it('falls back to defaults for malformed config values', async () => {
    getConfig.mockImplementation(async () => 'garbage');
    const win = await getRequestWindow(new Date(2026, 7, 18));
    expect(win.open).toBe(true);
    expect(win.start.getDate()).toBe(16);
  });
});

describe('getClearanceBufferDays', () => {
  beforeEach(() => {
    getConfig.mockReset();
    getConfig.mockImplementation(async (key, fallback) => fallback);
  });

  it('defaults to 0', async () => {
    expect(await getClearanceBufferDays()).toBe(0);
  });

  it('parses a configured value', async () => {
    getConfig.mockImplementation(async () => '3');
    expect(await getClearanceBufferDays()).toBe(3);
  });

  it('falls back to 0 for invalid values', async () => {
    getConfig.mockImplementation(async () => 'abc');
    expect(await getClearanceBufferDays()).toBe(0);
    getConfig.mockImplementation(async () => '-2');
    expect(await getClearanceBufferDays()).toBe(0);
  });
});

describe('sweepEarningsEligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getConfig.mockReset();
    getConfig.mockImplementation(async (key, fallback) => fallback);
  });

  it('flips past-travel-date paid bookings to ELIGIBLE with no buffer', async () => {
    prisma.booking.updateMany.mockResolvedValue({ count: 7 });
    const count = await sweepEarningsEligibility();
    expect(count).toBe(7);
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          payoutStatus: 'PENDING',
          paymentStatus: 'SUCCEEDED',
          status: { in: ['CONFIRMED', 'COMPLETED'] },
          disputes: { none: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } },
        }),
        data: { payoutStatus: 'ELIGIBLE' },
      })
    );
    const where = prisma.booking.updateMany.mock.calls[0][0].where;
    expect(where.travelDate.lt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('applies the clearance buffer to the cutoff', async () => {
    getConfig.mockImplementation(async () => '5');
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    await sweepEarningsEligibility();
    const where = prisma.booking.updateMany.mock.calls[0][0].where;
    const expectedMin = Date.now() - 5 * 24 * 60 * 60 * 1000 - 1000;
    const expectedMax = Date.now() - 5 * 24 * 60 * 60 * 1000 + 1000;
    expect(where.travelDate.lt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(where.travelDate.lt.getTime()).toBeLessThanOrEqual(expectedMax);
  });
});
