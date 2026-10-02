/**
 * Single source of truth for Special Offer status.
 *
 * Used by BOTH status producers in the backend — the shared controller
 * (specialOfferController) and the supplier-scoped list (supplier.js) — so the
 * badge in the list, the badge in the detail modal and the badge in the builder
 * can never disagree.
 *
 * THREE states only: 'expired' | 'scheduled' | 'active'.
 *
 * There is deliberately no 'inactive'. A switched-off offer will never go live
 * on its own, exactly like one whose window has already run out — neither earns
 * anything until a human acts — so both land in 'expired': one bucket, one
 * filter, one stat card. The supplier UI still separates the two remedies, but
 * it does that with `statusIfActivated` (does the window alone already work?),
 * not with this label.
 *
 * Precedence:
 *
 *   1. end date passed  -> 'expired'   remedy = extend the dates
 *   2. switch off       -> 'expired'   remedy = flip the switch
 *   3. start date later -> 'scheduled'
 *   4. otherwise        -> 'active'
 *
 * Rules 1 and 2 now share a label, so the order between them no longer changes
 * any outcome. What still matters is that BOTH outrank rule 3: the nightly
 * expire-special-offers job writes isActive:false the moment a date passes, and
 * a switched-off offer will not launch by itself, so neither may ever be
 * reported 'scheduled' — that would promise a launch the switch prevents.
 *
 * Dates still lead here for historical reasons: when rules 1 and 2 returned
 * 'expired' and 'inactive', checking the switch first hid every dead offer
 * behind 'inactive' and left the 'expired' filter permanently empty.
 *
 * The set of offers reported 'active' is identical under either ordering, so
 * activeOnly queries, tour listings and homepage offer badges are unaffected by
 * this choice — only the label applied to switched-off rows changes.
 *
 * @param {{isActive?: boolean, startDate?: Date|string|null, endDate?: Date|string|null}} offer
 * @param {Date} [now]
 * @returns {'expired'|'scheduled'|'active'}
 */
function computeOfferStatus(offer, now = new Date()) {
  if (offer.endDate && now > new Date(offer.endDate)) return 'expired';
  if (!offer.isActive) return 'expired';
  if (offer.startDate && now < new Date(offer.startDate)) return 'scheduled';
  return 'active';
}

module.exports = { computeOfferStatus };
