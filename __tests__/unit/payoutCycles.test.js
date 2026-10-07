jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { updateMany: jest.fn() },
}));

jest.mock('../../src/core/services/getConfig');

const prisma = require('../../src/core/services/prismaClient');
const getConfig = require('../../src/core/services/getConfig');
const {
  getCurrentCycle,
  getPreviousCycle,
  getRequestWindow,
  getClearanceBufferDays,
  sweepEarningsEligibility,
  formatCycleLabel,
  isWeekend,
  nextBusinessDay,
  invoiceWindowFor,
  nextInvoiceWindow,
  invoiceWindowsDueOn,
} = require('../../src/core/services/payoutCycles');

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
          status: { in: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] },
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

// ── Finance v3 engine: business days + invoice windows ───────────────────────

describe('v3 business-day helpers', () => {
  it('flags Saturday and Sunday as weekends', () => {
    expect(isWeekend(new Date(2026, 9, 3))).toBe(true); // Sat 3 Oct
    expect(isWeekend(new Date(2026, 9, 4))).toBe(true); // Sun 4 Oct
    expect(isWeekend(new Date(2026, 9, 5))).toBe(false); // Mon 5 Oct
    expect(isWeekend(new Date(2026, 9, 2))).toBe(false); // Fri 2 Oct
  });

  it('pushes a weekend forward to Monday, keeping weekdays as-is', () => {
    expect(nextBusinessDay(new Date(2026, 9, 3))).toEqual(new Date(2026, 9, 5)); // Sat → Mon
    expect(nextBusinessDay(new Date(2026, 9, 4))).toEqual(new Date(2026, 9, 5)); // Sun → Mon
    expect(nextBusinessDay(new Date(2026, 9, 5))).toEqual(new Date(2026, 9, 5)); // Mon stays
    expect(nextBusinessDay(new Date(2026, 9, 2))).toEqual(new Date(2026, 9, 2)); // Fri stays
  });
});

describe('invoiceWindowFor — TWICE_MONTHLY', () => {
  it('maps a 1st–15th activity date to slot A', () => {
    const w = invoiceWindowFor(new Date(2026, 9, 10), 'TWICE_MONTHLY');
    expect(w.cycle).toBe('TWICE_MONTHLY');
    expect(w.slot).toBe('A');
    expect(w.start).toEqual(new Date(2026, 9, 1));
    expect(w.end).toEqual(new Date(2026, 9, 15, 23, 59, 59, 999));
    expect(w.invoicedOn).toEqual(new Date(2026, 9, 16)); // Fri 16 Oct — a business day
    expect(w.paidOn).toEqual(new Date(2026, 9, 20)); // Tue 20 Oct
    expect(w.label).toBe('Oct 1–15');
  });

  it('keeps the 15th in slot A and the 16th in slot B', () => {
    expect(invoiceWindowFor(new Date(2026, 9, 15), 'TWICE_MONTHLY').slot).toBe('A');
    expect(invoiceWindowFor(new Date(2026, 9, 16), 'TWICE_MONTHLY').slot).toBe('B');
  });

  it('skips a weekend invoice date — slot A invoiced on the Monday after a Saturday 16th', () => {
    // May 2026: the 16th is a Saturday, so the invoice date is Mon 18 May.
    const w = invoiceWindowFor(new Date(2026, 4, 12), 'TWICE_MONTHLY');
    expect(w.slot).toBe('A');
    expect(w.invoicedOn).toEqual(new Date(2026, 4, 18));
    expect(w.paidOn).toEqual(new Date(2026, 4, 20)); // Wed 20 May
  });

  it('maps a 16th–EOM activity date to slot B, invoiced on the 1st business day', () => {
    const w = invoiceWindowFor(new Date(2026, 9, 20), 'TWICE_MONTHLY');
    expect(w.cycle).toBe('TWICE_MONTHLY');
    expect(w.slot).toBe('B');
    expect(w.start).toEqual(new Date(2026, 9, 16));
    expect(w.end).toEqual(new Date(2026, 9, 31, 23, 59, 59, 999));
    expect(w.invoicedOn).toEqual(new Date(2026, 10, 2)); // Sun 1 Nov → Mon 2 Nov
    expect(w.paidOn).toEqual(new Date(2026, 10, 5)); // Thu 5 Nov
    expect(w.label).toBe('Oct 16–31');
  });

  it('ends a slot B window on the real end of month, including February', () => {
    const w = invoiceWindowFor(new Date(2026, 1, 20), 'TWICE_MONTHLY');
    expect(w.slot).toBe('B');
    expect(w.end).toEqual(new Date(2026, 1, 28, 23, 59, 59, 999));
    expect(w.invoicedOn).toEqual(new Date(2026, 2, 2)); // Sun 1 Mar → Mon 2 Mar
  });
});

describe('invoiceWindowFor — MONTHLY', () => {
  it('treats the whole month as one window, invoiced on the 1st business day', () => {
    const w = invoiceWindowFor(new Date(2026, 9, 20), 'MONTHLY');
    expect(w.cycle).toBe('MONTHLY');
    expect(w.slot).toBe('M');
    expect(w.start).toEqual(new Date(2026, 9, 1));
    expect(w.end).toEqual(new Date(2026, 9, 31, 23, 59, 59, 999));
    expect(w.invoicedOn).toEqual(new Date(2026, 10, 2)); // Sun 1 Nov → Mon 2 Nov
    expect(w.paidOn).toEqual(new Date(2026, 10, 5)); // Thu 5 Nov
    expect(w.label).toBe('Oct 1–31');
  });

  it('maps an early-month activity date to the same monthly window', () => {
    const w = invoiceWindowFor(new Date(2026, 9, 2), 'MONTHLY');
    expect(w.slot).toBe('M');
    expect(w.start).toEqual(new Date(2026, 9, 1));
    expect(w.end).toEqual(new Date(2026, 9, 31, 23, 59, 59, 999));
  });
});

