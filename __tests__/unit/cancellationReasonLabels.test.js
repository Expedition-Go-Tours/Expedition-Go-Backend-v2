/**
 * One cancellation, one readable line.
 *
 * Every surface — the supplier's records table, the booking drawer, the
 * customer and supplier emails, the admin panel — used to print
 * `cancellationReason` straight through. For customer cancellations that field
 * holds a storefront code (`HEALTH_MEDICAL`), while the taxonomy code on the
 * same row is the generic `CUSTOMER_REQUESTED_CANCEL`, so the specific choice
 * was stored and never shown.
 */
const {
  displayCancellationReason,
  humanizeReasonCode,
  CUSTOMER_REASONS,
} = require('../../src/core/services/cancellationReasons');

describe('displayCancellationReason', () => {
  it('shows the customer’s own reason, not the generic category', () => {
    expect(displayCancellationReason({
      cancellationOrigin: 'CUSTOMER',
      cancellationCode: 'CUSTOMER_REQUESTED_CANCEL',
      cancellationReason: 'HEALTH_MEDICAL',
    })).toBe('Health or medical reasons');
  });

  it('names every option the storefront offers', () => {
    for (const reason of CUSTOMER_REASONS) {
      expect(displayCancellationReason({
        cancellationOrigin: 'CUSTOMER',
        cancellationReason: reason.code,
      })).toBe(reason.label);
    }
  });

  it('humanises a code nobody has mapped yet instead of printing underscores', () => {
    expect(displayCancellationReason({
      cancellationOrigin: 'CUSTOMER',
      cancellationReason: 'FOUND_SOMETHING_NEW',
    })).toBe('Found something new');
  });

  it('leaves prose alone', () => {
    expect(displayCancellationReason({
      cancellationOrigin: 'SYSTEM',
      cancellationReason: 'Payment not collected before the activity date',
    })).toBe('Payment not collected before the activity date');
  });

  it('uses the taxonomy label for a supplier cancellation', () => {
    expect(displayCancellationReason({
      cancellationOrigin: 'SUPPLIER',
      cancellationCode: 'WEATHER',
      cancellationReason: null,
    })).toBe('Adverse weather conditions');
  });

  it('returns null when nothing was recorded', () => {
    expect(displayCancellationReason({})).toBeNull();
    expect(displayCancellationReason()).toBeNull();
  });
});

describe('humanizeReasonCode', () => {
  it('turns an identifier into a sentence fragment', () => {
    expect(humanizeReasonCode('VEHICLE_BREAKDOWN')).toBe('Vehicle breakdown');
  });

  it('keeps an unknown single word readable', () => {
    expect(humanizeReasonCode('OTHER')).toBe('Other');
  });
});
