/**
 * Brand resolution for multi-brand OAuth.
 *
 * The backend serves several branded storefronts, each with its own Google
 * OAuth client so the consent screen shows that brand's own domain. A request
 * is attributed to a brand by the hostname it comes from:
 *   - the storefront origin on the OAuth initiation (e.g. https://travioghana.com)
 *   - the API callback host (e.g. api.travioghana.com)
 *
 * Unknown hosts fall back to 'default' (TravioAfrica), preserving the original
 * single-brand behaviour.
 */

const { BRANDS } = require('../../../config/brands');

// A brand matches a domain exactly or any subdomain of it. Listing the apex is
// enough — `supplier.travioghana.com` is covered by `travioghana.com`.
// Sourced from config/brands.js (single source of truth for brand domains).
const BRAND_DOMAINS = {
  ghana: [BRANDS.ghana.storefrontDomain],
  expedition: [BRANDS.expedition.storefrontDomain],
};

/**
 * Extract a lowercase hostname from an origin, URL, or bare host (optionally
 * with port / path). Returns null when nothing usable is present.
 */
function hostnameOf(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.includes('://')) {
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  return raw.split('/')[0].split(':')[0].toLowerCase() || null;
}

/**
 * Map an origin/URL/host to a brand key ('ghana' | 'expedition' | 'default').
 */
function resolveBrand(value) {
  const host = hostnameOf(value);
  if (!host) return 'default';
  for (const [brand, domains] of Object.entries(BRAND_DOMAINS)) {
    for (const domain of domains) {
      if (host === domain || host.endsWith(`.${domain}`)) return brand;
    }
  }
  return 'default';
}

module.exports = { resolveBrand, hostnameOf, BRAND_DOMAINS };