describe('nextInvoiceWindow — MONTHLY', () => {
  it('shows the current month while its invoice has not been generated', () => {
    const w = nextInvoiceWindow('MONTHLY', new Date(2026, 9, 7, 10, 0));
    expect(w.start).toEqual(new Date(2026, 9, 1));
    expect(w.end).toEqual(new Date(2026, 9, 31, 23, 59, 59, 999));
    expect(w.invoicedOn).toEqual(new Date(2026, 10, 2));
  });

  it('rolls forward once the invoice date has passed', () => {
    const w = nextInvoiceWindow('MONTHLY', new Date(2026, 10, 3, 10, 0)); // after Mon 2 Nov invoice
    expect(w.start).toEqual(new Date(2026, 10, 1));
    expect(w.end).toEqual(new Date(2026, 10, 30, 23, 59, 59, 999));
    expect(w.invoicedOn).toEqual(new Date(2026, 11, 1)); // Tue 1 Dec
  });

  it('resets on the invoice date itself — the estimate moves to the next window', () => {
    const w = nextInvoiceWindow('MONTHLY', new Date(2026, 10, 2, 0, 0)); // Mon 2 Nov 00:00
    expect(w.start).toEqual(new Date(2026, 10, 1));
  });
});

describe('nextInvoiceWindow — TWICE_MONTHLY', () => {
  it('shows slot A of this month during 1st–15th', () => {
    const w = nextInvoiceWindow('TWICE_MONTHLY', new Date(2026, 9, 7, 10, 0));
    expect(w.slot).toBe('A');
    expect(w.start).toEqual(new Date(2026, 9, 1));
    expect(w.end).toEqual(new Date(2026, 9, 15, 23, 59, 59, 999));
    expect(w.invoicedOn).toEqual(new Date(2026, 9, 16));
  });

  it('shows slot B of this month once slot A has invoiced', () => {
    const w = nextInvoiceWindow('TWICE_MONTHLY', new Date(2026, 9, 17, 10, 0));
    expect(w.slot).toBe('B');
    expect(w.start).toEqual(new Date(2026, 9, 16));
    expect(w.end).toEqual(new Date(2026, 9, 31, 23, 59, 59, 999));
    expect(w.invoicedOn).toEqual(new Date(2026, 10, 2));
  });

  it('resets to slot A of the next month after slot B invoices', () => {
    const w = nextInvoiceWindow('TWICE_MONTHLY', new Date(2026, 10, 3, 10, 0));
    expect(w.slot).toBe('A');
    expect(w.start).toEqual(new Date(2026, 10, 1));
    expect(w.invoicedOn).toEqual(new Date(2026, 10, 16)); // Mon 16 Nov
  });

  it('resets exactly on the slot A invoice date', () => {
    const w = nextInvoiceWindow('TWICE_MONTHLY', new Date(2026, 9, 16, 0, 0));
    expect(w.slot).toBe('B');
    expect(w.start).toEqual(new Date(2026, 9, 16));
  });

  it('returns null for an unknown cadence', () => {
    expect(nextInvoiceWindow('WEEKLY', new Date(2026, 9, 7))).toBeNull();
    expect(nextInvoiceWindow('DAILY', new Date(2026, 9, 7))).toBeNull();
  });
});

describe('invoiceWindowsDueOn — the daily invoice job', () => {
  it('is due for slot A on its (business) 16th', () => {
    const due = invoiceWindowsDueOn(new Date(2026, 9, 16)); // Fri 16 Oct
    expect(due).toHaveLength(1);
    expect(due[0].cycle).toBe('TWICE_MONTHLY');
    expect(due[0].slot).toBe('A');
    expect(due[0].start).toEqual(new Date(2026, 9, 1));
  });

  it('is due for slot B and MONTHLY on the 1st business day of the month', () => {
    const due = invoiceWindowsDueOn(new Date(2026, 10, 2)); // Mon 2 Nov (1st was Sunday)
    expect(due).toHaveLength(2);
    const cycles = due.map((w) => `${w.cycle}:${w.slot}`).sort();
    expect(cycles).toEqual(['MONTHLY:M', 'TWICE_MONTHLY:B']);
    expect(due.find((w) => w.slot === 'B').start).toEqual(new Date(2026, 9, 16)); // Oct slot B
    expect(due.find((w) => w.slot === 'M').start).toEqual(new Date(2026, 9, 1)); // Oct monthly
  });

  it('is empty on ordinary mid-month weekdays', () => {
    expect(invoiceWindowsDueOn(new Date(2026, 9, 13))).toEqual([]); // Tue 13 Oct
    expect(invoiceWindowsDueOn(new Date(2026, 9, 5))).toEqual([]); // Mon 5 Oct
  });

  it('is empty on the weekend itself — the window rolls to Monday', () => {
    // Aug 2026: 16th is a Sunday, so nothing is due on it; the slot A window
    // is due on Mon 17 Aug instead.
    expect(invoiceWindowsDueOn(new Date(2026, 7, 16))).toEqual([]);
    const due = invoiceWindowsDueOn(new Date(2026, 7, 17));
    expect(due).toHaveLength(1);
    expect(due[0].slot).toBe('A');
    expect(due[0].invoicedOn).toEqual(new Date(2026, 7, 17));
  });
});
