/**
 * Cancellation Reason Taxonomy — GetYourGuide's three structured categories.
 *
 * Replaces the old free-text reason + keyword-substring matching
 * (`EXCLUDED_REASON_KEYWORDS`) with an explicit code → category → rate/fee
 * mapping. Every cancellation written from now on carries:
 *
 *   cancellationCode     sub-reason code (this file's `code`)
 *   cancellationCategory OPERATIONAL | FORCE_MAJEURE | CUSTOMER_REQUESTED
 *   cancellationOrigin   SUPPLIER | CUSTOMER | SYSTEM
 *   countsTowardRate     boolean — the structured rate flag
 *
 * Rules (mirroring GYG Supplier T&C §3.10 + Performance Quality Standards):
 *  - OPERATIONAL         → counts toward the rate, 25% of retail fee applies
 *  - FORCE_MAJEURE       → excluded from the rate, no fee (evidence required)
 *  - CUSTOMER_REQUESTED  → excluded from the rate, no fee (supplier must state
 *                          whether they agree to refund the customer)
 *
 * Nothing in here touches the DB — pure data + validation, safe to unit test.
 */

const crypto = require('crypto');

const CATEGORIES = Object.freeze({
  OPERATIONAL: 'OPERATIONAL',
  FORCE_MAJEURE: 'FORCE_MAJEURE',
  CUSTOMER_REQUESTED: 'CUSTOMER_REQUESTED',
});

const ORIGINS = Object.freeze({
  SUPPLIER: 'SUPPLIER',
  CUSTOMER: 'CUSTOMER',
  SYSTEM: 'SYSTEM',
});

const REFUND_STATES = Object.freeze({
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
});

/**
 * The 25%-of-retail cancellation fee. Overridable via env for rollout.
 */
function cancellationFeePct() {
  const raw = parseFloat(process.env.SUPPLIER_CANCELLATION_FEE_PCT);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 100) return raw;
  return 25;
}

const REASONS = Object.freeze([
  // ── OPERATIONAL — the supplier cannot run the experience ─────────────────
  { code: 'GUIDE_UNAVAILABLE',    category: CATEGORIES.OPERATIONAL, label: 'Guide or staff unavailable' },
  { code: 'VEHICLE_BREAKDOWN',    category: CATEGORIES.OPERATIONAL, label: 'Vehicle or equipment breakdown' },
  { code: 'OVERBOOKED',           category: CATEGORIES.OPERATIONAL, label: 'Overbooked / capacity issue' },
  { code: 'NOT_ENOUGH_TRAVELERS', category: CATEGORIES.OPERATIONAL, label: 'Not enough travellers' },
  { code: 'VENUE_CLOSED',         category: CATEGORIES.OPERATIONAL, label: 'Venue or facility closed' },
  { code: 'SCHEDULING_CONFLICT',  category: CATEGORIES.OPERATIONAL, label: 'Scheduling conflict' },
  { code: 'OPERATIONAL_OTHER',    category: CATEGORIES.OPERATIONAL, label: 'Other operational reason' },

  // ── FORCE_MAJEURE — outside the supplier's control (excluded + no fee) ──
  { code: 'WEATHER',            category: CATEGORIES.FORCE_MAJEURE, label: 'Adverse weather conditions' },
  { code: 'NATURAL_DISASTER',   category: CATEGORIES.FORCE_MAJEURE, label: 'Natural disaster' },
  { code: 'GOVERNMENT_ACTION',  category: CATEGORIES.FORCE_MAJEURE, label: 'Government action or travel advisory' },
  { code: 'STRIKE',             category: CATEGORIES.FORCE_MAJEURE, label: 'Strike or civil unrest' },
  { code: 'SAFETY_INCIDENT',    category: CATEGORIES.FORCE_MAJEURE, label: 'Safety or security incident' },
  { code: 'PUBLIC_HEALTH',      category: CATEGORIES.FORCE_MAJEURE, label: 'Public health restriction' },
  { code: 'FORCE_MAJEURE_OTHER', category: CATEGORIES.FORCE_MAJEURE, label: 'Other force majeure event' },

  // ── CUSTOMER_REQUESTED — the traveller asked to cancel (excluded + no fee)
  { code: 'CUSTOMER_REQUESTED_CANCEL', category: CATEGORIES.CUSTOMER_REQUESTED, label: 'Customer asked to cancel this booking' },
]);

