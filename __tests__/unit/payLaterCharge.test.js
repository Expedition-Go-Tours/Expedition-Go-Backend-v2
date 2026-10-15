/**
 * payLaterCharge — the single source of truth for when a reserve-now-pay-later
 * booking is charged (travelDate − PAY_LATER_CHARGE_BEFORE_HOURS, default 24h).
 *
 * Every consumer (sweep window, reminders, emails, admin alerts) derives the
 * moment from here, so this file also pins the contract those consumers rely on.
 */

const {
  DEFAULT_CHARGE_BEFORE_HOURS,
  chargeBeforeHours,
  payLaterChargeAt,
  chargeWindowEnd,
} = require('../../src/core/services/payLaterCharge');

const H = 60 * 60 * 1000;

describe('payLaterCharge', () => {
  beforeEach(() => {
    delete process.env.PAY_LATER_CHARGE_BEFORE_HOURS;
  });

  it('defaults to charging 24h before the activity', () => {
    expect(DEFAULT_CHARGE_BEFORE_HOURS).toBe(24);
    expect(chargeBeforeHours()).toBe(24);
  });

  it('honors the PAY_LATER_CHARGE_BEFORE_HOURS env override', () => {
    process.env.PAY_LATER_CHARGE_BEFORE_HOURS = '6';
    expect(chargeBeforeHours()).toBe(6);
    expect(payLaterChargeAt(new Date('2026-07-01T10:00:00Z')).toISOString()).toBe(
      new Date(Date.parse('2026-07-01T10:00:00Z') - 6 * H).toISOString()
    );
  });

  it('ignores non-positive or non-numeric overrides', () => {
    for (const bad of ['0', '-5', 'nonsense', '']) {
      process.env.PAY_LATER_CHARGE_BEFORE_HOURS = bad;
      expect(chargeBeforeHours()).toBe(24);
    }
  });

  it('returns the travel date minus 24h', () => {
    const travel = new Date('2026-07-01T10:00:00Z');
    expect(payLaterChargeAt(travel).toISOString()).toBe('2026-06-30T10:00:00.000Z');
  });

  it('accepts strings and numbers as well as Date objects', () => {
    const expected = new Date('2026-06-30T10:00:00.000Z').getTime();
    expect(payLaterChargeAt('2026-07-01T10:00:00Z').getTime()).toBe(expected);
    expect(payLaterChargeAt(Date.parse('2026-07-01T10:00:00Z')).getTime()).toBe(expected);
  });

  it('returns null for a missing or invalid travel date', () => {
    expect(payLaterChargeAt(null)).toBeNull();
    expect(payLaterChargeAt(undefined)).toBeNull();
    expect(payLaterChargeAt('not-a-date')).toBeNull();
  });

  it('chargeWindowEnd is the query form of "charge moment <= now"', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    expect(chargeWindowEnd(now).toISOString()).toBe('2026-07-02T00:00:00.000Z');
    // A booking on the window edge charges exactly at `now`…
    expect(payLaterChargeAt(chargeWindowEnd(now)).getTime()).toBe(now.getTime());
    // …and one a millisecond later is not yet due.
    const justOutside = new Date(chargeWindowEnd(now).getTime() + 1);
    expect(payLaterChargeAt(justOutside).getTime()).toBeGreaterThan(now.getTime());
  });
});
