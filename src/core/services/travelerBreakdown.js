/**
 * Shared traveller-category breakdown.
 *
 * A Booking.travelers JSON blob is a count map with supplier-defined keys
 * (adults, children, infants, seniors, students, youth, …) plus non-numeric
 * metadata (phoneNumber, location, details). Capacity accounting already sums
 * every numeric key, so every presentation surface must do the same or an
 * email/PDF can undercount a party that the booking engine accepted.
 */

// Non-numeric metadata carried in the same JSON blob. Kept in sync with the
// checkout validators; these keys are never traveller counts even when a phone
// number happens to look numeric.
const META_KEYS = new Set(['phoneNumber', 'phone', 'location', 'details', 'name', 'email', 'specialRequests']);

const KNOWN_CATEGORIES = {
  adults: { singular: 'adult', plural: 'adults' },
  children: { singular: 'child', plural: 'children' },
  infants: { singular: 'infant', plural: 'infants' },
  seniors: { singular: 'senior', plural: 'seniors' },
  students: { singular: 'student', plural: 'students' },
  youth: { singular: 'youth', plural: 'youths' },
  youths: { singular: 'youth', plural: 'youths' },
  seniorcitizens: { singular: 'senior citizen', plural: 'senior citizens' },
  seniorcitizen: { singular: 'senior citizen', plural: 'senior citizens' },
};

// Stable order for the familiar buckets; supplier-defined keys follow
// alphabetically so two renders of the same payload always match.
const CATEGORY_ORDER = ['adults', 'children', 'infants', 'seniors'];

function countOf(value) {
  // Numeric strings are accepted for legacy rows; anything with a sign, space
  // or punctuation (phone numbers, dates, prose) is not a count.
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Lowercase, alphanumeric-only category key ("Senior Citizen" → "seniorcitizen"). */
function categoryKey(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Pluralized payload key for a free-form traveler label. */
function categoryKeyForLabel(label) {
  const key = categoryKey(label);
  if (!key) return '';
  if (key === 'adult' || key === 'adults') return 'adults';
  if (key === 'child' || key === 'children' || key === 'kid' || key === 'kids') return 'children';
  if (key === 'infant' || key === 'infants' || key === 'baby' || key === 'babies') return 'infants';
  return key.endsWith('s') ? key : `${key}s`;
}

function labelsForKey(key) {
  if (KNOWN_CATEGORIES[key]) return KNOWN_CATEGORIES[key];
  const singular = key.endsWith('s') ? key.slice(0, -1) : key;
  return { singular: singular || key, plural: key };
}

function sortKeys(keys) {
  return keys.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.localeCompare(b);
  });
}

/**
 * Convert a travelers blob into ordered categories.
 *
 * Explicit numeric counts always win. `details` is only a fallback for legacy
 * bookings that never stored counts: it names travellers, not a headcount, so
 * using it alongside counts would repeat the "1 named lead = 1 traveller" bug.
 *
 * @returns {{ key: string, count: number, singular: string, plural: string }[]}
 */
function travelerParts(travelers) {
  if (!travelers || typeof travelers !== 'object' || Array.isArray(travelers)) return [];

  const counts = {};
  for (const [key, value] of Object.entries(travelers)) {
    if (META_KEYS.has(key)) continue;
    const count = countOf(value);
    if (count > 0) counts[key] = (counts[key] || 0) + count;
  }

  if (Object.keys(counts).length === 0 && Array.isArray(travelers.details)) {
    for (const detail of travelers.details) {
      const key = categoryKeyForLabel(detail?.ageGroup || detail?.type || '');
      if (!key) continue;
      const count = countOf(detail?.count ?? detail?.qty ?? 1);
      if (count > 0) counts[key] = (counts[key] || 0) + count;
    }
  }

  return sortKeys(Object.keys(counts)).map((key) => ({
    key,
    count: counts[key],
    ...labelsForKey(key),
  }));
}

/** "1 adult, 2 seniors" for a travelers blob. */
function travelerLabel(travelers, separator = ', ') {
  return travelerParts(travelers)
    .map((part) => `${part.count} ${part.count === 1 ? part.singular : part.plural}`)
    .join(separator);
}

module.exports = {
  categoryKey,
  categoryKeyForLabel,
  travelerParts,
  travelerLabel,
};
