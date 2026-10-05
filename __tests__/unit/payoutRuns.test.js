jest.mock('../../src/core/services/prismaClient', () => {
  const tx = {
    supplierCharge: { findMany: jest.fn(), updateMany: jest.fn() },
    payoutRequest: { create: jest.fn() },
    booking: { updateMany: jest.fn() },
  };
  return {
    supplierProfile: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    payoutMethod: { findFirst: jest.fn(), count: jest.fn() },
    booking: { findMany: jest.fn(), aggregate: jest.fn() },
    payoutRequest: { create: jest.fn(), findFirst: jest.fn() },
    supplierCharge: { findMany: jest.fn(), updateMany: jest.fn() },
    notification: { findFirst: jest.fn() },
    $transaction: jest.fn((fn) => fn(tx)),
    __tx: tx,
  };
});

jest.mock('../../src/core/services/getConfig', () => jest.fn());
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn().mockResolvedValue(undefined),
  enqueueEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn() }));
jest.mock('../../src/core/services/channelEmbeds', () => ({
  approvalPayoutRequest: jest.fn(() => ({ content: 'embed', opts: {} })),
}));

const prisma = require('../../src/core/services/prismaClient');
const getConfig = require('../../src/core/services/getConfig');
const { logActivity } = require('../../src/core/services/auditLogger');
const { enqueueNotification, enqueueEmail } = require('../../src/core/services/queue');
const {
  isRunDate,
  nextRunAt,
  lastRunAt,
  cyclePeriodFor,
  getSupplierRequestWindow,
  notifyDuePayoutWindows,
  nextEffectiveDate,
  resolveEffectiveCycle,
  buildPayoutPlan,
  getDefaultCycle,
  autoRunsEnabled,
  updateSupplierPayoutPlan,
  compareSchedulesForTriage,
  generateDuePayoutRuns,
} = require('../../src/core/services/payoutRuns');

beforeEach(() => {
  jest.clearAllMocks();
  getConfig.mockImplementation(async (key, fallback) => {
    if (key === 'payout.default_cycle') return 'TWICE_MONTHLY';
    if (key === 'payout.auto_generate_enabled') return 'true';
    return fallback;
  });
});

describe('run-date math', () => {
  it('identifies run dates per cadence', () => {
    // 2026-10-01 is a Thursday; 2026-10-05 is a Monday.
    expect(isRunDate('MONTHLY', new Date(2026, 9, 1))).toBe(true);
    expect(isRunDate('MONTHLY', new Date(2026, 9, 15))).toBe(false);

    expect(isRunDate('TWICE_MONTHLY', new Date(2026, 9, 1))).toBe(true);
    expect(isRunDate('TWICE_MONTHLY', new Date(2026, 9, 15))).toBe(true);
    expect(isRunDate('TWICE_MONTHLY', new Date(2026, 9, 16))).toBe(false);

    expect(isRunDate('WEEKLY', new Date(2026, 9, 5))).toBe(true); // Monday
    expect(isRunDate('WEEKLY', new Date(2026, 9, 6))).toBe(false);
  });

  it('finds the next run strictly after the current moment', () => {
    // From Thursday 1 Oct: weekly → Mon 5 Oct; twice-monthly → Thu 15 Oct.
    expect(nextRunAt('WEEKLY', new Date(2026, 9, 1, 10))).toEqual(new Date(2026, 9, 5));
    expect(nextRunAt('TWICE_MONTHLY', new Date(2026, 9, 1, 10))).toEqual(new Date(2026, 9, 15));
    expect(nextRunAt('MONTHLY', new Date(2026, 9, 1, 10))).toEqual(new Date(2026, 10, 1));
  });

  it('skips today once the run day has started', () => {
    // On the run day itself the dashboard shows the *next* payout.
    expect(nextRunAt('MONTHLY', new Date(2026, 9, 1, 0, 30))).toEqual(new Date(2026, 10, 1));
    expect(lastRunAt('MONTHLY', new Date(2026, 9, 1, 0, 30))).toEqual(new Date(2026, 9, 1));
  });

  it('computes the accumulation window each run pays out', () => {
    const weekly = cyclePeriodFor('WEEKLY', new Date(2026, 9, 5)); // Mon 5 Oct
    expect(weekly.start).toEqual(new Date(2026, 8, 28)); // previous Monday
    expect(weekly.end.getDate()).toBe(4); // Sunday 4 Oct

    const twiceFirst = cyclePeriodFor('TWICE_MONTHLY', new Date(2026, 9, 15));
    expect(twiceFirst.start).toEqual(new Date(2026, 9, 1));
    expect(twiceFirst.end.getDate()).toBe(14);

    const twiceSecond = cyclePeriodFor('TWICE_MONTHLY', new Date(2026, 10, 1)); // 1 Nov
    expect(twiceSecond.start).toEqual(new Date(2026, 9, 15));
    expect(twiceSecond.end.getDate()).toBe(31);

    const monthly = cyclePeriodFor('MONTHLY', new Date(2026, 10, 1)); // 1 Nov
    expect(monthly.start).toEqual(new Date(2026, 9, 1));
    expect(monthly.end.getDate()).toBe(31);
  });

  it('wraps the monthly window across the new year', () => {
    const jan = cyclePeriodFor('MONTHLY', new Date(2027, 0, 1));
    expect(jan.start).toEqual(new Date(2026, 11, 1));
    expect(jan.end.getFullYear()).toBe(2026);
  });
});

