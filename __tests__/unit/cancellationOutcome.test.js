/**
 * Cancellation routing — the matrix that decides which email each side gets.
 *
 * The bug this guards against: lateness used to be inferred from whether the
 * refund call succeeded, so early-but-unpaid cancellations were emailed as
 * "after the free-cancellation deadline". Every assertion below is about the
 * policy and the clock.
 */

const fs = require('fs');
const path = require('path');

const { resolveCancellationOutcome } = require('../../src/core/services/cancellationOutcome');
const { evaluateCancellationPolicy } = require('../../src/core/services/bookingHelpers');
const { normalizeCancellationOptions } = require('../../src/core/services/emailService');
const { TEMPLATE_DEFS } = require('../../scripts/buildEmailTemplates');
const { render } = require('../../src/core/services/emailRenderer');
const { SHELL, SAMPLE } = require('../../src/core/services/emailPreviews');

const HOUR = 60 * 60 * 1000;

function booking(overrides = {}) {
  return {
    id: 'bk-1',
    bookingNumber: 'TRG-1',
    grossAmount: '400',
    travelDate: new Date(Date.now() + 48 * HOUR),
    paymentStatus: 'SUCCEEDED',
    paymentTiming: 'now',
    paidAt: new Date(Date.now() - 3 * HOUR),
    refundStatus: 'NOT_APPLICABLE',
    ...overrides,
  };
}

function tour(policy) {
  return { bookingAndTickets: policy ? { cancellationPolicy: policy } : {} };
}

function buildDef(key) {
  const def = TEMPLATE_DEFS.find((d) => d.key === key);
  if (!def) throw new Error(`Template not defined: ${key}`);
  return def.build();
}

function renderDef(key, overrides = {}) {
  return render(buildDef(key), { ...SHELL, ...SAMPLE, ...overrides });
}

