const { endOfUtcDay } = require('../../src/core/services/offerDates');
const AppError = require('../../src/core/services/appError');

describe('endOfUtcDay', () => {
  it('moves a date-only string to the last millisecond of that UTC day', () => {
    expect(endOfUtcDay('2026-09-30').toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });

  it('moves a midnight timestamp forward so the chosen day is inclusive', () => {
    expect(endOfUtcDay('2026-09-30T00:00:00.000Z').toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });

  it('moves a mid-day timestamp to the end of the same day', () => {
    expect(endOfUtcDay('2026-09-30T13:45:12.000Z').toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });

  it('accepts Date instances and is idempotent on an already-normalised value', () => {
    const once = endOfUtcDay(new Date('2026-09-30T00:00:00Z'));
    expect(once.toISOString()).toBe('2026-09-30T23:59:59.999Z');
    expect(endOfUtcDay(once).getTime()).toBe(once.getTime());
  });

  it('resolves the calendar day in UTC, never the server timezone', () => {
    // 01:00Z is still 30/09 in UTC even though it may already be 30/09 in a
    // positive-offset zone and 29/09 in a negative one.
    expect(endOfUtcDay('2026-09-30T01:00:00Z').toISOString()).toBe('2026-09-30T23:59:59.999Z');
    expect(endOfUtcDay('2026-09-30T23:30:00Z').toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });

  it('returns null for empty input (open-ended offers)', () => {
    expect(endOfUtcDay(null)).toBeNull();
    expect(endOfUtcDay(undefined)).toBeNull();
    expect(endOfUtcDay('')).toBeNull();
  });

  it('rejects an unparseable date with a 400 instead of storing Invalid Date', () => {
    expect(() => endOfUtcDay('not-a-date')).toThrow(AppError);
    try {
      endOfUtcDay('not-a-date');
      throw new Error('expected endOfUtcDay to throw');
    } catch (err) {
      expect(err.statusCode).toBe(400);
    }
  });

  // The nightly `expire-special-offers` job sweeps `endDate <= now`. Because a
  // stored end date is now the LAST millisecond of its day, an offer that ends
  // today cannot be swept before the day is over — and one that ended
  // yesterday is swept the moment midnight passes.
  describe('interaction with the nightly expire query (endDate <= now)', () => {
    it('keeps an offer that ends today out of the sweep', () => {
      expect(endOfUtcDay(new Date()).getTime() <= Date.now()).toBe(false);
    });

    it('sweeps an offer once its end day has fully passed', () => {
      expect(endOfUtcDay(Date.now() - 24 * 60 * 60 * 1000).getTime() <= Date.now()).toBe(true);
    });
  });
});