describe('plan resolution', () => {
  it('schedules a switch for the 1st of next month', () => {
    expect(nextEffectiveDate(new Date(2026, 9, 24))).toEqual(new Date(2026, 10, 1, 0, 0, 0, 0));
    // December wraps into January of the next year.
    expect(nextEffectiveDate(new Date(2026, 11, 24))).toEqual(new Date(2027, 0, 1, 0, 0, 0, 0));
  });

  it('uses the pending cadence only once its effective date has arrived', () => {
    const profile = {
      payoutCycle: 'MONTHLY',
      payoutCyclePending: 'WEEKLY',
      payoutCyclePendingAt: new Date(2026, 10, 1),
    };
    expect(resolveEffectiveCycle(profile, new Date(2026, 9, 20))).toBe('MONTHLY');
    expect(resolveEffectiveCycle(profile, new Date(2026, 10, 2))).toBe('WEEKLY');
  });

  it('reports autoManaged=false for a supplier with no schedule', () => {
    const plan = buildPayoutPlan({ payoutCycle: null }, { now: new Date(2026, 9, 20) });
    expect(plan.autoManaged).toBe(false);
    expect(plan.scheduleLabel).toBeNull();
    expect(plan.nextRunAt).toBeNull();
  });

  it('builds a labelled plan for an enrolled supplier', () => {
    const plan = buildPayoutPlan(
      { payoutCycle: 'WEEKLY' },
      { now: new Date(2026, 9, 1, 10), defaultCycle: 'TWICE_MONTHLY', autoRuns: true }
    );
    expect(plan.autoManaged).toBe(true);
    expect(plan.scheduleLabel).toMatch(/Monday/);
    expect(plan.nextRunAt).toEqual(new Date(2026, 9, 5));
    expect(plan.nextRunPeriodLabel).toBe('Sep 28 – Oct 4');
  });

  it('falls back to the default when the configured default is invalid', async () => {
    getConfig.mockResolvedValue('fortnightly');
    expect(await getDefaultCycle()).toBe('TWICE_MONTHLY');
  });

  it('reads the scheduler kill switch', async () => {
    getConfig.mockImplementation(async (key, fallback) => (key === 'payout.auto_generate_enabled' ? 'false' : fallback));
    expect(await autoRunsEnabled()).toBe(false);
  });
});

describe('updateSupplierPayoutPlan', () => {
  it('applies a first enrolment immediately', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ id: 'sp1', payoutCycle: null, payoutCyclePending: null });
    prisma.supplierProfile.update.mockResolvedValue({});

    await updateSupplierPayoutPlan({ supplierId: 'sup1', cycle: 'WEEKLY' });

    const data = prisma.supplierProfile.update.mock.calls[0][0].data;
    expect(data.payoutCycle).toBe('WEEKLY');
    expect(data.payoutCyclePending).toBeNull();
    expect(data.payoutCycleEffectiveAt).toBeInstanceOf(Date);
  });

  it('schedules a later switch for the 1st of next month', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ id: 'sp1', payoutCycle: 'MONTHLY', payoutCyclePending: null });
    prisma.supplierProfile.update.mockResolvedValue({});

    await updateSupplierPayoutPlan({ supplierId: 'sup1', cycle: 'WEEKLY' });

    const data = prisma.supplierProfile.update.mock.calls[0][0].data;
    expect(data.payoutCycle).toBeUndefined();
    expect(data.payoutCyclePending).toBe('WEEKLY');
    expect(data.payoutCyclePendingAt).toBeInstanceOf(Date);
  });

  it('rejects an unknown cadence', async () => {
    await expect(updateSupplierPayoutPlan({ supplierId: 'sup1', cycle: 'DAILY' })).rejects.toThrow(/Invalid payout plan/);
  });
});

