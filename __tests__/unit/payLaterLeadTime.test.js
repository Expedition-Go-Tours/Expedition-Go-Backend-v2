/**
 * Pay-later minimum lead time: a reserve-now-pay-later booking must be at least
 * PAY_LATER_MIN_ADVANCE_HOURS (default 48h) before the activity so the pay-later
 * sweep always has its charge window. Pay-now bookings are never restricted.
 */

const { assertPayLaterLeadTime, payLaterMinAdvanceHours, DEFAULT_MIN_ADVANCE_HOURS } = require('../../utils/payLaterLeadTime');
const AppError = require('../../utils/appError');

const H = 1000 * 60 * 60;

function expectReject(opts) {
  expect(() => assertPayLaterLeadTime(opts)).toThrow(AppError);
}

describe('payLaterLeadTime', () => {
  beforeEach(() => {
    delete process.env.PAY_LATER_MIN_ADVANCE_HOURS;
  });

  it('defaults to 48 hours', () => {
    expect(DEFAULT_MIN_ADVANCE_HOURS).toBe(48);
    expect(payLaterMinAdvanceHours()).toBe(48);
  });

  it('rejects reserve-now-pay-later inside the 48h window', () => {
    expectReject({ paymentTiming: 'later', startAt: new Date(Date.now() + 47.9 * H) });
  });

  it('allows reserve-now-pay-later exactly at the 48h boundary and beyond', () => {
    expect(() => assertPayLaterLeadTime({ paymentTiming: 'later', startAt: new Date(Date.now() + 48 * H + 5000) })).not.toThrow();
    expect(() => assertPayLaterLeadTime({ paymentTiming: 'later', startAt: new Date(Date.now() + 10 * 24 * H) })).not.toThrow();
  });

  it('never restricts pay-now bookings', () => {
    expect(() => assertPayLaterLeadTime({ paymentTiming: 'now', startAt: new Date(Date.now() + 2 * H) })).not.toThrow();
    expect(() => assertPayLaterLeadTime({ paymentTiming: undefined, startAt: new Date(Date.now() + 2 * H) })).not.toThrow();
  });

  it('no-ops when the start time is unavailable or invalid', () => {
    expect(() => assertPayLaterLeadTime({ paymentTiming: 'later', startAt: null })).not.toThrow();
    expect(() => assertPayLaterLeadTime({ paymentTiming: 'later' })).not.toThrow();
    expect(() => assertPayLaterLeadTime({ paymentTiming: 'later', startAt: 'not-a-date' })).not.toThrow();
  });

  it('honors the PAY_LATER_MIN_ADVANCE_HOURS env override', () => {
    process.env.PAY_LATER_MIN_ADVANCE_HOURS = '12';
    expect(payLaterMinAdvanceHours()).toBe(12);
    // 12h out is fine when the floor is 12…
    expect(() => assertPayLaterLeadTime({ paymentTiming: 'later', startAt: new Date(Date.now() + 13 * H) })).not.toThrow();
    // …but still rejected inside the tuned window.
    expectReject({ paymentTiming: 'later', startAt: new Date(Date.now() + 11.9 * H) });
  });

  it('surfaces a clear message naming the threshold', () => {
    try {
      assertPayLaterLeadTime({ paymentTiming: 'later', startAt: new Date(Date.now() + 30 * H) });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err instanceof AppError).toBe(true);
      expect(err.message).toMatch(/at least 48 hours before the activity/);
    }
  });
});
