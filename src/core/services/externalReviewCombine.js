/**
 * Pure helpers for combining in-app review stats with external platform
 * aggregates. No database or framework dependencies so both the ranking layer
 * and the review-rating transaction can use them without pulling in the
 * storage layer.
 *
 * Counting policy (must mirror the storefront exactly):
 *  - only TripAdvisor and GetYourGuide count; Google is display-only
 *  - a product's 1★ bucket is removed from its official total defensively
 */

/** Sources whose official totals count toward the combined headline number. */
const COUNTED_SOURCES = ['TRIPADVISOR', 'GETYOURGUIDE'];

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Weighted aggregate of a tour's per-platform official totals, applying the
 * 1★ adjustment. Returns { rating: 0, reviewCount: 0 } when nothing counts.
 */
function combineExternalStats(rows = []) {
  let count = 0;
  let sum = 0;

  for (const row of rows) {
    if (!row || !COUNTED_SOURCES.includes(row.source)) continue;
    const productCount = Math.max(0, toNumber(row.reviewCount));
    const productRating = toNumber(row.rating);
    if (productCount <= 0 || productRating <= 0) continue;

    const oneStar = Math.max(0, toNumber(row.distribution && row.distribution['1']));
    let adjustedCount = productCount;
    let adjustedSum = productRating * productCount;
    if (oneStar > 0) {
      adjustedCount -= oneStar;
      adjustedSum -= oneStar;
    }
    if (adjustedCount <= 0) continue;

    count += adjustedCount;
    sum += adjustedSum;
  }

  if (count === 0) return { rating: 0, reviewCount: 0 };
  return { rating: roundOne(sum / count), reviewCount: count };
}

/**
 * Merge a tour's in-app stats with its external aggregate into the headline
 * number. Mirrors the storefront's combineReviewStats so ranking and display
 * agree to the decimal.
 */
function combineTourStats(internalRating, internalReviewCount, external) {
  let count = 0;
  let sum = 0;

  const inRating = toNumber(internalRating);
  const inCount = Math.max(0, toNumber(internalReviewCount));
  if (inCount > 0 && inRating > 0) {
    sum += inRating * inCount;
    count += inCount;
  }

  if (external && external.reviewCount > 0 && external.rating > 0) {
    sum += external.rating * external.reviewCount;
    count += external.reviewCount;
  }

  if (count === 0) return { rating: 0, reviewCount: 0 };
  return { rating: Math.min(5, roundOne(sum / count)), reviewCount: count };
}

module.exports = { COUNTED_SOURCES, combineExternalStats, combineTourStats, toNumber, roundOne };
