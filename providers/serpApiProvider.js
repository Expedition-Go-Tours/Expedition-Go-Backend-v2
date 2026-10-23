/**
 * SerpApi Google Maps place search — the fallback for locations that none of
 * the free providers (Geoapify, Nominatim, Photon) know about.
 *
 * This is the same escape hatch the TravioGhana storefront uses for pickup
 * selection: a supplier is often typing a small hotel, a village junction or a
 * landmark that exists on Google Maps but in none of our open-data providers,
 * and until now the only way to set it was to click a pin on the map.
 *
 * Two rules inherited from the storefront implementation:
 *
 *  - THE KEY NEVER LEAVES THE SERVER. SerpApi sends no CORS headers, so the
 *    browser cannot call it directly anyway; this module is the only place the
 *    secret is read (`SERPAPI_API_KEY`, with `VITE_SERP_API_KEY` accepted as a
 *    legacy alias — same names as the storefront, so one secret can serve
 *    both). Nothing here ever echoes the key back.
 *
 *  - GHANA ONLY. Every result is checked against its `country` label: Ghana
 *    results and results with no country at all are kept, anything explicitly
 *    abroad is dropped. A Ghana supplier's pickup point is in Ghana, and a
 *    "Central Park, New York" row in a pickup list is worse than no row.
 *
 * SerpApi response shapes (https://serpapi.com/google-maps-api):
 *  - a list query returns `local_results[]` with `gps_coordinates`, `address`,
 *    `country` and `place_id` per place;
 *  - a query that resolves to one specific place (e.g. a business name) comes
 *    back as a single `place_results` object instead — BOTH shapes are read;
 *  - an empty result set is still HTTP 200 with
 *    `search_information.local_results_state: "Fully empty"`;
 *  - errors surface as `search_metadata.status: "Error"` + a top-level
 *    `error`, or as HTTP 401 (bad key) / 429 (quota or throughput).
 */

const axios = require('axios');

const SERPAPI_SEARCH_ENDPOINT = 'https://serpapi.com/search.json';
const SEARCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;
/** Fallback origin (Accra) when the caller has no coordinates of their own. */
const DEFAULT_ORIGIN = { lat: 5.6037, lng: -0.187 };

/**
 * The key, or null when this server is not configured for Google Maps search.
 * `VITE_SERP_API_KEY` is accepted as a legacy alias so a single secret can be
 * shared with the storefront; the value is never returned to any client.
 */
function getApiKey() {
  const key =
    (process.env.SERPAPI_API_KEY || process.env.VITE_SERP_API_KEY || '').trim();
  return key || null;
}

function isConfigured() {
  return Boolean(getApiKey());
}

/** Ghana-labelled results and unlabelled ones; anything explicitly abroad is dropped. */
function isGhanaResult(result) {
  const country = (result && result.country ? String(result.country) : '').trim().toLowerCase();
  return country.length === 0 || country === 'ghana';
}

/**
 * Pull the places out of either response shape into one array. Pure, so the
 * parsing rules are testable without touching the network.
 */
function extractPlaces(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const collected = [];
  if (Array.isArray(payload.local_results)) collected.push(...payload.local_results);
  // A query that resolves to a single place returns it instead of a list.
  if (payload.place_results && typeof payload.place_results === 'object') {
    collected.push(payload.place_results);
  }
  return collected.filter(isGhanaResult).slice(0, MAX_RESULTS);
}

/**
 * Search Google Maps through SerpApi.
 *
 * Returns `{ ok: true, results }` or `{ ok: false, reason }` where reason is
 * one of `not_configured` | `quota` | `upstream` — the caller turns those into
 * UI states, and a missing key is never presented as "no results".
 *
 * @param {string} query              free text (≥3 chars)
 * @param {{lat: number, lng: number}|null} [origin]  bias the search area
 */
async function search(query, origin = null) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, reason: 'not_configured' };

  const q = String(query || '').trim();
  if (q.length < 3) return { ok: false, reason: 'upstream' };

  const params = new URLSearchParams({
    engine: 'google_maps',
    q,
    type: 'search',
    hl: 'en',
    api_key: apiKey,
  });

  // Bias the search to where the pickup will happen; fall back to Accra so a
  // bare query still resolves inside the country.
  const bias = origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)
    ? origin
    : DEFAULT_ORIGIN;
  params.set('ll', `@${bias.lat},${bias.lng},12z`);

  try {
    const { data } = await axios.get(SERPAPI_SEARCH_ENDPOINT, {
      params,
      timeout: SEARCH_TIMEOUT_MS,
    });

    // SerpApi reports API-level errors in the body while still returning 200.
    if (data && data.search_metadata && data.search_metadata.status === 'Error') {
      return { ok: false, reason: 'upstream' };
    }

    return { ok: true, results: extractPlaces(data) };
  } catch (err) {
    const status = err && err.response && err.response.status;
    // 401/429 are both "this key cannot answer right now": quota or a bad
    // key. The UI treats them the same — the option stops offering itself —
    // and the distinction is only worth logging.
    if (status === 429 || status === 401) return { ok: false, reason: 'quota' };
    return { ok: false, reason: 'upstream' };
  }
}

module.exports = {
  search,
  isConfigured,
  isGhanaResult,
  extractPlaces,
  getApiKey,
  SERPAPI_SEARCH_ENDPOINT,
  DEFAULT_ORIGIN,
  MAX_RESULTS,
};