const REASON_BY_CODE = Object.freeze(
  REASONS.reduce((acc, r) => { acc[r.code] = r; return acc; }, {})
);

/**
 * Platform-initiated auto-cancel codes (origin = SYSTEM). Set programmatically
 * by the cleanup sweeps — never accepted from the supplier wizard (they always
 * carry countsTowardRate: false, so they can't hurt the supplier's rate).
 */
const SYSTEM_CODES = Object.freeze({
  PAYMENT_NOT_COMPLETED: 'Payment not completed',
  ACTIVITY_DATE_PASSED: 'Activity date passed without supplier confirmation',
  PAYMENT_NOT_COLLECTED: 'Payment could not be collected before the activity',
});

/**
 * The customer's own reason, as offered by the storefront cancellation modal.
 *
 * This is a second axis, not another fault category: the taxonomy above says
 * who is responsible, this says why the traveller left. The storefront sends
 * these codes and older rows already hold them in `cancellationReason`, so the
 * codes stay stable; the label is the only thing a person should ever read.
 */
const CUSTOMER_REASONS = Object.freeze([
  { code: 'SCHEDULE_CHANGED', label: 'My schedule changed' },
  { code: 'HEALTH_MEDICAL', label: 'Health or medical reasons' },
  { code: 'TRANSPORTATION', label: 'Transportation issues' },
  { code: 'WEATHER_SAFETY', label: 'Weather or safety concerns' },
  { code: 'FOUND_ALTERNATIVE', label: 'Found a better option' },
  { code: 'OTHER', label: 'Other' },
]);

const CUSTOMER_REASON_BY_CODE = Object.freeze(
  CUSTOMER_REASONS.reduce((acc, r) => { acc[r.code] = r; return acc; }, {})
);

