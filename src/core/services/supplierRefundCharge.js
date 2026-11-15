/**
 * Supplier-side economics of refunding a booking.
 *
 * Shared by both refund paths — a supplier's own refund request and a
 * customer's completed-trip claim — so the platform can never pay the same
 * money out twice because one of them computed the debit differently.
 *
 * The rule depends on one economic fact: was the supplier already paid for
 * this booking?
 *
 *   partial refund   charge = supplierPayout × refund / gross   (always)
 *   full refund      charge = supplierPayout when the payout was already
 *                    INVOICED / REQUESTED / PAID, otherwise 0
 *
 * A full refund takes the booking out of payout eligibility (`paymentStatus`
 * becomes REFUNDED), so an unpaid supplier already loses their whole share —
 * charging again would be a double penalty. A partial refund leaves the
 * booking payable, so the supplier still receives their share and the
 * proportional charge claws back the refunded slice. When the payout has
 * already left, no eligibility change can recover it and the charge is the
 * only mechanism that can.
 */

/** Payout states that mean the supplier was already credited for this booking. */
const SETTLED_PAYOUT_STATES = Object.freeze(['INVOICED', 'REQUESTED', 'PAID']);

/** `SupplierCharge.reason` for the two refund paths. */
const SUPPLIER_REFUND_CHARGE_REASON = 'SUPPLIER_REFUND';
const CUSTOMER_CLAIM_CHARGE_REASON = 'CUSTOMER_REFUND_CLAIM';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function toNumber(v) {
  return v == null ? 0 : Number(v);
}

function isSettledPayout(payoutStatus) {
  return SETTLED_PAYOUT_STATES.includes(String(payoutStatus || ''));
}

/**
 * Compute the debit to raise against a supplier for one refund.
 *
 * @param {object} input
 * @param {number|string} input.grossAmount    booking total
 * @param {number|string} input.supplierPayout supplier's share of that total
 * @param {number|string} input.refundAmount   refund being issued now
 * @param {number|string} [input.refundedSoFar=0] already refunded before this one
 * @param {string} [input.payoutStatus]        booking's payout lifecycle state
 * @returns {{charge:number,isFull:boolean,payoutSettled:boolean,refundable:number,newRefunded:number}}
 */
function supplierChargeForRefund({
  grossAmount,
  supplierPayout,
  refundAmount,
  refundedSoFar = 0,
  payoutStatus,
}) {
  const gross = round2(toNumber(grossAmount));
  const payout = round2(toNumber(supplierPayout));
  const refunded = round2(toNumber(refundedSoFar));
  const refund = round2(toNumber(refundAmount));
  const refundable = Math.max(0, round2(gross - refunded));
  const payoutSettled = isSettledPayout(payoutStatus);

  // "Full" means this refund clears the remaining balance of a booking that
  // had not been refunded before — the supplier-refund service's original
  // definition, kept intact so its payouts do not change behaviour.
  const isFull = refunded === 0 && refund >= refundable - 0.005;

  const charge = isFull
    ? (payoutSettled ? payout : 0)
    : round2((payout * refund) / (gross || refund || 1));

  return {
    charge: Math.max(0, charge),
    isFull,
    payoutSettled,
    refundable,
    // Cumulative refunded total after this refund, capped at the gross so a
    // rounding artefact can never push a booking above 100%.
    newRefunded: round2(Math.min(gross || refunded + refund, refunded + refund)),
  };
}

module.exports = {
  SETTLED_PAYOUT_STATES,
  SUPPLIER_REFUND_CHARGE_REASON,
  CUSTOMER_CLAIM_CHARGE_REASON,
  isSettledPayout,
  supplierChargeForRefund,
  round2,
};
