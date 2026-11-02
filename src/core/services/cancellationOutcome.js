/**
 * Cancellation outcome — one source of truth for cancellation emails.
 *
 * Every cancellation path (customer self-serve on either storefront, admin /
 * support override, supplier cancellation, and the automatic sweeps) decides
 * *which* email each side receives here, never inline and never from
 * "did the refund call succeed".
 *
 * The old bug: `refundSucceeded` was used as a lateness proxy, so an early
 * cancellation that happened to be unpaid (or whose refund was still pending)
 * was emailed as a late cancellation. Lateness is a property of the clock and
 * the policy, not of the payment processor.
 *
 * Resolution order (first match wins):
 *
 *   unpaid ............ no money was captured → "no payment was taken"
 *   platform .......... cancelled by supplier/platform/system → apology + refund
 *   late .............. cancelled after the free-cancellation deadline
 *   non-refundable .... policy refunds 0% → explain the policy, never "late"
 *   refund ............ eligible → refund band with live status
 *
 * `cancelledBy` accepts the Booking.cancellationOrigin values (CUSTOMER,
 * SUPPLIER, SYSTEM) plus ADMIN/PLATFORM, and falls back to CUSTOMER for legacy
 * rows with no origin.
 */

const { evaluateCancellationPolicy } = require('./bookingHelpers');

const CUSTOMER_TEMPLATES = {
  unpaid: 'customer-cancelled-unpaid',
  platform: 'supplier-cancelled-booking',
  late: 'customer-cancelled-no-refund',
  nonRefundable: 'customer-cancelled-non-refundable',
  refund: 'customer-cancelled-full-refund',
};

const SUPPLIER_TEMPLATES = {
  unpaid: 'supplier-customer-cancelled-unpaid',
  platform: 'supplier-platform-cancelled',
  late: 'supplier-customer-cancelled-late',
  nonRefundable: 'supplier-customer-cancelled-non-refundable',
  refund: 'supplier-customer-cancelled-free',
};

const CUSTOMER_SUBJECTS = {
  unpaid: 'Your booking has been cancelled',
  platform: 'Important: Your booking has been cancelled',
  late: 'Your booking has been cancelled',
  nonRefundable: 'Your booking has been cancelled',
  refund: 'Your booking has been cancelled — your refund is on its way',
};

const SUPPLIER_SUBJECTS = {
  unpaid: 'Booking cancelled — payment not collected',
  platform: 'Booking cancelled by the platform',
  late: 'Late customer cancellation',
  nonRefundable: 'Booking cancelled — non-refundable',
  refund: 'Booking cancelled — do not operate',
};

/** Normalise Booking.cancellationOrigin (or an explicit override). */
function normalizeOrigin(booking = {}, options = {}) {
  const raw = options.cancelledBy
    || options.cancellationOrigin
    || booking.cancellationOrigin
    || 'CUSTOMER';
  const origin = String(raw).toUpperCase();
  if (origin === 'CUSTOMER') return 'CUSTOMER';
  if (origin === 'SUPPLIER') return 'SUPPLIER';
  if (origin === 'SYSTEM') return 'SYSTEM';
  if (origin === 'ADMIN' || origin === 'PLATFORM') return 'ADMIN';
  return 'CUSTOMER';
}

