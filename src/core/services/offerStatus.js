/**
 * Single source of truth for Special Offer status.
 *
 * Used by BOTH status producers in the backend — the shared controller
 * (specialOfferController) and the supplier-scoped list (supplier.js) — so the
 * badge in the list, the badge in the detail modal and the badge in the builder
 * can never disagree.
 *
 * Precedence is DATES FIRST, deliberately:
 *
 *   1. end date passed  -> 'expired'   fix = extend the dates
 *   2. switch off       -> 'inactive'  fix = flip the switch (window still valid)
 *   3. start date later -> 'scheduled'
 *   4. otherwise        -> 'active'
 *
 * The switch is checked *after* the end date because a switched-off offer whose
 * window has already run out cannot be revived by flipping the switch — it needs
 * new dates. Ordering it the other way hid every dead offer behind 'inactive'
 * (the nightly expire job writes isActive:false, short-circuiting the date
 * check), which made the 'expired' filter permanently empty.
 *
 * The set of offers reported 'active' is identical under either ordering, so
 * activeOnly queries, tour listings and homepage offer badges are unaffected by
 * this choice — only the expired/inactive label swaps for rows that are both
 * switched off and past their end date.
 *
 * @param {{isActive?: boolean, startDate?: Date|string|null, endDate?: Date|string|null}} offer
 * @param {Date} [now]
 * @returns {'expired'|'inactive'|'scheduled'|'active'}
 */
function computeOfferStatus(offer, now = new Date()) {
  if (offer.endDate && now > new Date(offer.endDate)) return 'expired';
  if (!offer.isActive) return 'inactive';
  if (offer.startDate && now < new Date(offer.startDate)) return 'scheduled';
  return 'active';
}

module.exports = { computeOfferStatus };
