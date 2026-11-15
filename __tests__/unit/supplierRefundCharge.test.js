/**
 * The supplier-debit rule shared by both refund paths.
 *
 * These are the numbers that decide whether the platform or the supplier
 * absorbs a refund, so they are tested as pure arithmetic with no DB or Stripe.
 */

const {
  supplierChargeForRefund,
  isPaidOut,
  isSettledPayout,
  PAID_PAYOUT_STATES,
  SETTLED_PAYOUT_STATES,
} = require('../../src/core/services/supplierRefundCharge');

const base = {
  grossAmount: 151.22,
  supplierPayout: 120.98,
  refundAmount: 151.22,
  refundedSoFar: 0,
  payoutStatus: 'ELIGIBLE',
};

describe('supplierChargeForRefund', () => {
  it('charges nothing on a full refund the supplier was never paid for', () => {
    const r = supplierChargeForRefund(base);
    expect(r.isFull).toBe(true);
    expect(r.charge).toBe(0);
    expect(r.newRefunded).toBe(151.22);
  });

  it('recovers the supplier share on a full refund whose payout already left', () => {
    const r = supplierChargeForRefund({ ...base, payoutStatus: 'PAID' });
    expect(r.isFull).toBe(true);
    expect(r.payoutSettled).toBe(true);
    expect(r.payoutPaid).toBe(true);
    expect(r.charge).toBe(120.98);
  });

  it('charges nothing on a full refund of a booking on an unpaid payout document', () => {
    // INVOICED (unpaid invoice) and REQUESTED (unpaid payout request) are
    // committed, not paid. The recovery is detaching the booking from that
    // document in the caller; a charge here would bill the supplier for money
    // they never received.
    for (const payoutStatus of ['INVOICED', 'REQUESTED']) {
      const r = supplierChargeForRefund({ ...base, payoutStatus });
      expect(r.isFull).toBe(true);
      expect(r.payoutSettled).toBe(true);
      expect(r.payoutPaid).toBe(false);
      expect(r.payoutCommitted).toBe(true);
      expect(r.charge).toBe(0);
    }
  });

  it('separates paid from merely committed', () => {
    expect(supplierChargeForRefund({ ...base, payoutStatus: 'PAID' })).toMatchObject({
      payoutPaid: true,
      payoutCommitted: false,
    });
    expect(supplierChargeForRefund({ ...base, payoutStatus: 'INVOICED' })).toMatchObject({
      payoutPaid: false,
      payoutCommitted: true,
    });
    expect(supplierChargeForRefund({ ...base, payoutStatus: 'ELIGIBLE' })).toMatchObject({
      payoutPaid: false,
      payoutCommitted: false,
    });
  });

  it('charges the proportional share on a partial refund', () => {
    const r = supplierChargeForRefund({ ...base, refundAmount: 75.61 });
    expect(r.isFull).toBe(false);
    expect(r.charge).toBe(60.49);
    expect(r.newRefunded).toBe(75.61);
  });

  it('never charges more than the supplier payout', () => {
    const r = supplierChargeForRefund({ ...base, refundAmount: 999, payoutStatus: 'PAID' });
    expect(r.charge).toBe(120.98);
  });

  it('leaves a percentage below the full-refund threshold proportional', () => {
    const r = supplierChargeForRefund({ ...base, refundAmount: 151.21, payoutStatus: 'PAID' });
    expect(r.isFull).toBe(false);
    expect(r.charge).toBeCloseTo(120.97, 1);
  });

  it('caps the cumulative refunded total at the gross amount', () => {
    const r = supplierChargeForRefund({ ...base, refundAmount: 200, refundedSoFar: 10 });
    expect(r.newRefunded).toBe(151.22);
  });

  it('respects money already refunded when judging what is left', () => {
    const r = supplierChargeForRefund({
      ...base,
      refundAmount: 51.22,
      refundedSoFar: 100,
      payoutStatus: 'PAID',
    });
    expect(r.refundable).toBe(51.22);
    // A booking that was already partially refunded stays proportional: the
    // original rule only calls a refund "full" when nothing was returned yet.
    expect(r.isFull).toBe(false);
    expect(r.charge).toBe(40.98);
  });

  it('flags only the settled payout states', () => {
    for (const state of SETTLED_PAYOUT_STATES) expect(isSettledPayout(state)).toBe(true);
    for (const state of ['PENDING', 'ELIGIBLE', 'DISPUTED', 'CANCELLED', undefined, null]) {
      expect(isSettledPayout(state)).toBe(false);
    }
  });

  it('flags only PAID as actually paid out', () => {
    for (const state of PAID_PAYOUT_STATES) expect(isPaidOut(state)).toBe(true);
    for (const state of ['INVOICED', 'REQUESTED', 'PENDING', 'ELIGIBLE', 'DISPUTED', undefined, null]) {
      expect(isPaidOut(state)).toBe(false);
    }
  });

  it('keeps a partial refund proportional even on an unpaid payout document', () => {
    // A partial refund leaves the booking payable, so the supplier still gets
    // their share and the charge claws back the refunded slice. Detaching would
    // wrongly strip the whole booking from the document.
    for (const payoutStatus of ['ELIGIBLE', 'INVOICED', 'REQUESTED', 'PAID']) {
      const r = supplierChargeForRefund({ ...base, refundAmount: 75.61, payoutStatus });
      expect(r.isFull).toBe(false);
      expect(r.charge).toBe(60.49);
    }
  });
});