describe('compareSchedulesForTriage', () => {
  const run = (day) => new Date(2026, 9, day).toISOString();

  it('puts the soonest run first, then orders by name', () => {
    const rows = [
      { name: 'Zeta', plan: { nextRunAt: run(20) } },
      { name: 'Alpha', plan: { nextRunAt: run(5) } },
      { name: 'Beta', plan: { nextRunAt: run(5) } },
    ];
    expect([...rows].sort(compareSchedulesForTriage).map((r) => r.name))
      .toEqual(['Alpha', 'Beta', 'Zeta']);
  });

  it('sorts rows with no scheduled run last', () => {
    const rows = [
      { name: 'None', plan: { nextRunAt: null } },
      { name: 'Soon', plan: { nextRunAt: run(5) } },
    ];
    expect([...rows].sort(compareSchedulesForTriage).map((r) => r.name)).toEqual(['Soon', 'None']);
  });

  it('tolerates { profile, plan } rows and bare plans', () => {
    const rows = [
      { profile: { user: { name: 'Bee' } }, plan: { nextRunAt: run(6) } },
      { profile: { user: { name: 'Ay' } }, plan: { nextRunAt: run(6) } },
    ];
    expect([...rows].sort(compareSchedulesForTriage).map((r) => r.profile.user.name)).toEqual(['Ay', 'Bee']);
    expect(compareSchedulesForTriage({ nextRunAt: run(5) }, { nextRunAt: run(6) })).toBeLessThan(0);
  });
});

