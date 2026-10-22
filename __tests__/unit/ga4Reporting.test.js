/**
 * GA4 Data API reporting — the read side of the analytics integration.
 *
 * The riskiest property here is not the HTTP call, it is what the caller tells
 * the supplier afterwards. Three claims must always be distinguishable:
 *
 *   "we cannot see GA4"   → isConfigured() false / GA4_NOT_CONFIGURED
 *   "GA4 is unreachable"  → GA4_REPORT_FAILED
 *   "nobody looked"       → a real, empty row set
 *
 * A dashboard that renders all three as a table of zeros is lying twice, so
 * those are the cases under test — plus the supplier scoping, because GA4
 * reports the whole property and one supplier must never see another's sales.
 */
const crypto = require('crypto');

// A real RSA key so the JWT-signing path is exercised for real rather than
// mocked past.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = {
  client_email: 'ga4-reporter@my-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

const GA4 = require('../../src/core/services/ga4Reporting');

function configuredEnv() {
  process.env.GA4_PROPERTY_ID = 'properties/123456789';
  process.env.GA4_SERVICE_ACCOUNT_JSON = JSON.stringify(SERVICE_ACCOUNT);
  delete process.env.GA4_SERVICE_ACCOUNT_FILE;
  delete process.env.GA4_EXCLUDE_ITEM_IDS;
  GA4.resetTokenCache();
}

function clearEnv() {
  delete process.env.GA4_PROPERTY_ID;
  delete process.env.GA4_SERVICE_ACCOUNT_JSON;
  delete process.env.GA4_SERVICE_ACCOUNT_FILE;
  delete process.env.GA4_EXCLUDE_ITEM_IDS;
  GA4.resetTokenCache();
}

/** A fetch double that answers the token exchange and the report. */
function fakeFetch({ rows = [], reportStatus = 200, tokenStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      if (tokenStatus !== 200) {
        return { ok: false, status: tokenStatus, text: async () => 'bad token' };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-123', expires_in: 3600 }) };
    }
    if (reportStatus !== 200) {
      return { ok: false, status: reportStatus, text: async () => 'quota exceeded' };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        rows: rows.map((r) => ({
          dimensionValues: [{ value: r.itemId }, { value: r.itemName }],
          metricValues: [
            { value: String(r.itemsViewed) },
            { value: String(r.itemsAddedToCart) },
            { value: String(r.itemsPurchased) },
            { value: String(r.itemRevenue) },
          ],
        })),
      }),
    };
  };
  impl.calls = calls;
  return impl;
}

beforeEach(() => {
  configuredEnv();
});

afterEach(() => {
  clearEnv();
});

describe('isConfigured — "we cannot see GA4" is never "no data"', () => {
  it('is false with nothing set', () => {
    clearEnv();
    expect(GA4.isConfigured()).toBe(false);
  });

  it('is false when only the property id is set', () => {
    process.env.GA4_PROPERTY_ID = '123';
    delete process.env.GA4_SERVICE_ACCOUNT_JSON;
    expect(GA4.isConfigured()).toBe(false);
  });

  it('is false when the inline service account is not JSON', () => {
    process.env.GA4_SERVICE_ACCOUNT_JSON = 'definitely-not-json';
    expect(GA4.isConfigured()).toBe(false);
  });

  it('is true with a property id and a service account', () => {
    expect(GA4.isConfigured()).toBe(true);
  });
});

