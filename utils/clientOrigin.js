/**
 * Per-request client origin resolution.
 *
 * The backend serves multiple branded frontends (travioafrica.com, expedition,
 * etc.), but Stripe redirect URLs used to be built from a single CLIENT_URL
 * env — so a customer paying on the expedition frontend was bounced back to
 * travioafrica.com after payment.
 *
 * These helpers resolve the origin the browser is actually on (Origin /
 * Referer headers) and, when it is allow-listed via CLIENT_URL +
 * ALLOWED_ORIGINS, use it for the Stripe success/cancel/return URLs. Anything
 * else (background jobs, non-browser clients, untrusted origins) falls back to
 * CLIENT_URL.
 */

function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function getAllowedClientOrigins() {
  const set = new Set();
  if (process.env.CLIENT_URL) set.add(normalizeOrigin(process.env.CLIENT_URL));
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of configured) {
    const origin = normalizeOrigin(entry);
    if (origin) set.add(origin);
  }
  return set;
}

/**
 * Returns an allow-listed origin the current request came from, or the
 * CLIENT_URL fallback when the request has no usable/trusted origin.
 */
function resolveAllowedClientUrl(req, fallback = process.env.CLIENT_URL) {
  const raw = req && (req.headers && (req.headers.origin || req.headers.referer));
  const origin = normalizeOrigin(raw);
  if (origin && getAllowedClientOrigins().has(origin)) {
    return origin;
  }
  if (origin) {
    console.warn(`[clientOrigin] Untrusted origin "${origin}" — falling back to CLIENT_URL`);
  }
  return fallback;
}

module.exports = {
  normalizeOrigin,
  getAllowedClientOrigins,
  resolveAllowedClientUrl,
};
