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

// 2026-09-07 is a Monday; 2026-09-27 is the Sunday the schedule starts on.
const parsedWindowed = {
  availability: { daysOfWeek: ['Monday'], timezone: 'UTC' },
  pricingSchedules: {
    currency: 'USD',
    schedules: [
      {
        startDate: '2026-09-27',
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

const mondayBefore = new Date('2026-09-07T00:00:00.000Z'); // before window
const mondayInside = new Date('2026-09-28T00:00:00.000Z'); // inside window
const tuesday = new Date('2026-09-08T00:00:00.000Z'); // not an operating day

describe('pricing/availability parity', () => {
  it('blocks operating weekdays that fall before the pricing window', () => {
    expect(isOperatingDay(parsedWindowed, mondayBefore)).toBe(false);
    expect(hasPricingScheduleForDate(parsedWindowed, mondayBefore)).toBe(false);
    expect(pricingScheduleIndexesFor(parsedWindowed, '2026-09-07', 'monday', null)).toEqual([]);
  });

  it('allows operating weekdays inside the pricing window', () => {
    expect(isOperatingDay(parsedWindowed, mondayInside)).toBe(true);
    expect(pricingScheduleIndexesFor(parsedWindowed, '2026-09-28', 'monday', null)).toEqual([0]);
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
    expect(pricingScheduleIndexesFor(scheduleDaysMonWed, '2026-09-07', 'monday', null)).toEqual([0]);
    expect(pricingScheduleIndexesFor(scheduleDaysMonWed, '2026-09-08', 'tuesday', null)).toEqual([]);
    expect(isOperatingDay(scheduleDaysMonWed, new Date('2026-09-08T00:00:00.000Z'))).toBe(false);
  });

  it('does not gate when there is no pricing schedule data', () => {
    const noPricing = { availability: { daysOfWeek: ['Monday'], timezone: 'UTC' } };
    expect(isOperatingDay(noPricing, mondayBefore)).toBe(true);
  });
});