describe('fetchItemFunnel', () => {
  it('refuses with GA4_NOT_CONFIGURED rather than returning empty rows', async () => {
    clearEnv();
    await expect(GA4.fetchItemFunnel({ from: '2026-09-01', to: '2026-10-22' }, { fetchImpl: fakeFetch() }))
      .rejects
      .toMatchObject({ code: 'GA4_NOT_CONFIGURED' });
  });

  it('asks GA4 for exactly the funnel metrics the ecommerce report shows', async () => {
    const fetchImpl = fakeFetch({ rows: [] });

    await GA4.fetchItemFunnel({ from: '2026-09-01', to: '2026-10-22' }, { fetchImpl });

    const reportCall = fetchImpl.calls.find((c) => c.url.includes('runReport'));
    expect(reportCall).toBeTruthy();
    expect(reportCall.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport');

    const body = JSON.parse(reportCall.options.body);
    expect(body.dateRanges).toEqual([{ startDate: '2026-09-01', endDate: '2026-10-22' }]);
    expect(body.dimensions.map((d) => d.name)).toEqual(['itemId', 'itemName']);
    expect(body.metrics.map((m) => m.name)).toEqual([
      'itemsViewed',
      'itemsAddedToCart',
      'itemsPurchased',
      'itemRevenue',
    ]);
    // Authenticated with the exchanged token, not an API key.
    expect(reportCall.options.headers.Authorization).toBe('Bearer tok-123');
  });

  it('exchanges the service-account assertion for a token first', async () => {
    const fetchImpl = fakeFetch({ rows: [] });

    await GA4.fetchItemFunnel({ from: '2026-09-01', to: '2026-10-22' }, { fetchImpl });

    const tokenCall = fetchImpl.calls.find((c) => c.url.includes('oauth2.googleapis.com/token'));
    expect(tokenCall).toBeTruthy();
    const params = new URLSearchParams(tokenCall.options.body);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = params.get('assertion');
    // The assertion must be a real RS256 JWT with our service-account email.
    const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    expect(payload.iss).toBe('ga4-reporter@my-project.iam.gserviceaccount.com');
    expect(payload.scope).toContain('analytics.readonly');
  });

  it('reuses the cached token across calls', async () => {
    const fetchImpl = fakeFetch({ rows: [] });

    await GA4.fetchItemFunnel({ from: '2026-09-01', to: '2026-10-22' }, { fetchImpl });
    await GA4.fetchItemFunnel({ from: '2026-09-01', to: '2026-10-22' }, { fetchImpl });

    const tokenCalls = fetchImpl.calls.filter((c) => c.url.includes('oauth2.googleapis.com'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('reports an unreachable GA4 as an error, not as an empty funnel', async () => {
    const fetchImpl = fakeFetch({ reportStatus: 429 });

    await expect(GA4.fetchItemFunnel({ from: '2026-09-01', to: '2026-10-22' }, { fetchImpl }))
      .rejects
      .toMatchObject({ code: 'GA4_REPORT_FAILED' });
  });

  it('flattens the GA4 matrix into rows', async () => {
    const fetchImpl = fakeFetch({
      rows: [
        { itemId: 'tour-1', itemName: 'Accra Guided City Tour', itemsViewed: 120, itemsAddedToCart: 9, itemsPurchased: 1, itemRevenue: 70 },
      ],
    });

    const rows = await GA4.fetchItemFunnel({ from: '2026-09-01', to: '2026-10-22' }, { fetchImpl });

    expect(rows).toEqual([
      { itemId: 'tour-1', itemName: 'Accra Guided City Tour', itemsViewed: 120, itemsAddedToCart: 9, itemsPurchased: 1, itemRevenue: 70 },
    ]);
  });
});

describe('shapeRows — supplier scoping and shares', () => {
  const row = (itemId, over = {}) => ({
    itemId,
    itemName: over.itemName || itemId,
    itemsViewed: 0,
    itemsAddedToCart: 0,
    itemsPurchased: 0,
    itemRevenue: 0,
    ...over,
  });

  it('keeps only the supplier’s own tours and COUNTS what it hid', () => {
    const shaped = GA4.shapeRows(
      [
        row('tour-1', { itemsPurchased: 1, itemRevenue: 70 }),
        row('competitor-tour', { itemsPurchased: 5, itemRevenue: 900 }),
      ],
      { ownedTourIds: ['tour-1'] },
    );

    expect(shaped.rows).toHaveLength(1);
    expect(shaped.rows[0].itemId).toBe('tour-1');
    // Hidden ≠ nothing: the count is reported so the number is interpretable.
    expect(shaped.excludedCount).toBe(1);
    // And the shares are computed over the supplier's own rows only.
    expect(shaped.rows[0].itemRevenueSharePct).toBe(100);
  });

  it('drops configured test products (e.g. a "credential check" tour)', () => {
    const shaped = GA4.shapeRows(
      [
        row('tour-1', { itemRevenue: 70 }),
        row('test-tour', { itemRevenue: 0, itemsPurchased: 1 }),
      ],
      { ownedTourIds: ['tour-1', 'test-tour'], excludeItemIds: ['test-tour'] },
    );

    expect(shaped.rows.map((r) => r.itemId)).toEqual(['tour-1']);
    expect(shaped.excludedCount).toBe(1);
  });

  it('computes shares of revenue and purchases, rounding to one decimal', () => {
    const shaped = GA4.shapeRows(
      [
        row('tour-1', { itemsPurchased: 1, itemRevenue: 70 }),
        row('tour-2', { itemsPurchased: 3, itemRevenue: 210 }),
      ],
      { ownedTourIds: ['tour-1', 'tour-2'] },
    );

    expect(shaped.rows[0].itemId).toBe('tour-2'); // sorted by revenue desc
    expect(shaped.rows[0].itemRevenueSharePct).toBe(75);
    expect(shaped.rows[0].itemsPurchasedSharePct).toBe(75);
    expect(shaped.rows[1].itemRevenueSharePct).toBe(25);
  });

  it('reads 0% — never NaN% — over an empty window', () => {
    const shaped = GA4.shapeRows([], { ownedTourIds: ['tour-1'] });

    expect(shaped.rows).toEqual([]);
    expect(shaped.totals).toEqual({ itemsViewed: 0, itemsAddedToCart: 0, itemsPurchased: 0, itemRevenue: 0 });
  });

  it('totals across the supplier’s own rows', () => {
    const shaped = GA4.shapeRows(
      [
        row('tour-1', { itemsViewed: 120, itemsAddedToCart: 9, itemsPurchased: 1, itemRevenue: 70 }),
        row('tour-2', { itemsViewed: 60, itemsAddedToCart: 2, itemsPurchased: 2, itemRevenue: 152 }),
      ],
      { ownedTourIds: ['tour-1', 'tour-2'] },
    );

    expect(shaped.totals).toEqual({ itemsViewed: 180, itemsAddedToCart: 11, itemsPurchased: 3, itemRevenue: 222 });
  });
});
