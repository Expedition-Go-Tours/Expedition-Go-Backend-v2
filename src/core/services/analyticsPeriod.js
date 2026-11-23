/**
 * One period model for every supplier performance number.
 *
 * The Performance pages used to mix an all-time total with a month-on-month
 * delta and a 90-day booking count on the same row. Every figure resolves
 * through one [start, end) window plus a previous window, so a card, the chart
 * and the table cannot describe different periods.
 *
 * Two kinds of period are accepted:
 *
 *   - presets: `30d`, `90d`, `12m` — rolling windows ending now;
 *   - calendar months: `YYYY-MM` — e.g. `2026-11` is 1 Nov 00:00 UTC to
 *     1 Dec 00:00 UTC (exclusive), compared with the whole of October.
 *
 * A month is compared with the previous CALENDAR month, not with a
 * same-day-count window: "last month" is how people read the chart, and the
 * equal-length alignment happens at bucket level (see `offset` in the
 * timeseries handler).
 *
 * All boundaries are UTC. The container has no TZ pinned, and a month whose
 * first bar slides by an hour is a bug that only shows up on one deployment.
 */

const DAY_MS = 86_400_000;

const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PRESETS = Object.freeze({
  '30d': { key: '30d', label: 'Last 30 days', previousLabel: 'Previous period', days: 30, granularity: 'day' },
  '90d': { key: '90d', label: 'Last 90 days', previousLabel: 'Previous period', days: 90, granularity: 'week' },
  '12m': { key: '12m', label: 'Last 12 months', previousLabel: 'Previous 12 months', months: 12, granularity: 'month' },
});

/** Month keys the picker may ask for. Old enough for year-on-year reading. */
const MAX_MONTHS_BACK = 36;

const MONTH_VALUE = /^(\d{4})-(\d{2})$/;

function utcMonthStart(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, 1));
}

function monthLabel(date) {
  return `${MONTH_LONG[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(year, monthIndex) {
  return Math.round(
    (Date.UTC(year, monthIndex + 1, 1) - Date.UTC(year, monthIndex, 1)) / DAY_MS,
  );
}

/**
 * Resolve a `YYYY-MM` month.
 *
 * @returns {object|null|undefined} a period for a valid month, `null` when the
 *   value looks like a month but is out of range (callers answer 400), or
 *   `undefined` when the value is not month-shaped at all.
 */
function resolveMonthPeriod(value, now) {
  const match = MONTH_VALUE.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;

  const start = utcMonthStart(year, monthIndex);
  const end = utcMonthStart(year, monthIndex + 1);
  const currentMonthStart = utcMonthStart(now.getUTCFullYear(), now.getUTCMonth());
  const earliest = utcMonthStart(now.getUTCFullYear(), now.getUTCMonth() - MAX_MONTHS_BACK);

  // Future months have no data and would render an empty page with a 200.
  if (start > currentMonthStart) return null;
  if (start < earliest) return null;

  const previousStart = utcMonthStart(year, monthIndex - 1);

  return {
    key: monthKey(start),
    label: monthLabel(start),
    previousLabel: monthLabel(previousStart),
    granularity: 'day',
    isMonth: true,
    days: daysInMonth(year, monthIndex),
    start,
    end,
    previousStart,
    previousEnd: start,
  };
}

function resolvePresetPeriod(value, now) {
  const key = PRESETS[value] ? value : '30d';
  const config = PRESETS[key];

  if (config.months) {
    // Full calendar months: 12 buckets, and the 12 before them as comparison.
    const start = utcMonthStart(now.getUTCFullYear(), now.getUTCMonth() - (config.months - 1));
    const previousStart = utcMonthStart(now.getUTCFullYear(), now.getUTCMonth() - (config.months * 2 - 1));
    return { ...config, start, end: now, previousStart, previousEnd: start };
  }

  // `days` buckets including today, so a "30 day" chart draws 30 bars.
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - (config.days - 1),
  ));
  const length = now.getTime() - start.getTime();
  return {
    ...config,
    start,
    end: now,
    previousStart: new Date(start.getTime() - length),
    previousEnd: start,
  };
}

/**
 * Resolve a period key. Unknown presets fall back to 30 days (the historical
 * behaviour); a malformed month returns null so the caller can answer 400
 * instead of silently showing a different period than the URL asked for.
 *
 * @param {string|undefined} value
 * @param {Date} [now]
 */
function resolveAnalyticsPeriod(value, now = new Date()) {
  if (typeof value === 'string' && value) {
    const month = resolveMonthPeriod(value, now);
    if (month !== undefined) return month;
  }
  return resolvePresetPeriod(value, now);
}

const dayLabel = (date) => `${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}`;

function makeBuckets(start, end, granularity) {
  const buckets = [];

  if (granularity === 'month') {
    let cursor = utcMonthStart(start.getUTCFullYear(), start.getUTCMonth());
    while (cursor <= end) {
      const next = utcMonthStart(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
      buckets.push({
        start: cursor,
        end: next,
        key: monthKey(cursor),
        label: `${MONTH_SHORT[cursor.getUTCMonth()]} ${String(cursor.getUTCFullYear()).slice(-2)}`,
        revenue: 0,
        bookings: 0,
      });
      cursor = next;
    }
    return buckets;
  }

  const step = granularity === 'week' ? 7 * DAY_MS : DAY_MS;
  const first = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  ));

  for (let i = 0; ; i += 1) {
    const from = new Date(first.getTime() + i * step);
    // End is exclusive: a bucket that starts at `end` belongs to the next
    // window, which is how February used to draw a phantom 1 March bar.
    if (from >= end) break;
    buckets.push({
      start: from,
      end: new Date(from.getTime() + step),
      key: from.toISOString().slice(0, 10),
      label: dayLabel(from),
      revenue: 0,
      bookings: 0,
    });
  }
  return buckets;
}

function addToBuckets(buckets, at, field, amount) {
  if (!at) return;
  const time = new Date(at).getTime();
  for (const bucket of buckets) {
    if (time >= bucket.start.getTime() && time < bucket.end.getTime()) {
      bucket[field] += amount;
      return;
    }
  }
}

/** Revenue counts money actually paid; bookings count rows created. */
function accumulateBookings(buckets, bookings) {
  for (const booking of bookings) {
    if (booking.paymentStatus === 'SUCCEEDED' && booking.paidAt) {
      addToBuckets(buckets, booking.paidAt, 'revenue', Number(booking.grossAmount) || 0);
    }
    addToBuckets(buckets, booking.createdAt, 'bookings', 1);
  }
}

module.exports = {
  resolveAnalyticsPeriod,
  makeBuckets,
  accumulateBookings,
  addToBuckets,
  monthLabel,
  monthKey,
  daysInMonth,
  MAX_MONTHS_BACK,
  DAY_MS,
  PRESETS,
};
