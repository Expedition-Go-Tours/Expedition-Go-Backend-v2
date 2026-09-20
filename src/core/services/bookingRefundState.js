/**
 * Customer-facing refund state for a booking, derived from the booking's
 * status/paymentStatus and its refund-request (Dispute) lifecycle.
 *
 * Refund requests ("disputes") are opened by a supplier when a customer's
 * money should go back. From the customer's point of view:
 *   - 'open'   → a refund is in flight: an OPEN/UNDER_REVIEW request exists, or
 *                the booking was cancelled while the payment still shows
 *                SUCCEEDED and no refund has landed yet (refund pending).
 *   - 'closed' → money is back: paymentStatus REFUNDED / booking REFUNDED /
 *                refundedAt set, or the dispute was resolved in the customer's
 *                favour (RESOLVED_CUSTOMER).
 *   - null     → no refund lifecycle (nothing to show).
 *
 * Only ever reads fields that are safe to return to the customer.
 */

const OPEN_DISPUTE_STATUSES = ['OPEN', 'UNDER_REVIEW'];

function disputesOf(booking) {
  return Array.isArray(booking?.disputes) ? booking.disputes : [];
}

function bookingRefundState(booking) {
  if (!booking) return null;

  const disputes = disputesOf(booking);
  const hasOpenDispute = disputes.some((d) => d?.status && OPEN_DISPUTE_STATUSES.includes(d.status));
  if (hasOpenDispute) return 'open';

  // Customer-initiated refund claims follow the same lifecycle surface:
  // SUBMITTED / SUPPLIER_APPROVED / PROCESSING → refund in flight; RELEASED → money back.
  const claims = Array.isArray(booking?.refundClaims) ? booking.refundClaims : [];
  const hasPendingClaim = claims.some((c) => c?.status && ['SUBMITTED', 'SUPPLIER_APPROVED', 'PROCESSING'].includes(c.status));
  if (hasPendingClaim) return 'open';

  // Money is back.
  const refunded = booking.refundedAt
    || booking.status === 'REFUNDED'
    || booking.paymentStatus === 'REFUNDED'
    || disputes.some((d) => d?.status === 'RESOLVED_CUSTOMER')
    || claims.some((c) => c?.status === 'RELEASED');
  if (refunded) return 'closed';

  // Customer-cancelled while payment still shows SUCCEEDED and no refund landed:
  // the refund is pending (or was issued out-of-band). Show as open so the
  // customer can chase it up.
  if (booking.status === 'CANCELLED' && booking.paymentStatus === 'SUCCEEDED') return 'open';

  return null;
}

module.exports = { bookingRefundState };