describe('generateDuePayoutRuns', () => {
  const eligibleBooking = {
    id: 'bk1',
    currency: 'USD',
    grossAmount: 120,
    platformCommission: 20,
    supplierPayout: 100,
  };

  function happyPath() {
    // 1st call = promoteDueCycles (none pending), 2nd = enrolled suppliers.
    prisma.supplierProfile.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'sp1', userId: 'sup1', payoutCycle: 'TWICE_MONTHLY', user: { id: 'sup1', name: 'Kadelo', email: 'k@example.com' } }]);
    prisma.payoutMethod.findFirst.mockResolvedValue({ id: 'pm1', verified: true });
    prisma.booking.findMany.mockResolvedValue([eligibleBooking]);
    prisma.__tx.supplierCharge.findMany.mockResolvedValue([]);
    prisma.__tx.payoutRequest.create.mockImplementation(async ({ data }) => ({
      id: 'pr1',
      requestNumber: data.requestNumber,
      amount: data.amount,
      currency: data.currency,
      bookingCount: data.bookingCount,
      runKey: data.runKey,
      autoGenerated: data.autoGenerated,
      items: [],
    }));
    prisma.__tx.booking.updateMany.mockResolvedValue({ count: 1 });
  }

  it('does nothing when the scheduler is switched off', async () => {
    getConfig.mockImplementation(async (key, fallback) => (key === 'payout.auto_generate_enabled' ? 'false' : fallback));
    const report = await generateDuePayoutRuns(new Date(2026, 9, 1, 1));
    expect(report).toEqual({ generated: 0, skipped: 'disabled' });
    expect(prisma.supplierProfile.findMany).not.toHaveBeenCalled();
  });

  it('does nothing on a day that is not a run date', async () => {
    prisma.supplierProfile.findMany.mockResolvedValueOnce([]); // promote
    const report = await generateDuePayoutRuns(new Date(2026, 9, 7, 1)); // Wednesday
    expect(report.generated).toBe(0);
    expect(report.dueCycles).toEqual([]);
    expect(prisma.payoutRequest.create).not.toHaveBeenCalled();
  });

  it('generates an automated request on a run date', async () => {
    happyPath();
    const report = await generateDuePayoutRuns(new Date(2026, 9, 1, 1));

    expect(report.generated).toBe(1);
    expect(report.requests).toBe(1);

    const createArg = prisma.__tx.payoutRequest.create.mock.calls[0][0].data;
    expect(createArg.autoGenerated).toBe(true);
    expect(createArg.status).toBe('PROCESSING');
    expect(createArg.amount).toBe(100);
    expect(createArg.cycleLabel).toBe('Sep 15–30'); // the 1 Oct run pays the 15–30 Sep window
    expect(createArg.runKey).toContain('auto:sup1:');
    expect(createArg.runKey).toContain('USD');

    expect(prisma.__tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { payoutStatus: 'REQUESTED' } })
    );
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout_request.auto_generated' }));
  });

  it('skips suppliers with no eligible funds', async () => {
    prisma.supplierProfile.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'sp1', userId: 'sup1', payoutCycle: 'TWICE_MONTHLY', user: { id: 'sup1' } }]);
    prisma.payoutMethod.findFirst.mockResolvedValue({ id: 'pm1', verified: true });
    prisma.booking.findMany.mockResolvedValue([]);

    const report = await generateDuePayoutRuns(new Date(2026, 9, 1, 1));
    expect(report.generated).toBe(0);
    expect(report.skippedNoFunds).toBe(1);
    expect(prisma.__tx.payoutRequest.create).not.toHaveBeenCalled();
  });

  it('skips suppliers without a verified payout method', async () => {
    prisma.supplierProfile.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'sp1', userId: 'sup1', payoutCycle: 'MONTHLY', user: { id: 'sup1' } }]);
    prisma.payoutMethod.findFirst.mockResolvedValue(null);

    const report = await generateDuePayoutRuns(new Date(2026, 9, 1, 1));
    expect(report.generated).toBe(0);
    expect(report.skippedNoMethod).toBe(1);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('rolls funds over when the balance is below the minimum threshold', async () => {
    getConfig.mockImplementation(async (key, fallback) => {
      if (key === 'payout.min_threshold') return '50';
      if (key === 'payout.auto_generate_enabled') return 'true';
      return fallback;
    });
    prisma.supplierProfile.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'sp1', userId: 'sup1', payoutCycle: 'MONTHLY', user: { id: 'sup1' } }]);
    prisma.payoutMethod.findFirst.mockResolvedValue({ id: 'pm1', verified: true });
    prisma.booking.findMany.mockResolvedValue([{ ...eligibleBooking, supplierPayout: 30 }]);

    const report = await generateDuePayoutRuns(new Date(2026, 9, 1, 1));
    expect(report.generated).toBe(0);
    expect(report.skippedBlocked).toBe(1);
    expect(prisma.__tx.payoutRequest.create).not.toHaveBeenCalled();
  });

  it('only targets payable suppliers (approved or active)', async () => {
    happyPath();
    await generateDuePayoutRuns(new Date(2026, 9, 1, 1));

    // findMany[0] is the plan-promotion read; findMany[1] is the run sweep.
    const where = prisma.supplierProfile.findMany.mock.calls[1][0].where;
    expect(where.status).toEqual({ in: ['APPROVED', 'ACTIVE'] });
  });

  it('never pays out demo/seed bookings', async () => {
    happyPath();
    await generateDuePayoutRuns(new Date(2026, 9, 1, 1));

    expect(prisma.booking.findMany.mock.calls[0][0].where).toMatchObject({
      isSimulated: false,
      payoutStatus: 'ELIGIBLE',
    });
  });

  it('nudges a supplier whose payouts cannot be generated without a method', async () => {
    prisma.supplierProfile.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'sp1', userId: 'sup1', payoutCycle: 'MONTHLY', user: { id: 'sup1' } }]);
    prisma.payoutMethod.findFirst.mockResolvedValue(null);
    prisma.notification.findFirst.mockResolvedValue(null);

    const report = await generateDuePayoutRuns(new Date(2026, 9, 1, 1));

    expect(report.skippedNoMethod).toBe(1);
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the nudge when one was already sent today', async () => {
    prisma.supplierProfile.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'sp1', userId: 'sup1', payoutCycle: 'MONTHLY', user: { id: 'sup1' } }]);
    prisma.payoutMethod.findFirst.mockResolvedValue(null);
    prisma.notification.findFirst.mockResolvedValue({ id: 'n1' });

    const report = await generateDuePayoutRuns(new Date(2026, 9, 1, 1));

    expect(report.skippedNoMethod).toBe(1);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('keeps going when one supplier is blocked by open fees', async () => {
    // fee >= amount → createRequestsForBookings throws; the sweep must survive.
    prisma.supplierProfile.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'sp1', userId: 'sup1', payoutCycle: 'MONTHLY', user: { id: 'sup1' } }]);
    prisma.payoutMethod.findFirst.mockResolvedValue({ id: 'pm1', verified: true });
    prisma.booking.findMany.mockResolvedValue([eligibleBooking]);
    prisma.__tx.supplierCharge.findMany.mockResolvedValue([{ id: 'c1', amount: 100 }]);

    const report = await generateDuePayoutRuns(new Date(2026, 9, 1, 1));
    expect(report.generated).toBe(0);
    expect(report.skippedBlocked).toBe(1);
  });
});

