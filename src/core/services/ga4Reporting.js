/**
 * GA4 Data API reporting — the READ side of the analytics integration.
 *
 * The write side (ga4Measurement.js) sends `purchase`/`refund` to GA4 and has
 * been doing so for a while. Nothing in this codebase could ever READ the
 * result back, so the supplier dashboard could only show what the database
 * knows (bookings, revenue) and never the funnel GA4 measures: how many people
 * VIEWED a product, how many ADDED IT TO CART, and how many bought it.
 *
 * This module closes that gap. It is deliberately small — service-account
 * JWT → OAuth2 token → one `runReport` call — and every function that can lie
 * has been designed not to:
 *
 *   - `isConfigured()` is the gate. Without GA4_PROPERTY_ID + service-account
 *     credentials the caller reports "not configured", which is a different
 *     statement from "zero activity". The dashboard must never render a row of
 *     zeros out of a server that cannot see GA4 at all.
 *   - `shapeRows()` never divides by zero and never invents a share: a product
 *     with no purchases gets `purchasedSharePct: 0`, not NaN.
 *   - rows are the supplier's OWN products only. GA4 sees the whole property
 *     (every tour on the storefront); the caller passes the tour ids it owns
 *     and everything else is counted in `excludedCount`, not silently dropped
 *     and never shown as someone else's sales.
 *
 * Configuration (all required):
 *   GA4_PROPERTY_ID=properties/123456789   (or bare 123456789)
 *   GA4_SERVICE_ACCOUNT_JSON=<the service-account JSON, inline>
 *     — or —
 *   GA4_SERVICE_ACCOUNT_FILE=/path/to/service-account.json
 *
 * The service account must have Viewer access to the GA4 property.
 */

const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

/**
 * Everything this report needs from GA4, named exactly as the Data API names
 * them. `itemsViewed` / `itemsAddedToCart` / `itemsPurchased` / `itemRevenue`
 * are the item-scoped metrics behind the same ecommerce report the GA4 UI
 * shows, so this table and that report are two views of one truth.
 */
const FUNNEL_DIMENSIONS = ['itemId', 'itemName'];
const FUNNEL_METRICS = ['itemsViewed', 'itemsAddedToCart', 'itemsPurchased', 'itemRevenue'];

/** Hard cap so one property with a huge catalogue cannot blow up a response. */
const MAX_ROWS = 500;

