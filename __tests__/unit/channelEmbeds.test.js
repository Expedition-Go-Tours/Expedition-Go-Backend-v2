const {
  salesBookingConfirmed,
  salesBookingCancelled,
  salesPaymentFailed,
  salesRefundIssued,
  verificationSupplierApplication,
  verificationStatusChange,
  verificationTourSubmitted,
  verificationTourUpdateSubmitted,
  approvalPayoutRequest,
  approvalPayoutResult,
  approvalRefundRequest,
  approvalRefundResult,
  money,
  formatDeclineReason,
} = require('../../src/core/services/channelEmbeds');

describe('channelEmbeds — decline reason', () => {
  it('prefers the charge outcome over the generic PaymentIntent code', () => {
    // The exact pair from pi_3UJiFyCgYMgEuT2o1IgLU8Id (25 Sept 2026): the
    // PaymentIntent only says "payment attempt failed", the bank's decline is
    // on the charge.
    expect(
      formatDeclineReason(
        { code: 'payment_intent_payment_attempt_failed', message: 'The payment failed.' },
        {
          type: 'issuer_declined',
          reason: 'generic_decline',
          network_status: 'declined_by_network',
          seller_message: 'The bank did not return any further details with this decline.',
        }
      )
    ).toBe('issuer_declined / generic_decline — The bank did not return any further details with this decline.');
  });

  it('falls back to the PaymentIntent error when there is no charge outcome', () => {
    expect(formatDeclineReason({ decline_code: 'insufficient_funds' })).toBe('insufficient_funds');
    expect(formatDeclineReason({ code: 'authentication_required' })).toBe('authentication_required');
    expect(formatDeclineReason({ message: 'Your card was declined.' })).toBe('Your card was declined.');
    expect(formatDeclineReason({}, {})).toBeNull();
  });

  it('reports a bare outcome type when Stripe gives no reason text', () => {
    expect(formatDeclineReason({}, { type: 'blocked' })).toBe('blocked');
  });
});

describe('channelEmbeds — sales', () => {
  it('salesBookingConfirmed includes customer + commission', () => {
    const r = salesBookingConfirmed({
      id: 'b1',
      bookingNumber: 'BK-001',
      grossAmount: 250,
      platformCommission: 37.5,
      currency: 'USD',
      source: 'TRAVIO',
      tour: { title: 'Serengeti Safari' },
      customer: { name: 'Jane Doe' },
      paidAt: '2026-09-01T10:00:00Z',
    });
    expect(r.content).toContain('BK-001');
    expect(r.opts.title).toBe('New Booking Confirmed');
    expect(r.opts.color).toBe(0x00c853);
    const names = r.opts.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Customer', 'Commission']));
    expect(r.opts.fields.find((f) => f.name === 'Customer').value).toContain('Jane Doe');
    expect(r.opts.fields.find((f) => f.name === 'Commission').value).toContain('37.50');
    expect(r.opts.cooldownKey).toBe('b1');
  });

  it('salesBookingCancelled includes reason', () => {
    const r = salesBookingCancelled({ bookingNumber: 'BK-002', tour: 'X', amount: 100, currency: 'USD', reason: 'Customer request' });
    expect(r.opts.color).toBe(0xff4444);
    expect(r.opts.fields.find((f) => f.name === 'Reason').value).toContain('Customer request');
  });

  it('salesPaymentFailed / salesRefundIssued render amounts', () => {
    const f = salesPaymentFailed({ amount: 50, currency: 'usd', paymentIntentId: 'pi_1' });
    expect(f.opts.fields.find((x) => x.name === 'Amount').value).toContain('50.00');
    const rf = salesRefundIssued({ amount: 20, currency: 'USD', chargeId: 'ch_1' });
    expect(rf.opts.fields.find((x) => x.name === 'Amount Refunded').value).toContain('20.00');
  });
});

