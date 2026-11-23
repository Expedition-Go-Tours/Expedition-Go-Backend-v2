/**
 * The period model behind the supplier Performance pages.
 *
 * The interesting cases are the month boundaries: a chart that starts a day
 * early, compares against the wrong month, or counts 31 bars in February is a
 * quiet lie on a revenue page.
 */

const {
  resolveAnalyticsPeriod,
  makeBuckets,
  accumulateBookings,
  daysInMonth,
} = require('../../src/core/services/analyticsPeriod');

const NOV_23 = new Date('2026-11-23T09:15:00.000Z');

function labels(buckets) {
  return buckets.map((b) => b.label);
}

describe('presets', () => {
  it('resolves 30 days as 30 daily buckets ending now', () => {
    const period = resolveAnalyticsPeriod('30d', NOV_23);

    expect(period.key).toBe('30d');
    expect(period.granularity).toBe('day');
    expect(period.end.getTime()).toBe(NOV_23.getTime());
    expect(makeBuckets(period.start, period.end, period.granularity)).toHaveLength(30);
  });

  it('resolves 90 days as weekly buckets', () => {
    const period = resolveAnalyticsPeriod('90d', NOV_23);

    expect(period.granularity).toBe('week');
    const buckets = makeBuckets(period.start, period.end, period.granularity);
    expect(buckets.length).toBeGreaterThanOrEqual(13);
    expect(buckets.length).toBeLessThanOrEqual(14);
  });

  it('resolves 12 months as calendar months including the current one', () => {
    const period = resolveAnalyticsPeriod('12m', NOV_23);
    const buckets = makeBuckets(period.start, period.end, period.granularity);

    expect(period.granularity).toBe('month');
    expect(buckets).toHaveLength(12);
    expect(buckets[0].start.toISOString().slice(0, 7)).toBe('2025-12');
    expect(buckets[11].start.toISOString().slice(0, 7)).toBe('2026-11');
  });

  it('falls back to 30 days for an unknown preset', () => {
    expect(resolveAnalyticsPeriod('forever', NOV_23).key).toBe('30d');
    expect(resolveAnalyticsPeriod(undefined, NOV_23).key).toBe('30d');
  });
});

describe('calendar months', () => {
  it('spans the first of the month to the first of the next, exclusive', () => {
    const period = resolveAnalyticsPeriod('2026-11', NOV_23);

    expect(period.key).toBe('2026-11');
    expect(period.isMonth).toBe(true);
    expect(period.granularity).toBe('day');
    expect(period.start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(period.label).toBe('November 2026');
  });

  it('compares against the whole previous calendar month', () => {
    const period = resolveAnalyticsPeriod('2026-11', NOV_23);

    expect(period.previousStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(period.previousEnd.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(period.previousLabel).toBe('October 2026');
  });

  it('rolls the year over for January', () => {
    const period = resolveAnalyticsPeriod('2026-01', new Date('2026-01-10T00:00:00Z'));

    expect(period.previousStart.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(period.previousLabel).toBe('December 2025');
  });

  it('counts a bucket per day of the month, whatever the length', () => {
    const cases = [
      ['2026-11', NOV_23, 30],
      ['2026-02', NOV_23, 28],
      ['2024-02', NOV_23, 29],
      ['2026-01', NOV_23, 31],
    ];

    for (const [key, now, expected] of cases) {
      const period = resolveAnalyticsPeriod(key, now);
      const buckets = makeBuckets(period.start, period.end, period.granularity);
      expect([key, buckets.length]).toEqual([key, expected]);
      expect([key, period.previousEnd.getTime()]).toEqual([key, period.start.getTime()]);
    }
  });

  it('labels February correctly in the chart', () => {
    const period = resolveAnalyticsPeriod('2026-02', NOV_23);
    const buckets = makeBuckets(period.start, period.end, period.granularity);

    expect(buckets[0].label).toBe('1 Feb');
    expect(buckets[buckets.length - 1].label).toBe('28 Feb');
  });

  it('rejects a future month, an over-old month and an impossible month', () => {
    expect(resolveAnalyticsPeriod('2026-12', NOV_23)).toBeNull();
    expect(resolveAnalyticsPeriod('2020-01', NOV_23)).toBeNull();
    expect(resolveAnalyticsPeriod('2026-13', NOV_23)).toBeNull();
    expect(resolveAnalyticsPeriod('2026-00', NOV_23)).toBeNull();
  });

  it('accepts the current month even on its first day', () => {
    const firstDay = new Date('2026-11-01T00:00:30.000Z');
    expect(resolveAnalyticsPeriod('2026-11', firstDay).key).toBe('2026-11');
  });

  it('does not depend on the process timezone for its boundaries', () => {
    // Boundaries come from Date.UTC, so the ISO string is always midnight Z.
    for (const key of ['2026-03', '2026-11']) {
      const period = resolveAnalyticsPeriod(key, NOV_23);
      expect(period.start.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(period.end.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });
});

describe('daysInMonth', () => {
  it('knows leap years', () => {
    expect(daysInMonth(2024, 1)).toBe(29);
    expect(daysInMonth(2023, 1)).toBe(28);
    expect(daysInMonth(2026, 10)).toBe(30);
    expect(daysInMonth(2026, 11)).toBe(31);
  });
});

describe('accumulateBookings', () => {
  it('puts paid revenue and created bookings into the right buckets', () => {
    const period = resolveAnalyticsPeriod('2026-11', NOV_23);
    const buckets = makeBuckets(period.start, period.end, period.granularity);

    accumulateBookings(buckets, [
      {
        createdAt: '2026-11-03T10:00:00.000Z',
        paidAt: '2026-11-05T00:19:00.000Z',
        paymentStatus: 'SUCCEEDED',
        grossAmount: '320.00',
      },
      {
        createdAt: '2026-11-20T12:00:00.000Z',
        paidAt: null,
        paymentStatus: 'PENDING',
        grossAmount: '210.00',
      },
    ]);

    expect(buckets[2].bookings).toBe(1); // 3 Nov
    expect(buckets[4].revenue).toBe(320); // 5 Nov
    expect(buckets[19].bookings).toBe(1); // 20 Nov
    expect(buckets.reduce((sum, b) => sum + b.revenue, 0)).toBe(320);
    expect(buckets.reduce((sum, b) => sum + b.bookings, 0)).toBe(2);
  });

  it('ignores money dated outside the window', () => {
    const period = resolveAnalyticsPeriod('2026-11', NOV_23);
    const buckets = makeBuckets(period.start, period.end, period.granularity);

    accumulateBookings(buckets, [
      {
        createdAt: '2026-10-31T23:59:00.000Z',
        paidAt: '2026-10-31T23:59:00.000Z',
        paymentStatus: 'SUCCEEDED',
        grossAmount: '99.00',
      },
    ]);

    expect(labels(buckets)).not.toContain('31 Oct');
    expect(buckets.every((b) => b.revenue === 0 && b.bookings === 0)).toBe(true);
  });
});
