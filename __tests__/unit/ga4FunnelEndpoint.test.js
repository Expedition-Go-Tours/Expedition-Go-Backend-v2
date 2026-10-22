/**
 * GET /suppliers/analytics/ga4-funnel — the endpoint contract.
 *
 * The database has no row for "someone looked at this tour and left". This
 * endpoint is the only way a supplier learns that, so its failure modes must
 * never be dressed up as results: an unconfigured or unreachable GA4 answers
 * with a statement of that fact, never a table of zeros that reads as "nobody
 * is interested in my products".
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  tour: { findMany: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_k, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/emailService', () => ({ sendSupplierStatusEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/queue', () => ({ enqueueNotification: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/cloudinaryHelper', () => ({
  deleteCloudinaryImage: jest.fn(() => Promise.resolve()),
  isValidCloudinaryUrl: jest.fn(() => true),
}));
jest.mock('../../src/core/services/supplierCountry', () => ({ isGhanaSupplier: jest.fn(() => true) }));
jest.mock('../../src/core/services/supplierVerification', () => ({
  parseDocuments: jest.fn(() => []),
  parseVehiclePhotos: jest.fn(() => []),
  parseVehicles: jest.fn(() => []),
  parseGuides: jest.fn(() => []),
  upsertVerificationRecords: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/supplierApplicationPayload', () => ({
  parseSection: jest.fn(() => ({})),
  payoutMethodFromApplication: jest.fn(() => ({})),
  requestedPayoutCycle: jest.fn(() => null),
  requiredSupplierDocumentTypes: jest.fn(() => []),
  validateSupplierApplication: jest.fn(() => ({ errors: [] })),
}));
jest.mock('../../src/core/services/supplierVerificationRequirements', () => ({
  requirementsFor: jest.fn(() => ({})),
  SUPPLIER_CHOICES: {},
  SUPPLIER_CHOICE_IDS: [],
  documentationDeadlineAfter: jest.fn(() => null),
}));
jest.mock('../../config/firebaseAdmin', () => ({}));
jest.mock('../../src/core/services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/ga4Reporting', () => ({
  isConfigured: jest.fn(),
  fetchItemFunnel: jest.fn(),
  shapeRows: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const ga4Reporting = require('../../src/core/services/ga4Reporting');
const controller = require('../../src/core/domain/supplierController');

async function invoke(query = {}) {
  const req = { supplierId: 'supplier-1', query, user: { id: 'user-1' } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await controller.getGa4ProductFunnel(req, res, next);
  return { next, data: res.json.mock.calls[0]?.[0]?.data };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GA4_EXCLUDE_ITEM_IDS;
  prisma.tour.findMany.mockResolvedValue([
    { id: 'tour-1', title: 'Accra Guided City Tour' },
    { id: 'tour-2', title: 'Shai Hills Safari' },
  ]);
  ga4Reporting.shapeRows.mockImplementation((rows, opts) => ({
    rows,
    totals: { itemsViewed: 0, itemsAddedToCart: 0, itemsPurchased: 0, itemRevenue: 0 },
    excludedCount: 0,
  }));
});

describe('when GA4 cannot be seen', () => {
  it('answers enabled:false with a reason — never a table of zeros', async () => {
    ga4Reporting.isConfigured.mockReturnValue(false);

    const { data } = await invoke();

    expect(data.enabled).toBe(false);
    expect(data.reason).toMatch(/not configured/i);
    expect(data.reason).toMatch(/not zero/i);
    expect(data.rows).toEqual([]);
    // The controller must not pretend it measured anything.
    expect(ga4Reporting.fetchItemFunnel).not.toHaveBeenCalled();
  });

  it('answers 502 — not an empty funnel — when GA4 is unreachable', async () => {
    ga4Reporting.isConfigured.mockReturnValue(true);
    const failure = new Error('GA4 runReport failed (429): quota exceeded');
    failure.code = 'GA4_REPORT_FAILED';
    ga4Reporting.fetchItemFunnel.mockRejectedValue(failure);

    const { next } = await invoke();

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(502);
    expect(err.message).toMatch(/quota exceeded/);
  });
});

describe('when GA4 answers', () => {
  beforeEach(() => {
    ga4Reporting.isConfigured.mockReturnValue(true);
    ga4Reporting.fetchItemFunnel.mockResolvedValue([
      { itemId: 'tour-1', itemName: '', itemsViewed: 120, itemsAddedToCart: 9, itemsPurchased: 1, itemRevenue: 70 },
    ]);
  });

  it('scopes the report to the supplier’s own tours', async () => {
    await invoke();

    const [, opts] = ga4Reporting.shapeRows.mock.calls[0];
    expect(new Set(opts.ownedTourIds)).toEqual(new Set(['tour-1', 'tour-2']));
  });

  it('passes the test-product exclusion list through', async () => {
    process.env.GA4_EXCLUDE_ITEM_IDS = 'test-tour, credential-check';

    await invoke();

    const [, opts] = ga4Reporting.shapeRows.mock.calls[0];
    expect(opts.excludeItemIds).toEqual(['test-tour', 'credential-check']);
  });

  it('falls back to the catalogue title when the event carried no name', async () => {
    ga4Reporting.shapeRows.mockReturnValue({
      rows: [{ itemId: 'tour-1', itemName: '', itemsViewed: 1, itemsAddedToCart: 0, itemsPurchased: 0, itemRevenue: 0 }],
      totals: { itemsViewed: 1, itemsAddedToCart: 0, itemsPurchased: 0, itemRevenue: 0 },
      excludedCount: 0,
    });

    const { data } = await invoke();

    expect(data.rows[0].itemName).toBe('Accra Guided City Tour');
    expect(data.enabled).toBe(true);
  });

  it('rejects a reversed or malformed range instead of guessing', async () => {
    const reversed = await invoke({ from: '2026-10-22', to: '2026-09-01' });
    expect(reversed.next.mock.calls[0][0].statusCode).toBe(400);

    const malformed = await invoke({ from: '22/10/2026' });
    expect(malformed.next.mock.calls[0][0].statusCode).toBe(400);

    expect(ga4Reporting.fetchItemFunnel).not.toHaveBeenCalled();
  });

  it('defaults to the last 30 days when no range is given', async () => {
    await invoke();

    const [range] = ga4Reporting.fetchItemFunnel.mock.calls[0];
    const days = (new Date(range.to) - new Date(range.from)) / 86_400_000;
    expect(days).toBeCloseTo(30, 0);
  });
});
