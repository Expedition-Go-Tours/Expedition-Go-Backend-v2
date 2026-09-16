/**
 * Supplier country handling.
 *
 * `SupplierProfile.businessInfo.country` is meant to hold an ISO 3166-1 alpha-2
 * code — `supplierHelpers.validateBusinessInfo` rejects anything that isn't two
 * characters. Records created before that validation existed hold full names
 * instead ("Ghana", "Nigeria"), so a comparison against a literal silently
 * misclassifies them.
 *
 * That mattered: `autoPublishGhana` tested `country === 'Ghana'` and
 * `autoPublishTravioAfrica` tested `country !== 'Ghana'`. A supplier stored as
 * "GH" therefore failed the Ghana test and passed the non-Ghana one, so it was
 * excluded from the Ghana storefront and pushed to TravioAfrica instead — the
 * exact opposite of the intent. A supplier stored as "Ghana" had the inverse
 * problem once the code moved to ISO codes.
 *
 * Always compare through these helpers rather than a literal. The stored data
 * was normalised by migration 20260916110000_normalize_supplier_country, but
 * the tolerance stays: it costs nothing and the next legacy row will not
 * reintroduce the bug.
 */

/** Full names we know about, mapped to their ISO alpha-2 code. */
const COUNTRY_ALIASES = new Map([
  ['ghana', 'GH'],
  ['gha', 'GH'], // alpha-3, seen in older records
  ['nigeria', 'NG'],
  ['nga', 'NG'],
  ['kenya', 'KE'],
  ['south africa', 'ZA'],
  ['morocco', 'MA'],
  ['egypt', 'EG'],
  ['tanzania', 'TZ'],
  ['uganda', 'UG'],
  ['rwanda', 'RW'],
  ['senegal', 'SN'],
  ['ivory coast', 'CI'],
  ["cote d'ivoire", 'CI'],
])

/**
 * Best-effort normalisation to an uppercase ISO alpha-2 code. Returns the
 * trimmed original when we don't recognise it, so an unknown value is never
 * silently rewritten into something wrong.
 */
function normalizeCountryCode(country) {
  const raw = String(country ?? '').trim()
  if (!raw) return null
  const alias = COUNTRY_ALIASES.get(raw.toLowerCase())
  if (alias) return alias
  return raw.length === 2 ? raw.toUpperCase() : raw
}

/** Is this supplier Ghana-based? Accepts "GH" and the legacy "Ghana". */
function isGhanaSupplier(country) {
  return normalizeCountryCode(country) === 'GH'
}

module.exports = { normalizeCountryCode, isGhanaSupplier, COUNTRY_ALIASES }
