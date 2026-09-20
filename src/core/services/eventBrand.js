/**
 * Resolve which brand an analytics Event belongs to.
 *
 * Events were previously written with no brand signal, so the admin analytics
 * that scope by `properties->>'source'` could never match anything (they
 * silently returned zero). Every event is now tagged with its brand at write
 * time; this helper decides that brand.
 *
 * Priority:
 *   1. req.brandKey      — set by the brand-scoped mounts (attachBrand)
 *   2. request path      — /api/travioghana, /api/travioafrica, /api/expedition
 *   3. Origin / Referer  — the storefront host the browser was on
 * Returns the brand registry key ('ghana' | 'africa' | 'expedition') or null.
 */
const { BRANDS, resolveBrandKey } = require('../../../config/brands');

// Brand key → its storefront hostname (for Origin/Referer matching).
const DOMAIN_TO_KEY = Object.fromEntries(
  Object.values(BRANDS)
    .filter((b) => b.storefrontDomain)
    .map((b) => [b.storefrontDomain.toLowerCase(), b.key]),
);

// Path segment → brand key (the API namespace).
const PATH_TO_KEY = {
  travioghana: 'ghana',
  travioafrica: 'africa',
  expedition: 'expedition',
};

function brandFromPath(req) {
  const raw = (req && (req.originalUrl || req.url || req.baseUrl)) || '';
  const path = String(raw).split('?')[0];
  const m = path.match(/\/api\/(travioafrica|travioghana|expedition)(\/|$)/i);
  return m ? PATH_TO_KEY[m[1].toLowerCase()] : null;
}

function brandFromOrigin(req) {
  const raw = req && req.headers && (req.headers.origin || req.headers.referer);
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return DOMAIN_TO_KEY[host] || null;
  } catch {
    return null;
  }
}

// Expedition is a storefront-only sub-store owned by Ghana, so its analytics
// roll up under Ghana (Ghana's admin should see Expedition traffic).
const TAG_ALIAS = { expedition: 'ghana' };

function resolveEventBrand(req) {
  if (!req) return null;
  const key = req.brandKey
    ? resolveBrandKey(req.brandKey)
    : brandFromPath(req) || brandFromOrigin(req);
  if (!key) return null;
  return TAG_ALIAS[key] || key;
}

module.exports = { resolveEventBrand };