describe('resolveCancellationOutcome', () => {
  describe('branch selection', () => {
    it('routes an early paid cancellation with a completed refund to the refund templates', () => {
      const out = resolveCancellationOutcome(booking(), tour(), { refundSucceeded: true });

      expect(out.branch).toBe('refund');
      expect(out.customerTemplateKey).toBe('customer-cancelled-full-refund');
      expect(out.supplierTemplateKey).toBe('supplier-customer-cancelled-free');
      expect(out.refundState).toBe('succeeded');
      expect(out.isLate).toBe(false);
    });

    it('keeps an early paid cancellation on the refund templates while the refund is pending', () => {
      const out = resolveCancellationOutcome(
        booking({ refundStatus: 'PENDING' }),
        tour(),
        { refundSucceeded: false },
      );

      expect(out.branch).toBe('refund');
      expect(out.refundState).toBe('pending');
      expect(out.isLate).toBe(false);
    });

    it('routes an unpaid reserve-now-pay-later booking to the unpaid templates', () => {
      const out = resolveCancellationOutcome(
        booking({ paymentStatus: 'PENDING', paymentTiming: 'later', paidAt: null }),
        tour(),
        {},
      );

      expect(out.unpaid).toBe(true);
      expect(out.branch).toBe('unpaid');
      expect(out.customerTemplateKey).toBe('customer-cancelled-unpaid');
      expect(out.supplierTemplateKey).toBe('supplier-customer-cancelled-unpaid');
      expect(out.isLate).toBe(false);
      expect(out.refundAmount).toBe(0);
    });

    it('routes all_sales_final to the non-refundable templates', () => {
      const out = resolveCancellationOutcome(
        booking(),
        tour({ type: 'all_sales_final' }),
        {},
      );

      expect(out.branch).toBe('nonRefundable');
      expect(out.customerTemplateKey).toBe('customer-cancelled-non-refundable');
      expect(out.supplierTemplateKey).toBe('supplier-customer-cancelled-non-refundable');
      expect(out.isLate).toBe(false);
      expect(out.deadline).toBeNull();
    });

    it('routes a 0% standard policy to the non-refundable templates', () => {
      const out = resolveCancellationOutcome(
        booking(),
        tour({ type: 'standard', cancellationWindowHours: 24, refundPercentage: 0 }),
        {},
      );

      expect(out.branch).toBe('nonRefundable');
      expect(out.nonRefundable).toBe(true);
      expect(out.isLate).toBe(false);
    });

    it('routes a genuinely late cancellation to the late templates', () => {
      const late = booking({ travelDate: new Date(Date.now() + 6 * HOUR) });
      const out = resolveCancellationOutcome(late, tour(), { refundSucceeded: false });

      expect(out.isLate).toBe(true);
      expect(out.branch).toBe('late');
      expect(out.customerTemplateKey).toBe('customer-cancelled-no-refund');
      expect(out.supplierTemplateKey).toBe('supplier-customer-cancelled-late');
    });
  });

  describe('lateness is never inferred from the refund', () => {
    it('does not call an early cancellation late because its refund failed', () => {
      const out = resolveCancellationOutcome(
        booking({ refundStatus: 'FAILED' }),
        tour(),
        { refundSucceeded: false },
      );

      expect(out.isLate).toBe(false);
      expect(out.branch).toBe('refund');
      expect(out.refundState).toBe('failed');
      expect(out.customerTemplateKey).toBe('customer-cancelled-full-refund');
    });

    it('does not call an early unpaid cancellation late', () => {
      const out = resolveCancellationOutcome(
        booking({ paymentStatus: 'FAILED', paidAt: null }),
        tour(),
        { refundAmount: 0 },
      );

      expect(out.isLate).toBe(false);
      expect(out.customerTemplateKey).toBe('customer-cancelled-unpaid');
    });

    it('does not call the pay-later sweep late', () => {
      const out = resolveCancellationOutcome(
        booking({ paymentStatus: 'FAILED', paymentTiming: 'later', paidAt: null }),
        tour(),
        { cancelledBy: 'SYSTEM', refundAmount: 0, refundStatus: 'NOT_APPLICABLE' },
      );

      expect(out.isLate).toBe(false);
      expect(out.unpaid).toBe(true);
      expect(out.supplierTemplateKey).toBe('supplier-customer-cancelled-unpaid');
    });

    it('judges lateness against the cancellation time, not now', () => {
      // Cancelled 30h before a 60h-away activity: on time at cancel time even
      // though the booking is now inside the 24h window.
      const cancelledAt = new Date(Date.now() - 6 * HOUR);
      const out = resolveCancellationOutcome(
        booking({ travelDate: new Date(Date.now() + 24 * HOUR) }),
        tour(),
        { cancelledAt },
      );

      expect(out.isLate).toBe(false);
    });
  });

  describe('supplier and platform cancellations', () => {
    it('never marks a supplier cancellation as late and uses the apology templates', () => {
      const out = resolveCancellationOutcome(
        booking({ travelDate: new Date(Date.now() + 1 * HOUR) }),
        tour(),
        { cancelledBy: 'SUPPLIER' },
      );

      expect(out.isLate).toBe(false);
      expect(out.branch).toBe('platform');
      expect(out.customerTemplateKey).toBe('supplier-cancelled-booking');
      expect(out.supplierTemplateKey).toBe('supplier-platform-cancelled');
      expect(out.customerSubject).toMatch(/cancelled/i);
    });

    it('refunds everything on a platform cancel regardless of a non-refundable policy', () => {
      const out = resolveCancellationOutcome(
        booking(),
        tour({ type: 'all_sales_final' }),
        { cancelledBy: 'SYSTEM' },
      );

      expect(out.branch).toBe('platform');
      expect(out.refundAmount).toBe(400);
    });

    it('falls back to CUSTOMER for legacy rows with no origin', () => {
      const out = resolveCancellationOutcome(booking(), tour(), {});
      expect(out.cancelledBy).toBe('CUSTOMER');
      expect(out.platformCancel).toBe(false);
    });
  });

  describe('evaluateCancellationPolicy (additive fields)', () => {
    it('exposes deadline, lateness, refund eligibility and policy type', () => {
      const b = booking();
      const result = evaluateCancellationPolicy(b, tour(), new Date());

      expect(result.deadline).toBeInstanceOf(Date);
      expect(result.isLate).toBe(false);
      expect(result.refundEligible).toBe(true);
      expect(result.policyType).toBe('standard');
      // Existing contract unchanged.
      expect(result.allowed).toBe(true);
      expect(result.refundAmount).toBe(400);
    });

    it('reports the 24h default deadline when the tour declares no policy', () => {
      const b = booking();
      const result = evaluateCancellationPolicy(b, tour(), new Date());
      const expected = new Date(b.travelDate.getTime() - 24 * HOUR);

      expect(result.deadline.getTime()).toBe(expected.getTime());
    });

    it('marks a missed window as late without changing the allowed flag', () => {
      const b = booking({ travelDate: new Date(Date.now() + 6 * HOUR) });
      const result = evaluateCancellationPolicy(b, tour(), new Date());

      expect(result.isLate).toBe(true);
      expect(result.allowed).toBe(false);
      expect(result.refundEligible).toBe(false);
    });

    it('treats all_sales_final as allowed but never refundable', () => {
      const result = evaluateCancellationPolicy(booking(), tour({ type: 'all_sales_final' }), new Date());

      expect(result.allowed).toBe(true);
      expect(result.refundEligible).toBe(false);
      expect(result.isLate).toBe(false);
      expect(result.deadline).toBeNull();
    });

    it('treats a 0h window as open, not as a 24h window', () => {
      const b = booking({ travelDate: new Date(Date.now() + 2 * HOUR) });
      const result = evaluateCancellationPolicy(
        b,
        tour({ type: 'standard', cancellationWindowHours: 0 }),
        new Date(),
      );

      expect(result.allowed).toBe(true);
      expect(result.isLate).toBe(false);
    });
  });
});

