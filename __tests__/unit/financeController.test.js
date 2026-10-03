jest.mock('../../src/core/services/prismaClient', () => ({
  payoutRequest: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../../src/core/services/getConfig', () => jest.fn());
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn().mockResolvedValue(undefined),
  enqueueEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn() }));
jest.mock('../../src/core/services/channelEmbeds', () => ({
  approvalPayoutRequest: jest.fn(() => ({ content: 'embed', opts: {} })),
}));

// Keep the real date helpers and the real request-window math — only the
// pieces that need a supplier or a database are stubbed. The window itself is
// stubbed here because its arithmetic is covered in payoutRuns.test.js; this
// file is about what the controller does with it.
// Spread the real module: payoutRuns needs `formatCycleLabel` at require time,
// and only these three need to be controllable here.
jest.mock('../../src/core/services/payoutCycles', () => {
  const actual = jest.requireActual('../../src/core/services/payoutCycles');
  return {
    ...actual,
    getRequestWindow: jest.fn(),
    getCurrentCycle: jest.fn(() => ({ start: new Date(2026, 9, 1), end: new Date(2026, 9, 15), label: 'Oct 1–15' })),
    getClearanceBufferDays: jest.fn(() => 7),
  };
});

jest.mock('../../src/core/services/payoutRuns', () => {
  const actual = jest.requireActual('../../src/core/services/payoutRuns');
  return {
    ...actual,
    getSupplierPayoutPlan: jest.fn(),
    getSupplierRequestWindow: jest.fn(),
    resolvePayoutMethod: jest.fn(),
    selectEligibleBookings: jest.fn(),
    createRequestsForBookings: jest.fn(),
    notifyPayoutRequestsCreated: jest.fn().mockResolvedValue(undefined),
  };
});

const prisma = require('../../src/core/services/prismaClient');
const { logActivity } = require('../../src/core/services/auditLogger');
const { getRequestWindow } = require('../../src/core/services/payoutCycles');
const {
  getSupplierPayoutPlan,
  getSupplierRequestWindow,
  resolvePayoutMethod,
  selectEligibleBookings,
  createRequestsForBookings,
  notifyPayoutRequestsCreated,
} = require('../../src/core/services/payoutRuns');
const financeController = require('../../src/core/domain/financeController');

const schedule = (over = {}) => ({
  autoManaged: true,
  cycle: 'TWICE_MONTHLY',
  scheduleLabel: 'Twice a month — paid on the 1st & 15th',
  autoRunsEnabled: true,
  nextRunAt: new Date(2026, 10, 1),
  ...over,
});

const openWindow = {
  open: true,
  opensAt: new Date(2026, 9, 15),
  closesAt: new Date(2026, 9, 17, 23, 59, 59, 999),
  cycle: { start: new Date(2026, 9, 1), end: new Date(2026, 9, 14, 23, 59, 59, 999), label: 'Oct 1–14' },
  runDay: new Date(2026, 9, 15),
  source: 'schedule',
};

const closedWindow = { ...openWindow, open: false };

const createdRequest = {
  id: 'pr1',
  requestNumber: 'PR-20261015-000001',
  currency: 'USD',
  amount: 420,
  bookingCount: 3,
  status: 'PROCESSING',
  items: [],
};

