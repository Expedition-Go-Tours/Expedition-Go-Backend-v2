/**
 * Passenger-mix validation — Viator-style rules over the supplier's pricing
 * categories and capacity settings. Mirrors the pax-mix constraints Viator
 * enforces (total min/max, "requires adult" supervision, disallowed categories)
 * so the Expedition checkout rejects invalid parties before a charge is made.
 *
 * Works against the parsed `schedulesAndPricing.travelerDetails` blob (the
 * same source of truth `calculateTourPrice` / `buildAvailabilityCalendar`
 * consume) so it can never drift from how pricing is applied.
 */

const { travelerCount } = require('./availabilityCore');

/** Singularize a traveler key the same way calculateTourPrice does. */
const IRREGULAR_PLURALS = { children: 'child', infants: 'infant', men: 'man', women: 'woman' };

function normalizeKey(key) {
  const lower = String(key).toLowerCase();
  return IRREGULAR_PLURALS[lower] || lower.replace(/s$/, '');
}

/** Find the supplier's pricing category matching a traveler key, if any. */
function findCategory(cats, key) {
  const normalized = normalizeKey(key);
  return (Array.isArray(cats) ? cats : []).find((c) => {
    const label = String(c && (c.name || c.label) || '').toLowerCase();
    return label === normalized || label === String(key).toLowerCase();
  });
}

/** Is this key an adult/senior-like guardian for needsAdult supervision? */
function isGuardianKey(key) {
  const normalized = normalizeKey(key);
  return normalized === 'adult' || normalized === 'senior';
}

/**
 * Validate a travelers mix against a tour's pricing/capacity rules.
 *
 * @param {object} parsed  Parsed `schedulesAndPricing` blob (or raw JSON).
 * @param {object} travelers  The travelers count map from the request body.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validatePassengerMix(parsed, travelers) {
  const errors = [];
  if (!parsed || !travelers || typeof travelers !== 'object') {
    return { ok: false, errors: ['Traveler information is required'] };
  }

  const td = parsed.travelerDetails || {};
  const cats = Array.isArray(td.pricingCategories) ? td.pricingCategories : [];

  const total = travelerCount(travelers);

  // Total participants bounds (supplier's capacity settings).
  const min = Number.isFinite(Number(td.minParticipants)) ? Number(td.minParticipants) : null;
  const max = Number.isFinite(Number(td.maxParticipants)) ? Number(td.maxParticipants) : null;
  if (min != null && total < min) {
    errors.push(`At least ${min} traveler${min === 1 ? '' : 's'} are required for this tour`);
  }
  if (max != null && total > max) {
    errors.push(`This tour accepts a maximum of ${max} travelers`);
  }

  // Disallowed (notAllowed) categories must never be booked.
  for (const [key, count] of Object.entries(travelers)) {
    if (typeof count !== 'number' || count <= 0) continue;
    const cat = findCategory(cats, key);
    if (cat && cat.notAllowed === true) {
      errors.push(`${cat.name || key} is not permitted on this tour`);
    }
  }

  // needsAdult (requiresAdultForBooking) — at least one adult or senior must
  // be present in the party.
  const hasGuardian = Object.keys(travelers).some((key) => {
    const count = travelers[key];
    return typeof count === 'number' && count > 0 && isGuardianKey(key);
  });
  const supervised = (Array.isArray(cats) ? cats : []).some((c) => c && c.needsAdult === true);
  if (supervised && !hasGuardian) {
    errors.push('At least one adult or senior traveler is required for this party');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validatePassengerMix, findCategory, normalizeKey };
