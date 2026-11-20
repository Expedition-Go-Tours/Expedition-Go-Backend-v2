/**
 * Brand assets — the logo bitmap that ships inside generated PDFs.
 *
 * The email shell already carries a per-brand Cloudinary logo
 * (`config/brands.js` → `email.logoUrl`), so PDFs reuse that same asset
 * instead of bundling a second copy of the branding in the repository. The
 * bytes are cached per brand for a day: a receipt download must never wait on
 * Cloudinary once the first request has warmed the cache.
 *
 * A missing or unreachable logo is never fatal — callers receive `null` and
 * fall back to a typeset wordmark.
 */

const { getBrandEmail } = require('../../../config/brands');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

const cache = new Map();

function isPng(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer.toString('latin1', 1, 4) === 'PNG'
  );
}

/**
 * Fetch the brand logo as a Buffer (PNG), or null when unavailable.
 *
 * @param {string} brandKey  brand registry key ('ghana', 'africa', 'expedition'…)
 * @returns {Promise<Buffer|null>}
 */
async function getBrandLogo(brandKey) {
  const { logoUrl } = getBrandEmail(brandKey);
  if (!logoUrl) return null;
  if (typeof fetch !== 'function') return null;

  const key = `${brandKey}:${logoUrl}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.buffer;

  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[BrandAssets] Logo fetch failed for ${brandKey}: HTTP ${res.status}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!isPng(buffer)) {
      console.warn(`[BrandAssets] Logo for ${brandKey} is not a PNG; falling back to wordmark`);
      return null;
    }
    cache.set(key, { at: Date.now(), buffer });
    return buffer;
  } catch (err) {
    console.warn(`[BrandAssets] Logo fetch failed for ${brandKey}: ${err.message}`);
    return null;
  }
}

/** Test hook: drop every cached logo. */
function clearBrandLogoCache() {
  cache.clear();
}

module.exports = { getBrandLogo, clearBrandLogoCache };