describe('channelEmbeds — verification', () => {
  it('verificationSupplierApplication has applicant + dashboard link', () => {
    const r = verificationSupplierApplication({ user: { name: 'A', email: 'a@b.c' }, supplierId: 's1', supplierType: 'TOUR_COMPANY' });
    expect(r.opts.title).toBe('New Supplier Application');
    expect(r.opts.color).toBe(0x3498db);
    expect(r.opts.fields.find((f) => f.name === 'Type').value).toBe('TOUR_COMPANY');
    expect(r.opts.cooldownKey).toBe('s1');
  });

  it('verificationSupplierApplication flags an auto-approved supplier', () => {
    const r = verificationSupplierApplication({
      user: { name: 'A', email: 'a@b.c' },
      supplierId: 's1',
      supplierType: 'TOUR_COMPANY',
      autoApproved: true,
    });
    expect(r.content).toContain('auto-approved');
    expect(r.opts.title).toBe('New Supplier Joined (auto-approved)');
    expect(r.opts.color).toBe(0x00c853);
    expect(r.opts.fields.find((f) => f.name === 'Status').value).toContain('ACTIVE');
  });

  it('verificationStatusChange shows from → to', () => {
    const r = verificationStatusChange({ supplierName: 'Acme', from: 'APPROVED', to: 'ACTIVE', supplierId: 's1' });
    expect(r.content).toContain('APPROVED');
    expect(r.content).toContain('ACTIVE');
    expect(r.opts.fields.find((f) => f.name === 'From').value).toBe('APPROVED');
    expect(r.opts.fields.find((f) => f.name === 'To').value).toBe('ACTIVE');
  });

  it('verificationTourSubmitted has tour title, review buttons and no Changes field', () => {
    const r = verificationTourSubmitted({ tourTitle: 'Beach Day', tourId: 't1', supplierName: 'Acme' });
    expect(r.content).toContain('Beach Day');
    expect(r.opts.title).toBe('Tour Submitted for Review');
    expect(r.opts.fields.find((f) => f.name === 'Changes')).toBeUndefined();
    const ids = r.opts.components[0].components.map((c) => c.custom_id);
    expect(ids).toEqual(['tour:approve:t1', 'tour:reject:t1']);
  });

  it('verificationTourUpdateSubmitted renders the actual diff (old → new)', () => {
    const r = verificationTourUpdateSubmitted({
      tourTitle: 'Beach Day',
      tourId: 't1',
      supplierName: 'Acme',
      isResubmission: true,
      changes: [
        { path: 'bookingAndTickets.cutoffMinutes', kind: 'changed', before: 24, after: 48 },
        { path: 'photos', kind: 'changed', before: '1 removed', after: '1 added' },
      ],
    });
    const changes = r.opts.fields.find((f) => f.name === 'Changes').value;
    expect(changes).toContain('Booking & tickets › cutoffMinutes');
    expect(changes).toContain('24');
    expect(changes).toContain('48');
    expect(changes).toContain('→');
    expect(changes).toContain('1 added');
    const ids = r.opts.components[0].components.map((c) => c.custom_id);
    expect(ids).toEqual(['tour:approve:t1', 'tour:reject:t1']);
  });

  it('verificationTourUpdateSubmitted falls back to the summary without a diff', () => {
    const r = verificationTourUpdateSubmitted({
      tourTitle: 'T',
      tourId: 't1',
      isResubmission: true,
      changesSummary: { count: 2, sections: [{ section: 'photos' }] },
    });
    expect(r.opts.fields.find((f) => f.name === 'Changes').value).toContain('2 changes across');
  });

  it('verificationTourUpdateSubmitted caps long diffs with "…and N more"', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `productContent.locations[${i}].name`, kind: 'changed', before: 'a', after: 'b' }));
    const r = verificationTourUpdateSubmitted({ tourTitle: 'T', tourId: 't1', isResubmission: true, changes: many });
    expect(r.opts.fields.find((f) => f.name === 'Changes').value).toContain('…and 8 more');
  });
});

describe('channelEmbeds — approvals', () => {
  it('approvalPayoutRequest has approve/reject buttons', () => {
    const r = approvalPayoutRequest({ requestNumber: 'PR-1', amount: 500, currency: 'USD', bookingCount: 3, requestId: 'pr1' });
    expect(r.opts.title).toBe('Payout Approval Needed');
    const ids = r.opts.components[0].components.map((c) => c.custom_id);
    expect(ids).toEqual(['pv:approve:pr1', 'pv:reject:pr1']);
    expect(r.opts.fields.find((f) => f.name === 'Amount').value).toContain('500.00');
  });

  it('approvalPayoutResult colors by action', () => {
    expect(approvalPayoutResult({ requestNumber: 'PR-1', amount: 100, currency: 'USD', action: 'approved' }).opts.color).toBe(0x00c853);
    expect(approvalPayoutResult({ requestNumber: 'PR-1', amount: 100, currency: 'USD', action: 'rejected' }).opts.color).toBe(0xff4444);
  });

  it('approvalRefundRequest has approve/deny buttons', () => {
    const r = approvalRefundRequest({ disputeNumber: 'D-1', tour: 'T', amount: 100, currency: 'USD', reason: 'CANCELLATION', bookingNumber: 'BK-9', disputeId: 'd1' });
    const ids = r.opts.components[0].components.map((c) => c.custom_id);
    expect(ids).toEqual(['dsp:approve:d1', 'dsp:deny:d1']);
  });

  it('approvalRefundResult colors by outcome', () => {
    expect(approvalRefundResult({ disputeNumber: 'D-1', outcome: 'CUSTOMER', amount: 100, currency: 'USD' }).opts.color).toBe(0x00c853);
    expect(approvalRefundResult({ disputeNumber: 'D-1', outcome: 'SUPPLIER', amount: 100, currency: 'USD' }).opts.color).toBe(0xff4444);
  });
});

describe('channelEmbeds — helpers', () => {
  it('money formats with 2 decimals', () => {
    expect(money(12.5, 'USD')).toBe('USD 12.50');
    expect(money(0, 'EUR')).toBe('EUR 0.00');
  });
});