function propertyId() {
  const raw = process.env.GA4_PROPERTY_ID || '';
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Accept both `properties/123` (the API's own form) and a bare `123`.
  return trimmed.startsWith('properties/') ? trimmed : `properties/${trimmed}`;
}

/** The service-account key, from an inline JSON blob or a file path. */
function serviceAccount() {
  const inline = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (inline && inline.trim()) {
    try {
      return JSON.parse(inline);
    } catch {
      return null;
    }
  }
  const file = process.env.GA4_SERVICE_ACCOUNT_FILE;
  if (file && file.trim()) {
    try {
      return JSON.parse(fs.readFileSync(file.trim(), 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * True only when this server can actually reach GA4. The dashboard treats a
 * false here as "not configured" — never as "no data".
 */
function isConfigured() {
  const account = serviceAccount();
  return Boolean(
    propertyId() &&
    account &&
    account.client_email &&
    (account.private_key || account.privateKey)
  );
}

/**
 * Mint the service-account assertion Google expects: a short-lived RS256 JWT
 * signed with the account's private key. `private_key` values are usually
 * stored with literal `\n` escapes, so normalise those first.
 */
function signedAssertion(account) {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = String(account.private_key || account.privateKey).replace(/\\n/g, '\n');
  return jwt.sign(
    {
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    privateKey,
    { algorithm: 'RS256' },
  );
}

// One token per server: a deploy with real traffic should not mint a JWT per
// request. Cached until shortly before expiry.
let cachedToken = null;

function cachedTokenStillValid() {
  return Boolean(cachedToken && cachedToken.expiresAt > Date.now() + 60_000);
}

async function getAccessToken(fetchImpl = fetch) {
  if (cachedTokenStillValid()) return cachedToken.token;

  const account = serviceAccount();
  if (!account) {
    throw new Error('GA4 service-account credentials are not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signedAssertion(account),
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GA4 token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('GA4 token exchange returned no access_token');
  }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return cachedToken.token;
}

/** Test seam: forget the cached token so a test can observe a fresh exchange. */
function resetTokenCache() {
  cachedToken = null;
}

/** The `runReport` request body for the item funnel over one date range. */
function buildFunnelReportRequest({ from, to }) {
  return {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: FUNNEL_DIMENSIONS.map((name) => ({ name })),
    metrics: FUNNEL_METRICS.map((name) => ({ name })),
    orderBys: [{ metric: { metricName: 'itemRevenue' }, desc: true }],
    limit: MAX_ROWS,
  };
}

/**
 * GA4 returns one matrix (dimensionHeaders + rows of dimensionValues /
 * metricValues). Flatten it into objects. Pure — the tests own the shape.
 */
function flattenReport(report) {
  const rows = report?.rows || [];
  return rows.map((row) => {
    const dims = row.dimensionValues || [];
    const mets = row.metricValues || [];
    return {
      itemId: dims[0]?.value || '',
      itemName: dims[1]?.value || '',
      itemsViewed: Number(mets[0]?.value || 0),
      itemsAddedToCart: Number(mets[1]?.value || 0),
      itemsPurchased: Number(mets[2]?.value || 0),
      itemRevenue: Number(mets[3]?.value || 0),
    };
  });
}

/**
 * Turn GA4 rows into the supplier's table.
 *
 * `ownedTourIds` is the safety rail: GA4 reports every product on the
 * property, so without it one supplier would see every other supplier's
 * sales. Rows outside the set are counted in `excludedCount` — reported, not
 * silently discarded — so nobody mistakes "hidden" for "nothing".
 */
function shapeRows(ga4Rows, { ownedTourIds = null, excludeItemIds = [] } = {}) {
  const excluded = new Set(excludeItemIds);
  const owned = ownedTourIds ? new Set(ownedTourIds) : null;

  const kept = [];
  let excludedCount = 0;
  for (const row of ga4Rows) {
    if (excluded.has(row.itemId)) {
      excludedCount += 1;
      continue;
    }
    if (owned && !owned.has(row.itemId)) {
      excludedCount += 1;
      continue;
    }
    kept.push(row);
  }

  const totalRevenue = kept.reduce((sum, r) => sum + r.itemRevenue, 0);
  const totalPurchased = kept.reduce((sum, r) => sum + r.itemsPurchased, 0);

  const rows = kept
    .map((r) => ({
      ...r,
      // Share of THIS supplier's totals, over their own rows only. Guarded so
      // an empty window reads 0% rather than NaN%.
      itemRevenueSharePct: totalRevenue > 0 ? round1((r.itemRevenue / totalRevenue) * 100) : 0,
      itemsPurchasedSharePct: totalPurchased > 0 ? round1((r.itemsPurchased / totalPurchased) * 100) : 0,
    }))
    .sort((a, b) => b.itemRevenue - a.itemRevenue || b.itemsPurchased - a.itemsPurchased);

  return {
    rows,
    totals: {
      itemsViewed: kept.reduce((sum, r) => sum + r.itemsViewed, 0),
      itemsAddedToCart: kept.reduce((sum, r) => sum + r.itemsAddedToCart, 0),
      itemsPurchased: totalPurchased,
      itemRevenue: round2(totalRevenue),
    },
    excludedCount,
  };
}

function round1(n) {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Fetch the item funnel from GA4 for one date range.
 *
 * @param {{from: string, to: string}} range  YYYY-MM-DD, inclusive
 * @param {{fetchImpl?: Function}} [opts]     injectable for tests
 * @returns {Promise<Array>} flattened rows (itemId/itemName + the 4 metrics)
 */
async function fetchItemFunnel({ from, to }, { fetchImpl = fetch } = {}) {
  if (!isConfigured()) {
    // Distinct from "no rows": the caller turns this into "not configured".
    const err = new Error('GA4 reporting is not configured');
    err.code = 'GA4_NOT_CONFIGURED';
    throw err;
  }

  const token = await getAccessToken(fetchImpl);
  const res = await fetchImpl(`${DATA_API}/${propertyId()}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildFunnelReportRequest({ from, to })),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`GA4 runReport failed (${res.status}): ${text.slice(0, 300)}`);
    err.code = 'GA4_REPORT_FAILED';
    throw err;
  }

  const payload = await res.json();
  return flattenReport(payload);
}

module.exports = {
  isConfigured,
  getAccessToken,
  resetTokenCache,
  buildFunnelReportRequest,
  flattenReport,
  shapeRows,
  fetchItemFunnel,
  FUNNEL_DIMENSIONS,
  FUNNEL_METRICS,
};
