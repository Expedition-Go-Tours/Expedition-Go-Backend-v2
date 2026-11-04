/**
 * Calendar boundaries in the viewer's timezone.
 *
 * Admin panels read "today", "this week" and "this month" as their own
 * calendar, but the server's day is UTC — so a US-based operator's KPIs and
 * trend chart rolled over hours before their own midnight, and the chart grew
 * an empty "tomorrow" bucket in the evening.
 *
 * `tzOffsetMinutes` is the viewer's `Date.getTimezoneOffset()` (minutes *behind*
 * UTC: UTC-5 → 300, UTC+2 → -120). Every boundary comes back as a real UTC
 * instant, and `shiftMinutes` is what SQL adds to a stored instant to land on
 * the viewer's wall clock (`shiftMinutes === -tz`).
 */

const MAX_OFFSET_MINUTES = 840; // UTC-14 … UTC+14

function viewerCalendar(tzOffsetMinutes, nowMs = Date.now()) {
  const tz = Number.isFinite(tzOffsetMinutes)
    ? Math.max(-MAX_OFFSET_MINUTES, Math.min(MAX_OFFSET_MINUTES, tzOffsetMinutes))
    : 0;

  // The viewer's wall-clock now, then build boundaries with Date.UTC and add
  // the offset back so each one is a real instant the database can compare to.
  const wallNow = new Date(nowMs - tz * 60000);
  const at = (year, month, day, hour = 0, minute = 0) =>
    new Date(Date.UTC(year, month, day, hour, minute) + tz * 60000);

  const year = wallNow.getUTCFullYear();
  const month = wallNow.getUTCMonth();
  const day = wallNow.getUTCDate();
  const quarterIndex = Math.floor(month / 3);

  return {
    tz,
    // Added to a stored instant to get the viewer's wall clock. Avoids `-0`,
    // which shows up as a distinct value in assertions and parameters.
    shiftMinutes: tz === 0 ? 0 : -tz,
    now: new Date(nowMs),
    todayStart: at(year, month, day),
    weekStart: at(year, month, day - wallNow.getUTCDay()),
    monthStart: at(year, month, 1),
    previousMonthStart: at(year, month - 1, 1),
    monthBeforeStart: at(year, month - 2, 1),
    quarterStart: at(year, quarterIndex * 3, 1),
    previousQuarterStart: at(year, quarterIndex * 3 - 3, 1),
    quarterBeforeStart: at(year, quarterIndex * 3 - 6, 1),
    yearStart: at(year, 0, 1),
  };
}

module.exports = { viewerCalendar, MAX_OFFSET_MINUTES };
