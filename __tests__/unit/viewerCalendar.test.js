const { viewerCalendar, MAX_OFFSET_MINUTES } = require('../../src/core/services/viewerCalendar');

// 2026-11-04T00:35Z — just past UTC midnight, which is exactly when the
// server's calendar used to run ahead of a viewer west of UTC.
const NOW = Date.parse('2026-11-04T00:35:00.000Z');

describe('viewerCalendar', () => {
  it('uses the server calendar for a UTC viewer', () => {
    const cal = viewerCalendar(0, NOW);
    expect(cal.todayStart.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(cal.monthStart.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(cal.weekStart.toISOString()).toBe('2026-11-01T00:00:00.000Z'); // Sunday
    expect(cal.yearStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(cal.shiftMinutes).toBe(0);
  });

  it('keeps a UTC-5 viewer on their own calendar day', () => {
    // 00:35Z on the 4th is 19:35 on the 3rd in New York: their "today" is the 3rd.
    const cal = viewerCalendar(300, NOW);
    expect(cal.todayStart.toISOString()).toBe('2026-11-03T05:00:00.000Z');
    expect(cal.monthStart.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(cal.weekStart.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    // SQL shifts a stored instant by this to read the viewer's wall clock.
    expect(cal.shiftMinutes).toBe(-300);
  });

  it('handles a viewer east of UTC', () => {
    // 00:35Z is already 02:35 on the 4th in UTC+2.
    const cal = viewerCalendar(-120, NOW);
    expect(cal.todayStart.toISOString()).toBe('2026-11-03T22:00:00.000Z');
    expect(cal.monthStart.toISOString()).toBe('2026-10-31T22:00:00.000Z');
    expect(cal.shiftMinutes).toBe(120);
  });

  it('rolls month and year back at the viewer boundary', () => {
    // 2027-01-01T02:00Z is still 2026-12-31 in New York.
    const cal = viewerCalendar(300, Date.parse('2027-01-01T02:00:00.000Z'));
    expect(cal.todayStart.toISOString()).toBe('2026-12-31T05:00:00.000Z');
    expect(cal.monthStart.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(cal.previousMonthStart.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(cal.yearStart.toISOString()).toBe('2026-01-01T05:00:00.000Z');
  });

  it('produces contiguous quarter windows', () => {
    const cal = viewerCalendar(0, NOW);
    expect(cal.quarterStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(cal.previousQuarterStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(cal.quarterBeforeStart.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('clamps absurd offsets and falls back to the server calendar', () => {
    expect(viewerCalendar(20_000, NOW).tz).toBe(MAX_OFFSET_MINUTES);
    expect(viewerCalendar(-20_000, NOW).tz).toBe(-MAX_OFFSET_MINUTES);
    expect(viewerCalendar(undefined, NOW).tz).toBe(0);
    expect(viewerCalendar(Number.NaN, NOW).tz).toBe(0);
  });
});
