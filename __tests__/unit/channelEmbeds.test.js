const {
  salesBookingConfirmed,
  salesBookingCancelled,
  salesPaymentFailed,
  salesRefundIssued,
  verificationSupplierApplication,
  verificationDocumentEvent,
  verificationStatusChange,
  verificationTourSubmitted,
  approvalPayoutRequest,
  approvalPayoutResult,
  approvalRefundRequest,
  approvalRefundResult,
  money,
} = require('../../utils/channelEmbeds');

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

  it('verificationStatusChange shows from → to', () => {
    const r = verificationStatusChange({ supplierName: 'Acme', from: 'APPROVED', to: 'ACTIVE', supplierId: 's1' });
    expect(r.content).toContain('APPROVED');
    expect(r.content).toContain('ACTIVE');
    expect(r.opts.fields.find((f) => f.name === 'From').value).toBe('APPROVED');
    expect(r.opts.fields.find((f) => f.name === 'To').value).toBe('ACTIVE');
  });

  it('verificationTourSubmitted has tour title', () => {
    const r = verificationTourSubmitted({ tourTitle: 'Beach Day', tourId: 't1' });
    expect(r.content).toContain('Beach Day');
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