// The manual-request window an enrolled supplier gets: their own run day, for
// 24 hours. Dates are passed in explicitly rather than faking the clock, so
// every case is exact.
describe('getSupplierRequestWindow', () => {
  const plan = (cycle) => ({ autoManaged: true, cycle, autoRunsEnabled: true });

  it('returns null for a supplier with no schedule', () => {
    // The legacy twice-monthly window applies instead.
    expect(getSupplierRequestWindow({ autoManaged: false }, new Date(2026, 9, 5))).toBeNull();
    expect(getSupplierRequestWindow(null, new Date(2026, 9, 5))).toBeNull();
  });

  it('opens 24 hours before the run and closes when it fires', () => {
    // Mon 5 Oct 2026 is a WEEKLY run day, so the window is Sun 4 Oct -> Mon 5
    // Oct. Asking during it is a genuine "pay me early": the sweep has not run
    // yet, so the eligible balance is still there to take.
    const sunday = getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 4, 10, 0));
    expect(sunday.open).toBe(true);
    expect(sunday.opensAt).toEqual(new Date(2026, 9, 4));
    expect(sunday.closesAt).toEqual(new Date(2026, 9, 5));
    expect(sunday.runDay).toEqual(new Date(2026, 9, 5));
    expect(sunday.source).toBe('schedule');
  });

  it('is shut on the run day itself, because the sweep owns the period', () => {
    // This is the regression that made the old button dead: the window used to
    // open on the run day, so the only hours it was ever open were the hours
    // *after* the scheduler had swept every ELIGIBLE booking into a request.
    const justAfterTheSweep = getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 5, 9, 30));
    expect(justAfterTheSweep.open).toBe(false);
    // And at the very first minute of the run day, before any sweep has fired.
    expect(getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 5, 0, 0)).open).toBe(false);
  });

  it('stays shut for the whole cycle between windows', () => {
    // Tue, Thu, Sat: three days with nothing to do, because the money is not
    // due until Monday.
    expect(getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 6, 12, 0)).open).toBe(false);
    expect(getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 8, 12, 0)).open).toBe(false);
    expect(getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 10, 12, 0)).open).toBe(false);
  });

  it('reopens the day before the next run', () => {
    // Sun 11 Oct for the Mon 12 Oct run.
    expect(getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 10, 23, 59)).open).toBe(false);
    expect(getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 11, 0, 0)).open).toBe(true);
    expect(getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 11, 23, 59)).open).toBe(true);
  });

  it('labels the period the upcoming run pays, not the one already swept', () => {
    // The card shows "Covering <period>" from the plan's nextRunPeriodLabel and
    // the window's own label. They must be the same run, or the page contradicts
    // itself with a window that closes before the period it covers begins.
    const sunday = getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 4, 10, 0));
    expect(sunday.cycle.start).toEqual(new Date(2026, 8, 28));
    expect(sunday.cycle.end).toEqual(new Date(2026, 9, 4, 23, 59, 59, 999));
    expect(sunday.cycle.label).toBeTruthy();

    const planForSunday = buildPayoutPlan(
      { payoutCycle: 'WEEKLY' },
      { now: new Date(2026, 9, 4, 10, 0) }
    );
    expect(planForSunday.nextRunAt).toEqual(sunday.runDay);
    expect(planForSunday.nextRunPeriodLabel).toBe(sunday.cycle.label);
  });

  it('follows the supplier cadence, not the calendar', () => {
    // A twice-monthly supplier's window is the day before the 15th.
    const before15 = getSupplierRequestWindow(plan('TWICE_MONTHLY'), new Date(2026, 9, 14, 10, 0));
    expect(before15.open).toBe(true);
    expect(before15.closesAt).toEqual(new Date(2026, 9, 15));
    expect(before15.cycle.start).toEqual(new Date(2026, 9, 1));
    expect(before15.cycle.end).toEqual(new Date(2026, 9, 14, 23, 59, 59, 999));

    // Same day, different cadence: the weekly supplier is shut (Monday is four
    // days out) and the twice-monthly one is open. Cadences must not bleed.
    expect(getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 14, 10, 0)).open).toBe(false);
    // And a weekly supplier is open on a day the twice-monthly one is not due.
    expect(getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 11, 10, 0)).open).toBe(true);
    expect(getSupplierRequestWindow(plan('TWICE_MONTHLY'), new Date(2026, 9, 11, 10, 0)).open).toBe(false);
  });

  it('opens for the monthly cadence before the 1st', () => {
    const m = getSupplierRequestWindow(plan('MONTHLY'), new Date(2026, 9, 31, 10, 0));
    expect(m.open).toBe(true);
    expect(m.closesAt).toEqual(new Date(2026, 10, 1));
    expect(m.cycle.start).toEqual(new Date(2026, 9, 1));
    expect(m.cycle.end).toEqual(new Date(2026, 9, 31, 23, 59, 59, 999));
    expect(getSupplierRequestWindow(plan('MONTHLY'), new Date(2026, 9, 15, 10, 0)).open).toBe(false);
  });

  it('agrees with itself at the exact boundaries', () => {
    const before = getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 3, 23, 59, 59, 999));
    expect(before.open).toBe(false);
    const atOpen = getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 4, 0, 0));
    expect(atOpen.open).toBe(true);
    const atClose = getSupplierRequestWindow(plan('WEEKLY'), new Date(2026, 9, 5, 0, 0));
    expect(atClose.open).toBe(false);
  });

});

