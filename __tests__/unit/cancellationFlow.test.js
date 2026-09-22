/**
 * GetYourGuide-style supplier cancellation flow — unit tests.
 *
 * Covers the pure decision layers (no DB / no Stripe):
 *  - the 3-category reason taxonomy + wizard payload validation
 *  - the 25%-of-retail fee (and its waivers)
 *  - signed reschedule-or-refund tokens
 *  - the structured cancellation-rate decision + GYG thresholds
 *  - the money rule: supplier cancels ⇒ ALWAYS full refund (policy ignored)
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const {
  REASONS,
  CATEGORIES,
  getReason,
  validateCancellationPayload,
  calcCancellationFee,
  cancellationFeePct,
  signChoiceToken,
  verifyChoiceToken,
  withChoiceToken,
} = require('../../src/core/services/cancellationReasons');
const { isSupplierCaused, getStatus } = require('../../src/core/domain/cancellationController');
const { plannedRefund } = require('../../src/core/services/supplierCancellation');

// ── Taxonomy ────────────────────────────────────────────────────────────────

describe('cancellation reason taxonomy', () => {
  it('only contains the three GYG categories', () => {
    const categories = new Set(REASONS.map((r) => r.category));
    expect([...categories].sort()).toEqual(
      [CATEGORIES.CUSTOMER_REQUESTED, CATEGORIES.FORCE_MAJEURE, CATEGORIES.OPERATIONAL].sort()
    );
  });

  it('operational reasons count toward the rate; force majeure + customer-requested do not', () => {
    for (const r of REASONS) {
      const payload = basePayload(r.code);
      const { ok, normalized } = validateCancellationPayload(payload);
      expect(ok).toBe(true);
      if (r.category === CATEGORIES.OPERATIONAL) {
        expect(normalized.countsTowardRate).toBe(true);
        expect(normalized.feeApplies).toBe(true);
      } else {
        expect(normalized.countsTowardRate).toBe(false);
        expect(normalized.feeApplies).toBe(false);
      }
    }
  });

  it('rejects codes outside the taxonomy', () => {
    expect(getReason('MY_DOG_IS_SICK')).toBeNull();
    const { ok, errors } = validateCancellationPayload(basePayload('MY_DOG_IS_SICK'));
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/Unknown cancellationCode/);
  });
});

// ── Wizard payload validation ───────────────────────────────────────────────

function basePayload(code) {
  const reason = getReason(code) || { category: CATEGORIES.OPERATIONAL };
  const payload = { cancellationCode: code, agreedToTerms: true };
  if (reason.category === CATEGORIES.OPERATIONAL) payload.explanation = 'Guide had an accident';
  if (reason.category === CATEGORIES.FORCE_MAJEURE) {
    payload.explanation = 'Cyclone warning issued for the coastline this week';
    payload.evidenceUrl = 'https://weather.example/storm-report';
  }
  if (reason.category === CATEGORIES.CUSTOMER_REQUESTED) payload.customerRefundAgreed = true;
  return payload;
}

describe('validateCancellationPayload', () => {
  it('requires a structured reason and the T&C checkbox', () => {
    const { ok, errors } = validateCancellationPayload({});
    expect(ok).toBe(false);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/cancellationCode is required/),
        expect.stringMatching(/agreedToTerms/),
      ])
    );
  });

  it('requires an explanation for operational cancels', () => {
    const { ok, errors } = validateCancellationPayload({
      cancellationCode: 'GUIDE_UNAVAILABLE',
      agreedToTerms: true,
      explanation: 'no',
    });
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/at least 10 characters/);
  });

  it('requires evidence + a long explanation for force-majeure claims', () => {
    const withoutEvidence = validateCancellationPayload({
      cancellationCode: 'WEATHER',
      agreedToTerms: true,
      explanation: 'Cyclone warning issued for the coastline this week',
    });
    expect(withoutEvidence.ok).toBe(false);
    expect(withoutEvidence.errors.join(' ')).toMatch(/evidenceUrl/);

    const badUrl = validateCancellationPayload({
      ...basePayload('WEATHER'),
      evidenceUrl: 'not-a-url',
    });
    expect(badUrl.ok).toBe(false);

    expect(validateCancellationPayload(basePayload('WEATHER')).ok).toBe(true);
  });

  it('requires the refund-agreement for customer-requested cancels', () => {
    const missing = validateCancellationPayload({
      cancellationCode: 'CUSTOMER_REQUESTED_CANCEL',
      agreedToTerms: true,
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(' ')).toMatch(/customerRefundAgreed/);

    const agreed = validateCancellationPayload({
      cancellationCode: 'CUSTOMER_REQUESTED_CANCEL',
      agreedToTerms: true,
      customerRefundAgreed: false,
    });
    expect(agreed.ok).toBe(true);
    expect(agreed.normalized.customerRefundAgreed).toBe(false);
  });
});

// ── The 25% fee ─────────────────────────────────────────────────────────────

describe('cancellation fee', () => {
  afterEach(() => {
    delete process.env.SUPPLIER_CANCELLATION_FEE_PCT;
  });

  it('defaults to 25% of retail, rounded to cents', () => {
    expect(cancellationFeePct()).toBe(25);
    expect(calcCancellationFee(100, { cancellationCode: 'OVERBOOKED' })).toBe(25);
    expect(calcCancellationFee(33.33, { cancellationCode: 'OVERBOOKED' })).toBe(8.33);
  });

  it('never applies to force-majeure or customer-requested cancels', () => {
    expect(calcCancellationFee(100, { cancellationCode: 'WEATHER' })).toBe(0);
    expect(calcCancellationFee(100, { cancellationCode: 'CUSTOMER_REQUESTED_CANCEL' })).toBe(0);
  });

  it('never charges on a zero-price booking', () => {
    expect(calcCancellationFee(0, { cancellationCode: 'OVERBOOKED' })).toBe(0);
  });

  it('honors the env override', () => {
    process.env.SUPPLIER_CANCELLATION_FEE_PCT = '10';
    expect(calcCancellationFee(100, { cancellationCode: 'OVERBOOKED' })).toBe(10);
    process.env.SUPPLIER_CANCELLATION_FEE_PCT = 'not-a-number';
    expect(cancellationFeePct()).toBe(25);
  });
});

// ── Choice tokens ───────────────────────────────────────────────────────────

describe('cancellation choice tokens', () => {
  const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000);

  it('round-trips booking + deadline', () => {
    const token = signChoiceToken('bkg_123', deadline);
    const parsed = verifyChoiceToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed.bookingId).toBe('bkg_123');
    expect(parsed.deadline.getTime()).toBe(deadline.getTime());
  });

  it('rejects tampered and garbage tokens', () => {
    const token = signChoiceToken('bkg_123', deadline);
    expect(verifyChoiceToken(token.replace('bkg_123', 'bkg_999'))).toBeNull();
    expect(verifyChoiceToken('bkg_123.deadline.forged')).toBeNull();
    expect(verifyChoiceToken('')).toBeNull();
    expect(verifyChoiceToken(null)).toBeNull();
  });

  it('only exposes a token on bookings inside their choice window', () => {
    const inWindow = withChoiceToken({
      id: 'b1',
      status: 'CANCELLED',
      cancellationOrigin: 'SUPPLIER',
      cancellationChoiceDeadline: deadline,
      customerChoice: null,
    });
    expect(inWindow.cancellationChoiceToken).toBeTruthy();

    const answered = withChoiceToken({
      id: 'b2',
      status: 'CANCELLED',
      cancellationOrigin: 'SUPPLIER',
      cancellationChoiceDeadline: deadline,
      customerChoice: 'REFUND',
    });
    expect(answered.cancellationChoiceToken).toBeUndefined();

    const supplierView = withChoiceToken({
      id: 'b3',
      status: 'CONFIRMED',
      cancellationChoiceDeadline: deadline,
    });
    expect(supplierView.cancellationChoiceToken).toBeUndefined();
  });
});

// ── Rate decision ───────────────────────────────────────────────────────────

describe('isSupplierCaused (structured, no keyword matching)', () => {
  it('reads the structured flag when present', () => {
    expect(
      isSupplierCaused({ status: 'CANCELLED', countsTowardRate: true, cancellationOrigin: 'SUPPLIER' })
    ).toBe(true);
    expect(
      isSupplierCaused({ status: 'CANCELLED', countsTowardRate: false, cancellationOrigin: 'SUPPLIER' })
    ).toBe(false);
  });

  it('never counts customer- or system-initiated cancels, whatever the text says', () => {
    expect(
      isSupplierCaused({ status: 'CANCELLED', cancellationOrigin: 'CUSTOMER', countsTowardRate: true })
    ).toBe(false);
    expect(
      isSupplierCaused({ status: 'CANCELLED', cancellationOrigin: 'SYSTEM', countsTowardRate: true })
    ).toBe(false);
  });

  it('derives from the taxonomy code when the flag is missing', () => {
    expect(isSupplierCaused({ status: 'CANCELLED', cancellationCode: 'VEHICLE_BREAKDOWN' })).toBe(true);
    expect(isSupplierCaused({ status: 'CANCELLED', cancellationCode: 'WEATHER' })).toBe(false);
    expect(isSupplierCaused({ status: 'CANCELLED', cancellationCode: 'CUSTOMER_REQUESTED_CANCEL' })).toBe(false);
  });

  it('falls back to the legacy heuristic only for unbackfilled rows', () => {
    expect(isSupplierCaused({ status: 'CANCELLED', cancellationReason: 'Weather conditions' })).toBe(false);
    expect(isSupplierCaused({ status: 'CANCELLED', cancellationReason: 'Force majeure strike' })).toBe(false);
    expect(isSupplierCaused({ status: 'CANCELLED', cancellationReason: 'Vehicle broke down' })).toBe(true);
    expect(isSupplierCaused({ status: 'REFUNDED', cancellationReason: 'Customer changed plans' })).toBe(false);
  });
});

describe('getStatus (GYG thresholds)', () => {
  it('waives the rating below 10 bookings', () => {
    expect(getStatus(80, 9)).toBe('Building performance record');
    expect(getStatus(0, 0)).toBe('Building performance record');
  });

  it('applies ≤1 / ≤2 / ≤5 / >5 boundaries', () => {
    expect(getStatus(0.4, 50)).toBe('Excellent');
    expect(getStatus(1, 50)).toBe('Excellent');
    expect(getStatus(1.1, 50)).toBe('Good');
    expect(getStatus(2, 50)).toBe('Good');
    expect(getStatus(2.1, 50)).toBe('Needs attention');
    expect(getStatus(5, 50)).toBe('Needs attention');
    expect(getStatus(5.1, 50)).toBe('High');
  });
});

// ── Route wiring: the { body, query, params } envelope ──────────────────────
// middleware/validate.js parses the WHOLE envelope and writes each slice back
// onto the request — a body-only schema would 400 every call with
// "status: Required". These tests pin that contract.
describe('zod schemas as validate() sees them (envelope)', () => {
  const { updateBookingStatusSchema, bulkCancelSchema } = require('../../src/core/services/cancellationSchemas');
  const wrap = (body, params = { id: 'bkg_1' }) => ({ body, query: {}, params });

  it('passes a non-cancel transition and preserves params.id', () => {
    const result = updateBookingStatusSchema.safeParse(wrap({ status: 'COMPLETED', supplierNotes: 'done' }));
    expect(result.success).toBe(true);
    expect(result.data.params.id).toBe('bkg_1');
    expect(result.data.body.status).toBe('COMPLETED');
  });

  it('rejects an unstructured supplier cancel (the old free-text flow)', () => {
    const result = updateBookingStatusSchema.safeParse(wrap({ status: 'CANCELLED', reason: 'sorry, guide sick' }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error.issues)).toMatch(/cancellationCode/);
  });

  it('accepts a fully structured cancel and passes the wizard fields through', () => {
    const result = updateBookingStatusSchema.safeParse(
      wrap({
        status: 'CANCELLED',
        cancellationCode: 'GUIDE_UNAVAILABLE',
        agreedToTerms: true,
        explanation: 'Guide had an accident',
        supplierNotes: 'Customer called too',
      })
    );
    expect(result.success).toBe(true);
    expect(result.data.body.cancellationCode).toBe('GUIDE_UNAVAILABLE');
  });

  it('enforces the same rules on the bulk wizard schema', () => {
    const base = { tourId: 't1', dateFrom: '2026-10-01', dateTo: '2026-10-03', stopAcceptingBookings: true };
    const unstructured = bulkCancelSchema.safeParse({ body: base, query: {}, params: {} });
    expect(unstructured.success).toBe(false);

    const ok = bulkCancelSchema.safeParse({
      body: {
        ...base,
        cancellationCode: 'WEATHER',
        agreedToTerms: true,
        explanation: 'Cyclone warning issued for the coastline this week',
        evidenceUrl: 'https://weather.example/storm',
      },
      query: {},
      params: {},
    });
    expect(ok.success).toBe(true);
    expect(ok.data.body.stopAcceptingBookings).toBe(true);
  });
});


describe('plannedRefund (supplier cancels ⇒ always full refund)', () => {
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  // An all-sales-final tour would refund the customer NOTHING under the
  // customer-facing policy — a supplier cancel must override that entirely.
  const allSalesFinalTour = {
    bookingAndTickets: { cancellationPolicy: { type: 'all_sales_final' } },
  };
  const paidBooking = {
    paymentStatus: 'SUCCEEDED',
    grossAmount: 100,
    travelDate: futureDate,
  };

  it('returns the full retail amount for operational cancels, ignoring the policy', () => {
    const { amount } = plannedRefund(paidBooking, allSalesFinalTour, {
      cancellationCategory: CATEGORIES.OPERATIONAL,
      customerRefundAgreed: null,
    });
    expect(amount).toBe(100);
  });

  it('returns the full retail amount for force-majeure cancels too', () => {
    const { amount } = plannedRefund(paidBooking, allSalesFinalTour, {
      cancellationCategory: CATEGORIES.FORCE_MAJEURE,
      customerRefundAgreed: null,
    });
    expect(amount).toBe(100);
  });

  it('returns the full amount when the customer asked to cancel and supplier agrees to refund', () => {
    const { amount } = plannedRefund(paidBooking, allSalesFinalTour, {
      cancellationCategory: CATEGORIES.CUSTOMER_REQUESTED,
      customerRefundAgreed: true,
    });
    expect(amount).toBe(100);
  });

  it('falls back to the tour policy when the supplier disagrees on a customer-requested cancel', () => {
    const { amount, note } = plannedRefund(paidBooking, allSalesFinalTour, {
      cancellationCategory: CATEGORIES.CUSTOMER_REQUESTED,
      customerRefundAgreed: false,
    });
    expect(amount).toBe(0); // all-sales-final pays nothing
    expect(note).toMatch(/policy/);
  });

  it('refunds nothing when the booking was never paid', () => {
    const { amount } = plannedRefund(
      { ...paidBooking, paymentStatus: 'PENDING' },
      allSalesFinalTour,
      { cancellationCategory: CATEGORIES.OPERATIONAL, customerRefundAgreed: null }
    );
    expect(amount).toBe(0);
  });
});
