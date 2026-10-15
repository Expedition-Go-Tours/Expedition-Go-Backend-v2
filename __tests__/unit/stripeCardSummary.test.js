/**
 * cardSummaryFromIntent — the card-on-file extraction used by both
 * reserve-now-pay-later checkouts and by backfill-payment-method-labels.js.
 *
 * Deliberately exercised against the REAL implementation here rather than a
 * jest.mock of stripeHelpers (which every checkout suite replaces wholesale).
 */
const { cardSummaryFromIntent } = require('../../src/core/services/stripeCardSummary');

describe('cardSummaryFromIntent', () => {
  it('reads brand + last4 off an expanded payment method', () => {
    const intent = { id: 'pi_1', payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242' } } };
    expect(cardSummaryFromIntent(intent)).toEqual({ brand: 'visa', last4: '4242' });
  });

  it('yields nulls when payment_method is still a bare string id', () => {
    // The guard against the expand being dropped: the booking must still save.
    expect(cardSummaryFromIntent({ id: 'pi_1', payment_method: 'pm_1' }))
      .toEqual({ brand: null, last4: null });
  });

  it('yields nulls for a non-card payment method', () => {
    // sepa_debit has no `card` key; the columns are card-only.
    expect(cardSummaryFromIntent({ payment_method: { sepa_debit: { iban: 'DE89…' } } }))
      .toEqual({ brand: null, last4: null });
    expect(cardSummaryFromIntent({ payment_method: { card: null } })).toEqual({ brand: null, last4: null });
  });

  it('yields nulls for a missing intent', () => {
    expect(cardSummaryFromIntent(null)).toEqual({ brand: null, last4: null });
    expect(cardSummaryFromIntent(undefined)).toEqual({ brand: null, last4: null });
    expect(cardSummaryFromIntent({})).toEqual({ brand: null, last4: null });
  });

  it('always returns plain strings for the Prisma columns', () => {
    expect(cardSummaryFromIntent({ payment_method: { card: { brand: 'visa', last4: 4242 } } }))
      .toEqual({ brand: 'visa', last4: '4242' });
  });
});