// SCREAMING_SNAKE identifiers (HEALTH_MEDICAL, FOUND_SOMETHING_NEW). Free text
// such as "Payment not collected before the activity" never matches.
const CODE_LIKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function humanizeReasonCode(code) {
  const words = String(code || '').trim().toLowerCase().replace(/_+/g, ' ').trim();
  if (!words) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The one place a cancellation becomes readable text.
 *
 * Order matters:
 *   1. Customer-initiated cancellations carry the specific choice in
 *      `cancellationReason`; the taxonomy code on those rows is just
 *      CUSTOMER_REQUESTED_CANCEL, which names nobody's reason.
 *   2. Supplier/system rows carry a taxonomy code — use its label.
 *   3. Anything left is either prose or a code we do not know yet. Humanise
 *      code-like strings instead of printing underscores at a person; an
 *      unknown code should still say something, and the raw value stays
 *      available to logs and support.
 */
function displayCancellationReason(booking = {}) {
  const origin = String(booking.cancellationOrigin || '').trim().toUpperCase();
  const raw = typeof booking.cancellationReason === 'string'
    ? booking.cancellationReason.trim()
    : '';
  const customerReason = raw ? CUSTOMER_REASON_BY_CODE[raw.toUpperCase()] : null;

  if (origin === 'CUSTOMER' && raw) {
    return customerReason?.label || (CODE_LIKE.test(raw) ? humanizeReasonCode(raw) : raw);
  }

  const taxonomy = booking.cancellationCode ? getReason(booking.cancellationCode) : null;
  if (taxonomy) return taxonomy.label;

  if (!raw) return null;
  return CODE_LIKE.test(raw) ? humanizeReasonCode(raw) : raw;
}


// Category defaults — a category without a matching code still resolves.
const CATEGORY_RULES = Object.freeze({
  [CATEGORIES.OPERATIONAL]: { countsTowardRate: true, feeApplies: true },
  [CATEGORIES.FORCE_MAJEURE]: { countsTowardRate: false, feeApplies: false },
  [CATEGORIES.CUSTOMER_REQUESTED]: { countsTowardRate: false, feeApplies: false },
});

function getReason(code) {
  return REASON_BY_CODE[code] || null;
}

function getReasonsByCategory() {
  return {
    [CATEGORIES.OPERATIONAL]: REASONS.filter((r) => r.category === CATEGORIES.OPERATIONAL),
    [CATEGORIES.FORCE_MAJEURE]: REASONS.filter((r) => r.category === CATEGORIES.FORCE_MAJEURE),
    [CATEGORIES.CUSTOMER_REQUESTED]: REASONS.filter((r) => r.category === CATEGORIES.CUSTOMER_REQUESTED),
  };
}

/**
 * Structured rate/fee decision for a cancellation.
 * @param {{ cancellationCode?: string|null, cancellationCategory?: string|null, countsTowardRate?: boolean|null }} fields
 */
function rateAndFeeFor(fields = {}) {
  const reason = fields.cancellationCode ? getReason(fields.cancellationCode) : null;
  const category = reason?.category || fields.cancellationCategory || null;

  // Explicit flag always wins (setters may override, e.g. SYSTEM cancels).
  const countsTowardRate =
    typeof fields.countsTowardRate === 'boolean'
      ? fields.countsTowardRate
      : reason
        ? CATEGORY_RULES[reason.category].countsTowardRate
        : category
          ? (CATEGORY_RULES[category]?.countsTowardRate ?? true)
          : true;

  const feeApplies = reason
    ? CATEGORY_RULES[reason.category].feeApplies
    : category
      ? (CATEGORY_RULES[category]?.feeApplies ?? false)
      : false;

  return { category, countsTowardRate, feeApplies };
}

/**
 * 25%-of-retail cancellation fee, rounded to cents. 0 when the fee doesn't
 * apply or there is no retail price to charge it on.
 */
function calcCancellationFee(grossAmount, fields = {}) {
  const { feeApplies } = rateAndFeeFor(fields);
  if (!feeApplies) return 0;
  const gross = parseFloat(grossAmount);
  if (!Number.isFinite(gross) || gross <= 0) return 0;
  return Math.round(gross * (cancellationFeePct() / 100) * 100) / 100;
}

/**
 * Validate + normalize a cancellation payload (from the supplier wizard or
 * the batch endpoint). Returns { ok, errors, normalized } — never throws, so
 * both the zod refine and the controller's defense-in-depth can call it.
 *
 * Required, GYG-style:
 *  - cancellationCode from the taxonomy (mandatory — reason can't be skipped)
 *  - agreedToTerms === true (the T&C checkbox, timestamped for audit)
 *  - OPERATIONAL         → explanation (≥ 10 chars)
 *  - CUSTOMER_REQUESTED  → customerRefundAgreed boolean (agree/disagree on refund)
 *  - FORCE_MAJEURE       → explanation (≥ 20 chars) + evidenceUrl (http/https link)
 */
function validateCancellationPayload(body = {}) {
  const errors = [];
  const code = typeof body.cancellationCode === 'string' ? body.cancellationCode.trim() : '';
  const reason = getReason(code);

  if (!code) errors.push('cancellationCode is required');
  else if (!reason) errors.push(`Unknown cancellationCode "${code}"`);

  if (body.agreedToTerms !== true) {
    errors.push('agreedToTerms must be accepted');
  }

  const explanation = typeof body.explanation === 'string' ? body.explanation.trim() : '';
  const evidenceUrl = typeof body.evidenceUrl === 'string' ? body.evidenceUrl.trim() : '';

  let customerRefundAgreed = null;
  if (reason?.category === CATEGORIES.OPERATIONAL) {
    if (explanation.length < 10) errors.push('explanation must be at least 10 characters for an operational cancellation');
  } else if (reason?.category === CATEGORIES.CUSTOMER_REQUESTED) {
    if (typeof body.customerRefundAgreed !== 'boolean') {
      errors.push('customerRefundAgreed must be true or false when the customer requested the cancellation');
    } else {
      customerRefundAgreed = body.customerRefundAgreed;
    }
  } else if (reason?.category === CATEGORIES.FORCE_MAJEURE) {
    if (explanation.length < 20) errors.push('explanation must be at least 20 characters for a force majeure claim');
    if (!evidenceUrl || !/^https?:\/\/\S+$/i.test(evidenceUrl)) {
      errors.push('evidenceUrl must be an http(s) link (weather report, news article, notice) for a force majeure claim');
    }
  }

  const category = reason ? reason.category : null;
  const { countsTowardRate, feeApplies } = rateAndFeeFor({ cancellationCode: code });

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      cancellationCode: code,
      cancellationCategory: category,
      countsTowardRate,
      feeApplies,
      explanation,
      evidenceUrl: evidenceUrl || null,
      customerRefundAgreed,
      agreedToTerms: body.agreedToTerms === true,
    },
  };
}