async function invoke(body = {}) {
  const req = { supplierId: 'sup1', body, user: { id: 'admin1' } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await financeController.createPayoutRequest(req, res, next);
  return { res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.payoutRequest.findFirst.mockResolvedValue(null);
  resolvePayoutMethod.mockResolvedValue({ id: 'pm1', verified: true });
  selectEligibleBookings.mockResolvedValue([{ id: 'b1', currency: 'USD', supplierPayout: 420 }]);
  createRequestsForBookings.mockResolvedValue({ requests: [createdRequest], feesDeducted: 0 });
  notifyPayoutRequestsCreated.mockResolvedValue(undefined);
  logActivity.mockResolvedValue(undefined);
  getRequestWindow.mockResolvedValue({
    open: true,
    start: new Date(2026, 9, 1),
    end: new Date(2026, 9, 15),
    label: 'Oct 1–15',
    cycle: { start: new Date(2026, 9, 1), end: new Date(2026, 9, 15), label: 'Oct 1–15' },
  });
});

describe('createPayoutRequest — enrolled suppliers', () => {
  it('refuses outside the supplier own run window, with a 409 not a TypeError', async () => {
    // The branch used to shadow the catchAsync `next` callback with a date
    // string and then call it, so it threw "next is not a function" instead of
    // returning this response. Catching that is the point of this test.
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(closedWindow);

    const { res, next } = await invoke();

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/generated automatically/i);
    expect(err.message).toMatch(/can request manually between/i);
    expect(err.message).toMatch(/next payout is scheduled for/i);
    expect(createRequestsForBookings).not.toHaveBeenCalled();
  });

  it('accepts a request while the run window is open', async () => {
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(openWindow);

    const { res, next } = await invoke();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(createRequestsForBookings).toHaveBeenCalledTimes(1);
    expect(createRequestsForBookings.mock.calls[0][0]).toMatchObject({
      supplierId: 'sup1',
      autoGenerated: false,
    });
    // Labelled with the period that run pays, matching the auto-generated run.
    expect(createRequestsForBookings.mock.calls[0][0].cycleWindow.label).toBe('Oct 1–14');
  });

  it('lets a paused scheduler fall back to a manual request at any time', async () => {
    // autoRunsEnabled:false means the window is irrelevant — funds must never
    // be stranded because the scheduler is switched off.
    getSupplierPayoutPlan.mockResolvedValue(schedule({ autoRunsEnabled: false }));
    getSupplierRequestWindow.mockReturnValue(null);

    const { res, next } = await invoke();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(getSupplierRequestWindow).not.toHaveBeenCalled();
    expect(createRequestsForBookings).toHaveBeenCalledTimes(1);
  });
});

describe('createPayoutRequest — one open request per period', () => {
  it('blocks a second request for the same period and names the open one', async () => {
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(openWindow);
    prisma.payoutRequest.findFirst.mockResolvedValue({ requestNumber: 'PR-20261015-000042' });

    const { res, next } = await invoke();

    expect(res.status).not.toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('PR-20261015-000042');
    expect(createRequestsForBookings).not.toHaveBeenCalled();
  });

  it('checks the supplier whose request this is', async () => {
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(openWindow);

    await invoke();

    const where = prisma.payoutRequest.findFirst.mock.calls[0][0].where;
    expect(where.supplierId).toBe('sup1');
    expect(where.status.in).toEqual(['PROCESSING', 'APPROVED']);
    // Terminal states must not block: rejected/cancelled requests release the
    // bookings, so the supplier is free to ask again.
    expect(where.status.in).not.toContain('REJECTED');
    expect(where.status.in).not.toContain('CANCELLED');
  });

  it('allows a request when the only open one is from a different period', async () => {
    getSupplierPayoutPlan.mockResolvedValue(schedule());
    getSupplierRequestWindow.mockReturnValue(openWindow);
    // Nothing overlapping: the guard returns null and the request proceeds.
    prisma.payoutRequest.findFirst.mockResolvedValue(null);

    const { res } = await invoke();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('createPayoutRequest — legacy window flow', () => {
  it('refuses with a 400 when the calendar window is shut', async () => {
    getSupplierPayoutPlan.mockResolvedValue({ autoManaged: false, cycle: null });
    getRequestWindow.mockResolvedValue({
      open: false,
      start: new Date(2026, 10, 1),
      end: new Date(2026, 10, 5),
      label: 'Nov 1–15',
      cycle: { start: new Date(2026, 10, 1), end: new Date(2026, 10, 5), label: 'Nov 1–15' },
    });

    const { next } = await invoke();

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/withdrawal window is closed/i);
    expect(getSupplierRequestWindow).not.toHaveBeenCalled();
  });

  it('does not consult the schedule window when the supplier is not enrolled', async () => {
    getSupplierPayoutPlan.mockResolvedValue({ autoManaged: false, cycle: null });

    const { res } = await invoke();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(getSupplierRequestWindow).not.toHaveBeenCalled();
    expect(getRequestWindow).toHaveBeenCalled();
  });
});
