/**
 * Attraction name matching.
 *
 * Itinerary stops ("Boti Waterfalls") and curated attractions ("Boti Falls")
 * frequently differ in spelling, so matching by exact name undercounts tours
 * and hides attractions from the "Top Attractions Nearby" section. The curated
 * Attraction table carries an `aliases` column (semicolon-separated) holding
 * those variants, so name + aliases is the full set of accepted spellings.
 *
 * One place owns this so the tour-count and the section can never disagree.
 */

const ALIAS_SPLIT = /[,;|]/;

/** Lowercase, strip accents/punctuation, collapse whitespace. */
function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function splitAliases(aliases) {
  return String(aliases || '')
    .split(ALIAS_SPLIT)
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Every accepted spelling for an attraction: its name plus each alias. */
function variantsFor(attraction) {
  const out = new Set();
  if (attraction && attraction.name) out.add(attraction.name);
  for (const alias of splitAliases(attraction && attraction.aliases)) out.add(alias);
  return [...out];
}

/**
 * Normalized lookup from every spelling → the canonical attraction.
 * Accepts an array of { id, name, aliases }.
 */
function buildAttractionIndex(attractions) {
  const index = new Map();
  for (const attraction of attractions || []) {
    if (!attraction || !attraction.name) continue;
    for (const variant of variantsFor(attraction)) {
      const key = normalizeName(variant);
      if (key && !index.has(key)) index.set(key, attraction);
    }
  }
  return index;
}

/** Resolve a raw itinerary stop name to its canonical attraction, or null. */
function canonicalFor(index, stopName) {
  if (!index || !stopName) return null;
  return index.get(normalizeName(stopName)) || null;
}

module.exports = { normalizeName, variantsFor, buildAttractionIndex, canonicalFor };
