/**
 * Regression: a date the availability calendar advertises must always be
 * priceable (and vice versa). The Mole-style bug — operating days shown as
 * AVAILABLE before the pricing schedule's startDate — is blocked at the
 * availability layer by the same single rule set the price engine uses.
 */
const {
  isOperatingDay,
  computeDayEntry,
  pricingScheduleIndexesFor,
  hasPricingScheduleForDate,
} = require('../../utils/availabilityCore');

// Dates are anchored to "now" rather than hardcoded: a fixed Monday that is in
// the future when the suite is written becomes a PAST date later, and
// computeDayEntry then correctly reports PAST instead of BLOCKED — failing the
// suite for the wrong reason.
const DAY_MS = 24 * 60 * 60 * 1000;

function utcMidnight(offsetDays = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + offsetDays * DAY_MS);
}

/** Next occurrence of `weekday` (0=Sun..6=Sat) strictly after `from`. */
function nextWeekday(from, weekday) {
  const delta = ((weekday - from.getUTCDay() + 7) % 7) || 7;
  return new Date(from.getTime() + delta * DAY_MS);
}

const isoDay = (d) => d.toISOString().slice(0, 10);

const mondayBefore = nextWeekday(utcMidnight(), 1); // next Monday — before the pricing window
const mondayInside = new Date(mondayBefore.getTime() + 7 * DAY_MS); // Monday inside the window
const windowStartSunday = new Date(mondayInside.getTime() - DAY_MS); // the Sunday the schedule starts on
const tuesday = new Date(mondayBefore.getTime() + DAY_MS); // not an operating day

const parsedWindowed = {
  availability: { daysOfWeek: ['Monday'], timezone: 'UTC' },
  pricingSchedules: {
    currency: 'USD',
    schedules: [
      {
        startDate: isoDay(windowStartSunday),
        endDate: null,
        prices: [{ days: [], times: [], price: 100 }],
      },
    ],
  },
};

// Same weekday template but with an open schedule (no window) — control.
const parsedOpen = {
  availability: { daysOfWeek: ['Monday'], timezone: 'UTC' },
  pricingSchedules: {
    currency: 'USD',
    schedules: [{ prices: [{ days: [], times: [], price: 100 }] }],
  },
};

describe('pricing/availability parity', () => {
  it('blocks operating weekdays that fall before the pricing window', () => {
    expect(isOperatingDay(parsedWindowed, mondayBefore)).toBe(false);
    expect(hasPricingScheduleForDate(parsedWindowed, mondayBefore)).toBe(false);
    expect(pricingScheduleIndexesFor(parsedWindowed, isoDay(mondayBefore), 'monday', null)).toEqual([]);
  });

  it('allows operating weekdays inside the pricing window', () => {
    expect(isOperatingDay(parsedWindowed, mondayInside)).toBe(true);
    expect(pricingScheduleIndexesFor(parsedWindowed, isoDay(mondayInside), 'monday', null)).toEqual([0]);
  });

  it('leaves tours with open schedules untouched', () => {
    expect(isOperatingDay(parsedOpen, mondayBefore)).toBe(true);
    expect(isOperatingDay(parsedOpen, tuesday)).toBe(false); // template days still respected
  });

  it('computeDayEntry marks an out-of-window weekday as BLOCKED', () => {
    const entry = computeDayEntry(parsedWindowed, null, null, mondayBefore, {});
    expect(entry.isOperatingDay).toBe(false);
    expect(entry.status).toBe('BLOCKED');
  });

  it('computeDayEntry keeps an in-window weekday AVAILABLE', () => {
    const entry = computeDayEntry(parsedWindowed, null, null, mondayInside, {});
    expect(entry.isOperatingDay).toBe(true);
    expect(entry.status).toBe('AVAILABLE');
  });

  it('respects schedule weekday restrictions independently of the template', () => {
    const scheduleDaysMonWed = {
      availability: { daysOfWeek: ['Monday', 'Tuesday', 'Wednesday'], timezone: 'UTC' },
      pricingSchedules: {
        currency: 'USD',
        schedules: [{ prices: [{ days: ['Monday', 'Wednesday'], times: [], price: 90 }] }],
      },
    };
    expect(pricingScheduleIndexesFor(scheduleDaysMonWed, isoDay(mondayBefore), 'monday', null)).toEqual([0]);
    expect(pricingScheduleIndexesFor(scheduleDaysMonWed, isoDay(tuesday), 'tuesday', null)).toEqual([]);
    expect(isOperatingDay(scheduleDaysMonWed, tuesday)).toBe(false);
  });

  it('does not gate when there is no pricing schedule data', () => {
    const noPricing = { availability: { daysOfWeek: ['Monday'], timezone: 'UTC' } };
    expect(isOperatingDay(noPricing, mondayBefore)).toBe(true);
  });
});
