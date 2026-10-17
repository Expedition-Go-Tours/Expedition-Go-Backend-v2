/**
 * The backfill's idempotency key must live in its own namespace.
 *
 * Regression pinned here: the key used to be `invoiceRunKey(...)`, identical to
 * the scheduler's. On a window where the scheduler had ALREADY raised an
 * invoice (say Oct 1–15), the unique index then swallowed every PAID booking
 * that belonged to the backfill — and because those bookings are PAID rather
 * than ELIGIBLE, no sweep would ever retry them. Nine bookings and $835.85 of
 * history were one key away from being lost silently.
 */
const { backfillRunKey } = require('../backfill-historical-invoices');
const { invoiceRunKey } = require('../../src/core/services/invoiceService');

const window = {
  start: new Date(Date.UTC(2026, 9, 1)),
  end: new Date(Date.UTC(2026, 9, 15)),
  label: 'Oct 1–15',
};

describe('backfillRunKey', () => {
  it('never shares a key with the scheduler', () => {
    // The whole point: a backfill on an already-scheduled window must still be
    // insertable.
    expect(backfillRunKey('sup-1', window, 'USD')).not.toBe(
      invoiceRunKey('sup-1', window, 'USD')
    );
    expect(backfillRunKey('sup-1', window, 'USD')).toMatch(/^backfill:/);
  });

  it('is idempotent for the same supplier + window + currency', () => {
    // Re-running must collide with ITSELF on the unique index, not create a
    // second invoice for the same history.
    expect(backfillRunKey('sup-1', window, 'USD')).toBe(
      backfillRunKey('sup-1', { ...window }, 'USD')
    );
  });

  it('separates suppliers, windows and currencies from each other', () => {
    const nextWindow = { ...window, start: new Date(Date.UTC(2026, 9, 16)) };
    const keys = [
      backfillRunKey('sup-1', window, 'USD'),
      backfillRunKey('sup-2', window, 'USD'),
      backfillRunKey('sup-1', nextWindow, 'USD'),
      backfillRunKey('sup-1', window, 'GHS'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('defaults a missing currency to USD, matching the scheduler', () => {
    expect(backfillRunKey('sup-1', window, undefined)).toContain(':USD');
  });
});