describe('normalizeCancellationOptions', () => {
  it('keeps the legacy numeric refund-amount call shape', () => {
    expect(normalizeCancellationOptions(100)).toEqual({ refundAmount: 100, refundSucceeded: true });
    expect(normalizeCancellationOptions(0)).toEqual({ refundAmount: 0, refundSucceeded: false });
  });

  it('passes an explicit context object through unchanged', () => {
    const ctx = { cancelledBy: 'SYSTEM', refundAmount: 0 };
    expect(normalizeCancellationOptions(ctx)).toBe(ctx);
  });

  it('treats null/undefined as an empty context', () => {
    expect(normalizeCancellationOptions(null)).toEqual({});
    expect(normalizeCancellationOptions(undefined)).toEqual({});
  });
});

describe('cancellation template copy', () => {
  it('never says "after the free-cancellation deadline" in the unpaid template', () => {
    const html = renderDef('customer-cancelled-unpaid', {
      cancellationPolicyText: 'Free cancellation up to 24 hours before your experience.',
    });

    expect(html).toContain('No payment was taken');
    expect(html).not.toMatch(/after the free-cancellation deadline/i);
    expect(html).not.toMatch(/outside the free-cancellation window/i);
  });

  it('never says "after the free-cancellation deadline" in the non-refundable template', () => {
    const html = renderDef('customer-cancelled-non-refundable', {
      cancellationPolicyText: 'All sales are final. This experience is non-refundable.',
    });

    expect(html).toContain('non-refundable');
    expect(html).not.toMatch(/after the free-cancellation deadline/i);
  });

  it('states the deadline only in the late template', () => {
    const late = renderDef('customer-cancelled-no-refund', {
      cancelledAtLabel: '4 Nov 2026, 08:01 GMT',
      cancellationDeadlineLabel: 'November 3, 2026, 9:00 AM',
    });

    expect(late).toContain('November 3, 2026, 9:00 AM');
    expect(late).toContain('after the free-cancellation deadline');
  });

  it('says no payout will be issued in every supplier cancellation template', () => {
    const keys = [
      'supplier-customer-cancelled-free',
      'supplier-customer-cancelled-unpaid',
      'supplier-customer-cancelled-non-refundable',
      'supplier-customer-cancelled-late',
    ];

    for (const key of keys) {
      const html = renderDef(key, {
        payoutAmountLabel: '$0.00',
        refundAmountLabel: '$0.00',
        refundIssued: key === 'supplier-customer-cancelled-free',
        refundPending: false,
        refundFailed: false,
      });

      expect(html).toMatch(/no payout will be issued/i);
      expect(html).toContain('$0.00');
    }
  });

  it('only blames the deadline in the late supplier template', () => {
    const notLate = [
      'supplier-customer-cancelled-free',
      'supplier-customer-cancelled-unpaid',
      'supplier-customer-cancelled-non-refundable',
    ];

    for (const key of notLate) {
      expect(renderDef(key, { payoutAmountLabel: '$0.00' }))
        .not.toMatch(/after the free-cancellation deadline/i);
    }

    expect(renderDef('supplier-customer-cancelled-late', { payoutAmountLabel: '$0.00' }))
      .toMatch(/after the free-cancellation deadline/i);
  });

  it('says no payout on a platform cancellation', () => {
    const html = renderDef('supplier-platform-cancelled', { payoutAmountLabel: '$0.00' });
    expect(html).toContain('Do not operate');
    expect(html).not.toMatch(/after the free-cancellation deadline/i);
  });

  it('leaves no unresolved Handlebars variables in any cancellation template', () => {
    const keys = TEMPLATE_DEFS
      .map((d) => d.key)
      .filter((k) => k.includes('cancelled') || k.includes('cancellation') || k === 'review-request' || k === 'supplier-review-invite');

    for (const key of keys) {
      const html = renderDef(key, { refundIssued: true, refundPending: false, refundFailed: false });
      // Only #each/unknown-block leftovers would survive the renderer.
      expect(html).not.toMatch(/\{\{[#/]?\s*[a-zA-Z]/);
    }
  });

  it('deep-links the review stars to ?rating=N', () => {
    const html = renderDef('review-request');

    for (let n = 1; n <= 5; n += 1) {
      expect(html).toContain(`rating=${n}`);
    }
  });
});

describe('cancellation entry points stay mirrored', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

  it('both storefronts pass the same cancellation context to both emails', () => {
    const travio = read('src/core/storefront.js');
    const ghana = read('src/brands/ghana/controller.js');

    for (const source of [travio, ghana]) {
      expect(source).toContain('sendSupplierCancellationEmail(booking, cancellationContext)');
      expect(source).toContain("cancelledBy: 'CUSTOMER'");
      expect(source).toContain('type: \'booking-cancellation\'');
      expect(source).toContain('data: cancellationContext');
      // The refund-success ternary that misrouted suppliers is gone.
      expect(source).not.toContain('refundSucceeded\n');
    }
  });

  it('neither storefront picks a supplier template inline any more', () => {
    for (const file of ['src/core/storefront.js', 'src/brands/ghana/controller.js']) {
      expect(read(file)).not.toContain('supplier-customer-cancelled-free');
      expect(read(file)).not.toContain('supplier-customer-cancelled-late');
    }
  });

  it('the compiled template set still contains every routed key', () => {
    const defined = new Set(TEMPLATE_DEFS.map((d) => d.key));
    const required = [
      'customer-cancelled-full-refund',
      'customer-cancelled-unpaid',
      'customer-cancelled-non-refundable',
      'customer-cancelled-no-refund',
      'supplier-cancelled-booking',
      'supplier-customer-cancelled-free',
      'supplier-customer-cancelled-unpaid',
      'supplier-customer-cancelled-non-refundable',
      'supplier-customer-cancelled-late',
      'supplier-platform-cancelled',
      'review-request',
      'supplier-review-invite',
    ];

    for (const key of required) expect(defined).toContain(key);
  });
});