// Window opened -> tell the supplier they can pull their money forward, with the
// bookings and the total. The condition that matters is "there is actually
// something to request": a supplier whose payout is already on its way must
// never be asked to request it again.
describe('notifyDuePayoutWindows', () => {
  const profile = {
    id: 'sp1',
    userId: 'sup1',
    payoutCycle: 'TWICE_MONTHLY',
    user: { id: 'sup1', name: 'Coastal Routes GH', email: 'ops@example.com', roles: [] },
  };
  const bookings = [
    { id: 'b1', bookingNumber: 'GHA-1', tour: { title: 'Kakum Canopy Walk' }, travelDate: new Date('2026-09-20'), supplierPayout: 100, currency: 'USD' },
    { id: 'b2', bookingNumber: 'GHA-2', tour: { title: 'Cape Coast Castle' }, travelDate: new Date('2026-09-21'), supplierPayout: 75.5, currency: 'USD' },
  ];
  // Wed 14 Oct 2026: inside the 24h window that leads into the TWICE_MONTHLY
  // run on Thu 15 Oct. This is deliberately *not* the run day - the window opens
  // the day before, and a cron that only fired on the run day would never reach
  // this code with an open window.
  const IN_WINDOW = new Date(2026, 9, 14, 6, 0);
  // Thu 15 Oct, after the run has swept the balance: nothing left to ask for.
  const RUN_DAY = new Date(2026, 9, 15, 6, 0);

  beforeEach(() => {
    prisma.supplierProfile.findMany.mockResolvedValue([profile]);
    prisma.payoutMethod.findFirst.mockResolvedValue({ id: 'pm1', verified: true });
    prisma.booking.findMany.mockResolvedValue(bookings);
    prisma.payoutRequest.findFirst.mockResolvedValue(null);
    // clearAllMocks resets calls, not implementations, so a mockResolvedValue
    // set by an earlier suite in this file would leak in and make this look
    // like the supplier was already notified. Set it every time.
    prisma.notification.findFirst.mockResolvedValue(null);
  });

  it('notifies while the window is open when there is something to request', async () => {
    const report = await notifyDuePayoutWindows(IN_WINDOW);

    expect(report.notified).toBe(1);
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    const n = enqueueNotification.mock.calls[0][0];
    expect(n.userId).toBe('sup1');
    expect(n.type).toBe('PAYOUT_REQUEST_WINDOW_OPEN');
    expect(n.message).toContain('175.50 USD');
    expect(n.message).toContain('2 bookings');
    expect(n.message).toContain('Oct 1–14');
    // Closes when the run fires, i.e. at midnight into the 15th, not at the end
    // of it. That is what makes the request an early payout rather than a race
    // with the sweep.
    expect(new Date(n.data.closesAt)).toEqual(new Date(2026, 9, 15));
    expect(new Date(n.data.runDay)).toEqual(new Date(2026, 9, 15));
    expect(new Date(n.data.opensAt)).toEqual(new Date(2026, 9, 14));
    // Auto is the default, so the copy has to name the fallback rather than
    // imply the money is stranded if they do nothing.
    expect(n.message).toMatch(/paid automatically/i);

    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    const e = enqueueEmail.mock.calls[0][0];
    expect(e.type).toBe('payout-request-window-open');
    expect(e.cycleLabel).toBe('Oct 1–14');
    expect(new Date(e.runDay)).toEqual(new Date(2026, 9, 15));
    expect(e.bookings).toHaveLength(2);
    expect(e.bookings[0]).toMatchObject({ bookingNumber: 'GHA-1', supplierPayout: 100 });
    expect(e.currency).toBe('USD');
  });

  it('stays quiet when an open request already covers the period', async () => {
    prisma.payoutRequest.findFirst.mockResolvedValue({ id: 'pr1' });

    const report = await notifyDuePayoutWindows(IN_WINDOW);

    expect(report.notified).toBe(0);
    expect(report.skippedAlreadyRequested).toBe(1);
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('stays quiet when nothing is eligible yet', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    const report = await notifyDuePayoutWindows(IN_WINDOW);

    expect(report.notified).toBe(0);
    expect(report.skippedNoFunds).toBe(1);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('stays quiet without a verified payout method', async () => {
    prisma.payoutMethod.findFirst.mockResolvedValue(null);

    const report = await notifyDuePayoutWindows(IN_WINDOW);

    expect(report.notified).toBe(0);
    expect(report.skippedNoMethod).toBe(1);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('notifies at most once per window however often the cron fires', async () => {
    // The cron runs often and the window is open all day, so an unguarded sweep
    // would send an email per tick for one cycle.
    const first = await notifyDuePayoutWindows(IN_WINDOW);
    expect(first.notified).toBe(1);

    // The notification from that sweep now exists.
    prisma.notification.findFirst.mockResolvedValue({ id: 'n1' });

    const second = await notifyDuePayoutWindows(new Date(2026, 9, 14, 18, 0));
    expect(second.notified).toBe(0);
    expect(second.skippedNotified).toBe(1);

    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
  });

  it('does notify again for the next cycle window', async () => {
    // The dedupe is scoped to one window, not to the supplier forever: a week
    // later they must be told about the next batch of money.
    prisma.notification.findFirst.mockResolvedValueOnce({ id: 'n1' });
    await notifyDuePayoutWindows(IN_WINDOW);

    // The next TWICE_MONTHLY window: Fri 14 Nov -> Sat 15 Nov.
    prisma.notification.findFirst.mockResolvedValueOnce(null);
    const later = await notifyDuePayoutWindows(new Date(2026, 10, 14, 6, 0));
    expect(later.notified).toBe(1);
    expect(later.dueCycles).toEqual(['TWICE_MONTHLY']);

    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a day no window is open', async () => {
    // Sat 3 Oct: no cadence is within 24h of a run.
    const report = await notifyDuePayoutWindows(new Date(2026, 9, 3));

    expect(report.dueCycles).toEqual([]);
    expect(report.notified).toBe(0);
    expect(prisma.supplierProfile.findMany).not.toHaveBeenCalled();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('stays quiet on the run day itself, once the sweep has taken the balance', async () => {
    // The regression guard for the notification trigger: the window is anchored
    // to the *next* run, so a run day finds it shut and nobody is told to
    // request money the scheduler is already paying out.
    const report = await notifyDuePayoutWindows(RUN_DAY);

    expect(report.dueCycles).toEqual([]);
    expect(report.notified).toBe(0);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('only queries suppliers whose cadence actually has an open window', async () => {
    await notifyDuePayoutWindows(IN_WINDOW);

    // Wed 14 Oct is within 24h of the 15th (twice-monthly) but four days from
    // Monday (weekly), so a weekly supplier must not be swept up by the query.
    expect(prisma.supplierProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ payoutCycle: { in: ['TWICE_MONTHLY'] } }),
      })
    );
  });
});
