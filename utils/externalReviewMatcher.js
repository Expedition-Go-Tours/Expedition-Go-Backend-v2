/**
 * External-review product → tour matcher.
 *
 * A faithful port of the storefront's `src/lib/reviewTourLink.ts` so the
 * backend resolves scraped TripAdvisor / GetYourGuide products to the same
 * tours the storefront would. Keeping the two in step matters: the number a
 * customer sees on a card must be the number homepage ranking used.
 *
 * Pure module — no database or framework dependencies.
 */

/**
 * Ordered by specificity: the first group whose keyword appears in a review
 * title wins, so specific attractions ("aburi") beat generic cities ("accra").
 */
const DESTINATION_ALIASES = [
  { keywords: ['cape coast', 'elmina', 'kakum'], destinations: ['Cape Coast', 'Elmina', 'Kakum', 'Central Region'] },
  { keywords: ['aburi', 'boti', 'umbrella rock'], destinations: ['Eastern Region', 'Aburi', 'Koforidua'] },
  { keywords: ['shai hills', 'ada foah'], destinations: ['Greater Accra', 'Ada Foah', 'Accra'] },
  { keywords: ['akosombo', 'lake volta', 'volta'], destinations: ['Volta Region', 'Akosombo', 'Ho'] },
  { keywords: ['mole'], destinations: ['Northern Region', 'Tamale', 'Mole'] },
  { keywords: ['kumasi', 'ashanti'], destinations: ['Kumasi'] },
  { keywords: ['accra', 'jamestown'], destinations: ['Accra', 'Greater Accra'] },
];

/**
 * Words that carry no product identity — dropped before comparing titles so
 * "Day Tour", "Guided Experience", "From Accra:" etc. never create a match.
 */
const TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'with', 'of', 'in', 'on', 'at', 'to', 'from', 'for', 'by', 'or',
  'day', 'days', 'half', 'full', 'tour', 'tours', 'trip', 'trips',
  'activity', 'activities', 'guided', 'guide', 'experience', 'experiences',
  'private', 'mini', 'package', 'option',
]);

/**
 * City/region words that appear in most titles for a destination. They may
 * corroborate a match but never create one on their own (otherwise every
 * "Accra ..." review would land on every Accra tour). "city" is deliberately
 * not listed: sharing it alongside the city name is what lets short platform
 * variants like "Accra Guided City Tour Experience" reach a city tour.
 */
const GENERIC_LOCATION_TOKENS = new Set([
  'accra', 'ghana', 'greater', 'region', 'eastern', 'western', 'northern', 'central',
  // "National Park" is a suffix shared by unrelated parks (Mole vs Kakum), so
  // it must never be the evidence that attaches a review to a tour.
  'national', 'park',
]);

/**
 * Attraction-specific aliases used as a fallback when titles don't overlap.
 * The trailing generic "accra/jamestown" group is intentionally excluded.
 */
const ATTRACTION_ALIASES = DESTINATION_ALIASES.filter(
  (alias) => !alias.keywords.includes('accra') && !alias.keywords.includes('jamestown'),
);

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Conservative singularizer so "Castles" matches "Castle", "Falls" matches "Fall". */
function singularize(token) {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ss')) return token;
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokenize(normalized) {
  return normalized
    .split(' ')
    .filter((token) => token.length > 0 && !TITLE_STOP_WORDS.has(token))
    .map(singularize);
}

function diceSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Token-overlap similarity between two titles. Requires at least one shared
 * token that isn't a generic location word; two shared distinctive tokens
 * tolerate a looser Dice score, a single one demands a strong overlap.
 */
function titleSimilarity(reviewTokens, tourTokens) {
  const shared = [];
  for (const token of reviewTokens) if (tourTokens.has(token)) shared.push(token);
  if (shared.length === 0) return 0;

  const sharedDistinctive = shared.filter((token) => !GENERIC_LOCATION_TOKENS.has(token));
  if (sharedDistinctive.length === 0) return 0;

  const dice = diceSimilarity(reviewTokens, tourTokens);
  if (sharedDistinctive.length >= 2) {
    return dice >= 0.3 ? 0.5 + dice / 2 : 0;
  }
  return dice >= 0.5 ? 0.4 + dice / 2 : 0;
}

/**
 * Attraction-keyword fallback ("aburi", "shai hills", "akosombo", ...).
 * A keyword in the tour title scores higher than one matched only through the
 * tour's location, and both sit below any real token-overlap match.
 */
function aliasSimilarity(normalizedReview, tour) {
  const tourTitleText = normalizeTitle(tour.title);
  const tourText = normalizeTitle(`${tour.title} ${tour.location ?? ''}`);
  let score = 0;

  for (const alias of ATTRACTION_ALIASES) {
    if (!alias.keywords.some((keyword) => normalizedReview.includes(keyword))) continue;
    if (alias.keywords.some((keyword) => tourTitleText.includes(keyword))) {
      score = Math.max(score, 0.35);
      continue;
    }
    if (alias.destinations.some((destination) => tourText.includes(destination))) {
      score = Math.max(score, 0.3);
    }
  }

  return score;
}

/**
 * Map an external product/review title to the single best-matching tour.
 * Returns null when nothing clears the threshold (e.g. business-level rows).
 *
 * Order of preference: exact normalized title, token overlap, then the
 * attraction-keyword fallback.
 */
function matchTourForTitle(reviewTitle, tours) {
  if (!reviewTitle || !Array.isArray(tours) || tours.length === 0) return null;
  const normalizedReview = normalizeTitle(reviewTitle);
  if (!normalizedReview) return null;

  const reviewTokens = new Set(tokenize(normalizedReview));
  let best = null;

  for (const tour of tours) {
    const normalizedTour = normalizeTitle(tour.title);
    if (!normalizedTour) continue;
    const score = normalizedTour === normalizedReview
      ? 1
      : Math.max(
        titleSimilarity(reviewTokens, new Set(tokenize(normalizedTour))),
        aliasSimilarity(normalizedReview, tour),
      );
    if (score > 0 && (!best || score > best.score)) best = { tour, score };
  }

  return best ? best.tour : null;
}

module.exports = { matchTourForTitle, normalizeTitle };