/** True when no money was ever captured for this booking. */
function isUnpaid(booking = {}) {
  const status = String(booking.paymentStatus || '').toUpperCase();
  return !['SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(status);
}

/**
 * Resolve a refund state from explicit options first, then the booking row.
 * `refundSucceeded` is only consulted when the caller actually attempted a
 * refund — the absence of the option must not imply failure.
 */
function resolveRefundState(booking, { refundSucceeded, refundStatus } = {}) {
  const status = String(refundStatus || booking.refundStatus || '').toUpperCase();
  if (refundSucceeded === true) return 'succeeded';
  if (status === 'SUCCEEDED' || String(booking.paymentStatus).toUpperCase() === 'REFUNDED') return 'succeeded';
  if (status === 'FAILED') return 'failed';
  if (status === 'PENDING' || status === 'PROCESSING') return 'pending';
  if (refundSucceeded === false) return 'failed';
  return 'none';
}

/**
 * Resolve the complete cancellation outcome.
 *
 * @param {object} booking  Booking row (travelDate, paymentStatus, refund*,
 *                          cancellationOrigin/Code, grossAmount, …)
 * @param {object} [tour]   Tour row (bookingAndTickets.cancellationPolicy)
 * @param {object} [options]
 * @param {Date|string} [options.cancelledAt]
 * @param {string} [options.cancelledBy]      CUSTOMER | SUPPLIER | SYSTEM | ADMIN
 * @param {number} [options.refundAmount]
 * @param {boolean} [options.refundSucceeded]
 * @param {string} [options.refundStatus]
 * @returns {object} outcome
 */
function resolveCancellationOutcome(booking = {}, tour = {}, options = {}) {
  const cancelledAt = options.cancelledAt
    ? new Date(options.cancelledAt)
    : (booking.cancelledAt ? new Date(booking.cancelledAt) : new Date());
  const cancelledBy = normalizeOrigin(booking, options);
  const platformCancel = cancelledBy !== 'CUSTOMER';
  const unpaid = isUnpaid(booking);

  // Evaluate the policy at the moment of cancellation, so a cancellation that
  // happened yesterday is judged against yesterday's clock, not today's.
  const policy = evaluateCancellationPolicy(booking, tour, Number.isNaN(cancelledAt.getTime()) ? new Date() : cancelledAt);

  // A supplier/platform/system cancellation never "missed" the customer's
  // deadline — the customer did nothing wrong, so lateness is forced off.
  const isLate = platformCancel ? false : !!policy.isLate;
  const policyType = policy.policyType || 'standard';

  // Platform cancels always refund when money was captured, whatever the
  // product policy says. Customer cancels follow the policy.
  const refundEligible = platformCancel ? !unpaid : (!unpaid && !!policy.refundEligible);
  const nonRefundable = !unpaid && !platformCancel && !isLate && !refundEligible;

  const refundState = unpaid ? 'none' : resolveRefundState(booking, options);

  // Fallback amount: an unpaid booking refunds nothing; a platform cancel
  // refunds everything captured (policy percentages do not apply to a fault
  // cancellation); a customer cancel follows the policy.
  const fallbackAmount = unpaid
    ? 0
    : platformCancel
      ? Number(booking.refundAmount != null ? booking.refundAmount : booking.grossAmount || 0)
      : Number(booking.refundAmount != null ? booking.refundAmount : (nonRefundable ? 0 : policy.refundAmount || 0));

  const amount = options.refundAmount !== undefined && options.refundAmount !== null
    ? Number(options.refundAmount)
    : fallbackAmount;

  let branch;
  if (unpaid) branch = 'unpaid';
  else if (platformCancel) branch = 'platform';
  else if (isLate) branch = 'late';
  else if (nonRefundable) branch = 'nonRefundable';
  else branch = 'refund';

  return {
    cancelledAt,
    cancelledBy,
    platformCancel,
    isLate,
    refundEligible,
    nonRefundable,
    unpaid,
    policyType,
    deadline: policy.deadline || null,
    refundState,
    refundAmount: Number.isFinite(amount) ? amount : 0,
    branch,
    customerTemplateKey: CUSTOMER_TEMPLATES[branch],
    supplierTemplateKey: SUPPLIER_TEMPLATES[branch],
    customerSubject: CUSTOMER_SUBJECTS[branch],
    supplierSubject: SUPPLIER_SUBJECTS[branch],
  };
}

module.exports = {
  resolveCancellationOutcome,
  normalizeOrigin,
  isUnpaid,
  CUSTOMER_TEMPLATES,
  SUPPLIER_TEMPLATES,
  CUSTOMER_SUBJECTS,
  SUPPLIER_SUBJECTS,
};