/**
 * Attach the signed cancellation-choice token to a customer-facing booking
 * payload when — and only when — that booking is inside its supplier-cancel
 * choice window. Mutates + returns the row for chaining.
 *
 * CUSTOMER-FACING SERIALIZERS ONLY: the token lets its holder decide the
 * customer's refund-or-reschedule outcome, so it must never be attached to
 * supplier/admin payloads.
 */
function withChoiceToken(booking) {
  if (
    booking &&
    booking.status === 'CANCELLED' &&
    booking.cancellationOrigin === 'SUPPLIER' &&
    booking.cancellationChoiceDeadline &&
    !booking.customerChoice
  ) {
    booking.cancellationChoiceToken = signChoiceToken(booking.id, booking.cancellationChoiceDeadline);
  }
  return booking;
}

// ────────────────────────────────────────────────────────────────────────────
// Cancellation-choice tokens — stateless signed links for the customer's
// "new date OR full refund" decision (no login required, 48h deadline baked in).
// Format: <bookingId>.<deadlineMs>.<hmac-sha256>
// ────────────────────────────────────────────────────────────────────────────

function tokenSecret() {
  return process.env.CANCELLATION_TOKEN_SECRET || process.env.JWT_SECRET || '';
}

function signChoiceToken(bookingId, deadline) {
  const secret = tokenSecret();
  if (!secret || !bookingId || !deadline) return null;
  const deadlineMs = new Date(deadline).getTime();
  if (!Number.isFinite(deadlineMs)) return null;
  const payload = `${bookingId}.${deadlineMs}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyChoiceToken(token) {
  const secret = tokenSecret();
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [bookingId, deadlineMsRaw, sig] = parts;
  const deadlineMs = parseInt(deadlineMsRaw, 10);
  if (!bookingId || !Number.isFinite(deadlineMs)) return null;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${bookingId}.${deadlineMs}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return { bookingId, deadline: new Date(deadlineMs) };
}

module.exports = {
  CATEGORIES,
  ORIGINS,
  REFUND_STATES,
  REASONS,
  SYSTEM_CODES,
  CUSTOMER_REASONS,
  CUSTOMER_REASON_BY_CODE,
  CATEGORY_RULES,
  getReason,
  getReasonsByCategory,
  humanizeReasonCode,
  displayCancellationReason,
  rateAndFeeFor,
  cancellationFeePct,
  calcCancellationFee,
  validateCancellationPayload,
  signChoiceToken,
  verifyChoiceToken,
  withChoiceToken,
};
