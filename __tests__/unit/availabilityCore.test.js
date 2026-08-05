jest.mock('../../utils/getConfig', () =>
  jest.fn(async (key) => {
    if (key === 'availability.limited_ratio') return '0.5';
    if (key === 'availability.full_ratio') return '1';
    return '50';
  })
);

jest.mock('../../utils/prismaClient', () => ({
  tour: { findUnique: jest.fn() },
  tourDateOverride: { findFirst: jest.fn(), findMany: jest.fn() },
  booking: { findMany: jest.fn() },
  $queryRawUnsafe: jest.fn(),
}));

const prisma = require('../../utils/prismaClient');
const core = require('../../utils/availabilityCore');
const { checkTourAvailability } = require('../../utils/tourHelpers');
const { buildAvailabilityCalendar } = require('../../utils/availabilityCalendar');

// 2026-06-15 is a Monday.
const MONDAY = '2026-06-15';
const TUESDAY = '2026-06-16';
const WEDNESDAY = '2026-06-17';

// Fixed "today" for calendar tests — keeps 2026-06-15 in the future so the
// PAST clamp never flips these fixtures regardless of when the suite runs.
const FIXED_TODAY = new Date('2026-06-01');

const perPersonTour = {
  id: 't1',
  status: 'ACTIVE',
  schedulesAndPricing: {
    availability: {
      daysOfWeek: ['Monday', 'Wednesday', 'Friday'],
      timeSlots: ['10:00', '14:00'],
    },
    travelerDetails: { maxParticipants: 10 },
  },
};

const perGroupTour = {
  id: 't2',
  status: 'ACTIVE',
  schedulesAndPricing: {
    availability: { timeSlots: ['10:00'] },
    travelerDetails: { pricingModel: 'perGroup', maxGroupsPerTimeSlot: 3, maxParticipants: 4 },
  },
};

// Inline transaction client for evaluateBookingAvailability.
const makeDb = (opts = {}) => ({
  tourDateOverride: {
    findFirst: jest.fn().mockResolvedValue(opts.override || null),
  },
  $queryRawUnsafe: jest.fn().mockResolvedValue(
    opts.counts || [{ currentBookings: '0', groupCount: '0' }]
  ),
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.tour.findUnique.mockResolvedValue(perPersonTour);
  prisma.tourDateOverride.findFirst.mockResolvedValue(null);
  prisma.$queryRawUnsafe.mockResolvedValue([{ currentBookings: '0', groupCount: '0' }]);
  prisma.tourDateOverride.findMany.mockResolvedValue([]);
  prisma.booking.findMany.mockResolvedValue([]);
});

describe('toUtcDate', () => {
  it('normalizes a date string to UTC midnight', () => {
    const d = core.toUtcDate('2026-06-15');
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 15));
  });

  it('returns null for invalid strings', () => {
    expect(core.toUtcDate('invalid')).toBeNull();
    expect(core.toUtcDate('2026-13-45')).toBeNull();
    expect(core.toUtcDate('')).toBeNull();
    expect(core.toUtcDate(null)).toBeNull();
    expect(core.toUtcDate(undefined)).toBeNull();
  });

  it('normalizes a Date instance', () => {
    const d = core.toUtcDate(new Date('2026-06-15T18:30:00.000Z'));
    expect(d.toISOString().slice(0, 10)).toBe('2026-06-15');
  });
});

describe('travelerCount', () => {
  it('sums adults, children and infants', () => {
    expect(core.travelerCount({ adults: 2, children: 1, infants: 1 })).toBe(4);
  });

  it('coerces numeric strings', () => {
    expect(core.travelerCount({ adults: '2', children: '1' })).toBe(3);
  });

  it('ignores negatives, NaN and non-objects', () => {
    expect(core.travelerCount({ adults: -1, children: 2, infants: NaN })).toBe(2);
    expect(core.travelerCount(null)).toBe(0);
    expect(core.travelerCount(undefined)).toBe(0);
    expect(core.travelerCount('x')).toBe(0);
  });
});

describe('isClosedDate', () => {
  const parsed = {
    availability: {
      dateExceptions: [{ id: 'e1', type: 'closed', date: MONDAY }],
    },
    pricingSchedules: {
      schedules: [{ dateExceptions: [{ id: 'e2', type: 'closed', date: WEDNESDAY }] }],
    },
  };

  it('finds closed exceptions from the availability block', () => {
    expect(core.isClosedDate(parsed, MONDAY)).toBe(true);
  });

  it('finds closed exceptions from pricing schedules', () => {
    expect(core.isClosedDate(parsed, WEDNESDAY)).toBe(true);
  });

  it('ignores other dates and non-closed types', () => {
    expect(core.isClosedDate(parsed, TUESDAY)).toBe(false);
    expect(core.isClosedDate({ ...parsed, availability: { dateExceptions: [{ type: 'override', date: MONDAY }] } }, MONDAY)).toBe(false);
  });
});

describe('isOperatingDay', () => {
  const parsed = { availability: { daysOfWeek: ['Monday', 'Wednesday'] } };

  it('returns true on operating days', () => {
    expect(core.isOperatingDay(parsed, core.toUtcDate(MONDAY))).toBe(true);
  });

  it('returns false on non-operating days', () => {
    expect(core.isOperatingDay(parsed, core.toUtcDate(TUESDAY))).toBe(false);
  });

  it('returns true when no operating days are configured', () => {
    expect(core.isOperatingDay({ availability: {} }, core.toUtcDate(TUESDAY))).toBe(true);
  });
});

describe('getEffectiveCapacity', () => {
  it('always uses maxParticipants, ignoring any override capacity', () => {
    expect(core.getEffectiveCapacity({ travelerDetails: { maxParticipants: 10 } }, 50)).toBe(10);
  });

  it('falls back to maxParticipants', () => {
    expect(core.getEffectiveCapacity({ travelerDetails: { maxParticipants: 8 } }, 50)).toBe(8);
  });

  it('falls back to the system value', () => {
    expect(core.getEffectiveCapacity({}, 50)).toBe(50);
  });
});

describe('buildTimeSlots', () => {
  it('uses override slots when present', () => {
    const override = { timeSlotOverrides: [{ time: '09:00', capacity: 10 }, '12:30'] };
    expect(core.buildTimeSlots({}, override, 50)).toEqual([
      { time: '09:00', capacity: 10 },
      { time: '12:30', capacity: 50 },
    ]);
  });

  it('uses template slots with the fallback capacity otherwise', () => {
    const parsed = { availability: { timeSlots: ['10:00', '14:00'] } };
    expect(core.buildTimeSlots(parsed, null, 50)).toEqual([
      { time: '10:00', capacity: 50 },
      { time: '14:00', capacity: 50 },
    ]);
  });

  it('returns an empty list for a tour without slots', () => {
    expect(core.buildTimeSlots({}, null, 50)).toEqual([]);
  });
});

describe('computeStatus', () => {
  it('blocks non-operating days', () => {
    expect(core.computeStatus(0, 10, null, false)).toBe('BLOCKED');
  });

  it('honors only the BLOCKED override', () => {
    expect(core.computeStatus(0, 10, 'BLOCKED', true)).toBe('BLOCKED');
  });

  it('ignores manual FULL/LIMITED overrides and derives status from occupancy', () => {
    expect(core.computeStatus(0, 10, 'FULL', true)).toBe('AVAILABLE');
    expect(core.computeStatus(2, 10, 'LIMITED', true)).toBe('AVAILABLE');
    expect(core.computeStatus(1, 10, 'AVAILABLE', true)).toBe('AVAILABLE');
  });

  it('computes FULL/LIMITED from the occupancy ratio', () => {
    expect(core.computeStatus(10, 10, null, true)).toBe('FULL');
    expect(core.computeStatus(8, 10, null, true)).toBe('LIMITED');
    expect(core.computeStatus(5, 10, null, true)).toBe('LIMITED');
    expect(core.computeStatus(4, 10, null, true)).toBe('AVAILABLE');
    expect(core.computeStatus(2, 10, null, true)).toBe('AVAILABLE');
  });

  it('blocks zero capacity', () => {
    expect(core.computeStatus(0, 0, null, true)).toBe('BLOCKED');
  });
});

describe('evaluateBookingAvailability', () => {
  it('rejects an invalid date', async () => {
    const result = await core.evaluateBookingAvailability(makeDb(), perPersonTour, 'garbage', null, { adults: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Invalid date');
  });

  it('rejects a closed date', async () => {
    const tour = {
      ...perPersonTour,
      schedulesAndPricing: {
        ...perPersonTour.schedulesAndPricing,
        availability: { ...perPersonTour.schedulesAndPricing.availability, dateExceptions: [{ type: 'closed', date: MONDAY }] },
      },
    };
    const result = await core.evaluateBookingAvailability(makeDb(), tour, MONDAY, '10:00', { adults: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Tour is not available on this date');
  });

  it('rejects a non-operating day', async () => {
    const result = await core.evaluateBookingAvailability(makeDb(), perPersonTour, TUESDAY, '10:00', { adults: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Tour is not available on this date');
  });

  it('rejects BLOCKED overrides but treats FULL overrides as automatic', async () => {
    const blocked = await core.evaluateBookingAvailability(
      makeDb({ override: { status: 'BLOCKED', capacity: 10, timeSlotOverrides: null } }),
      perPersonTour, MONDAY, '10:00', { adults: 1 }
    );
    expect(blocked.reason).toBe('Date is blocked');

    // A manual FULL override is no longer honored — the date stays bookable
    // until the capacity-derived ratio reaches 100%.
    const full = await core.evaluateBookingAvailability(
      makeDb({ override: { status: 'FULL', capacity: 10, timeSlotOverrides: null } }),
      perPersonTour, MONDAY, '10:00', { adults: 1 }
    );
    expect(full.ok).toBe(true);
  });

  it('requires a time slot when the tour has slots', async () => {
    const result = await core.evaluateBookingAvailability(makeDb(), perPersonTour, MONDAY, null, { adults: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('A time slot must be selected');
  });

  it('rejects a time slot that does not exist for the date', async () => {
    const result = await core.evaluateBookingAvailability(makeDb(), perPersonTour, MONDAY, '99:99', { adults: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Selected time is not available for this date');
  });

  it('rejects when capacity is exhausted', async () => {
    const db = makeDb({ counts: [{ currentBookings: '10', groupCount: '0' }] });
    const result = await core.evaluateBookingAvailability(db, perPersonTour, MONDAY, '10:00', { adults: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Only 0 spots left');
  });

  it('rejects a party larger than the remaining capacity', async () => {
    const db = makeDb({ counts: [{ currentBookings: '8', groupCount: '0' }] });
    const result = await core.evaluateBookingAvailability(db, perPersonTour, MONDAY, '10:00', { adults: 5 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('2 spots left, but 5 requested');
  });

  it('rejects perGroup tours once group slots are exhausted', async () => {
    const db = makeDb({ counts: [{ currentBookings: '3', groupCount: '3' }] });
    const result = await core.evaluateBookingAvailability(db, perGroupTour, MONDAY, '10:00', { adults: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('No group slots remaining for this time');
  });

  it('counts groups for perGroup tours', async () => {
    const db = makeDb({ counts: [{ currentBookings: '2', groupCount: '1' }] });
    const result = await core.evaluateBookingAvailability(db, perGroupTour, MONDAY, '10:00', { adults: 2 });
    expect(result.ok).toBe(true);
    expect(result.isPerGroup).toBe(true);
    expect(result.groupsRemaining).toBe(2);
    expect(result.availableSpots).toBe(2);
  });

  it('returns the party-spot math for a successful per-person check', async () => {
    const db = makeDb({ counts: [{ currentBookings: '3', groupCount: '0' }] });
    const result = await core.evaluateBookingAvailability(db, perPersonTour, MONDAY, '10:00', { adults: 2 });
    expect(result.ok).toBe(true);
    expect(result.maxCapacity).toBe(10);
    expect(result.availableSpots).toBe(7);
    expect(result.groupsRemaining).toBeNull();
  });
});

describe('checkTourAvailability', () => {
  it('returns not found for a missing tour', async () => {
    prisma.tour.findUnique.mockResolvedValue(null);
    const result = await checkTourAvailability('missing', MONDAY);
    expect(result).toMatchObject({ available: false, reason: 'Tour not found' });
  });

  it('rejects an inactive tour', async () => {
    prisma.tour.findUnique.mockResolvedValue({ ...perPersonTour, status: 'DRAFT' });
    const result = await checkTourAvailability('t1', MONDAY);
    expect(result).toMatchObject({ available: false, reason: 'Tour is not active' });
  });

  it('rejects an invalid date', async () => {
    const result = await checkTourAvailability('t1', 'nope');
    expect(result).toMatchObject({ available: false, reason: 'Invalid date' });
  });

  it('requires a time slot for fixed-slot tours', async () => {
    const result = await checkTourAvailability('t1', MONDAY);
    expect(result).toMatchObject({ available: false, reason: 'A time slot must be selected' });
  });

  it('rejects a slot that is not offered', async () => {
    const result = await checkTourAvailability('t1', MONDAY, '09:00');
    expect(result).toMatchObject({ available: false, reason: 'Selected time is not available for this date' });
  });

  it('reports a closed date as unavailable', async () => {
    const closed = {
      ...perPersonTour,
      schedulesAndPricing: {
        ...perPersonTour.schedulesAndPricing,
        availability: { ...perPersonTour.schedulesAndPricing.availability, dateExceptions: [{ type: 'closed', date: MONDAY }] },
      },
    };
    prisma.tour.findUnique.mockResolvedValue(closed);
    const result = await checkTourAvailability('t1', MONDAY, '10:00');
    expect(result).toMatchObject({ available: false, reason: 'Tour is not available on this date' });
  });

  it('reports an override BLOCKED date', async () => {
    prisma.tourDateOverride.findFirst.mockResolvedValue({ status: 'BLOCKED', capacity: 10, timeSlotOverrides: null });
    const result = await checkTourAvailability('t1', MONDAY, '10:00');
    expect(result).toMatchObject({ available: false, reason: 'Date is blocked' });
  });

  it('reports a fully booked date when a party overflows the spots', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ currentBookings: '9', groupCount: '0' }]);
    const result = await checkTourAvailability('t1', MONDAY, { selectedTime: '10:00', travelers: { adults: 2 } });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('Only 1 spot left, but 2 requested');
  });

  it('accepts a party that fits within capacity', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ currentBookings: '4', groupCount: '0' }]);
    const result = await checkTourAvailability('t1', MONDAY, '10:00', { selectedTime: '10:00', travelers: { adults: 2, children: 1 } });
    expect(result.available).toBe(true);
    expect(result.availableSpots).toBe(6);
    expect(result.isOperatingDay).toBe(true);
    expect(result.closedDate).toBe(null);
  });

  it('accounts for perGroup group caps', async () => {
    prisma.tour.findUnique.mockResolvedValue(perGroupTour);
    prisma.$queryRawUnsafe.mockResolvedValue([{ currentBookings: '3', groupCount: '3' }]);
    const result = await checkTourAvailability('t2', MONDAY, { selectedTime: '10:00', travelers: { adults: 1 } });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('No group slots remaining for this time');
  });
});

describe('buildAvailabilityCalendar', () => {
  it('marks non-operating days BLOCKED and populates slots', async () => {
    const calendar = await buildAvailabilityCalendar('t1', perPersonTour.schedulesAndPricing, MONDAY, WEDNESDAY, FIXED_TODAY);
    expect(calendar).toHaveLength(3);
    expect(calendar[0].date).toBe(MONDAY);
    expect(calendar[0].status).toBe('AVAILABLE');
    expect(calendar[0].timeSlots).toHaveLength(2);
    expect(calendar[1].date).toBe(TUESDAY);
    expect(calendar[1].status).toBe('BLOCKED');
    expect(calendar[2].date).toBe(WEDNESDAY);
    expect(calendar[2].status).toBe('AVAILABLE');
  });

  it('reflects traveler bookings in slot remaining counts', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { selectedDate: new Date(`${MONDAY}T00:00:00.000Z`), selectedTime: '10:00', travelers: { adults: 3 } },
    ]);
    const calendar = await buildAvailabilityCalendar('t1', perPersonTour.schedulesAndPricing, MONDAY, MONDAY, FIXED_TODAY);
    const slot = calendar[0].timeSlots.find((s) => s.time === '10:00');
    expect(slot.booked).toBe(3);
    expect(slot.remaining).toBe(7);
    expect(calendar[0].booked).toBe(3);
  });

  it('applies closed-date exceptions', async () => {
    const parsed = {
      ...perPersonTour.schedulesAndPricing,
      availability: { ...perPersonTour.schedulesAndPricing.availability, dateExceptions: [{ type: 'closed', date: MONDAY }] },
    };
    const calendar = await buildAvailabilityCalendar('t1', parsed, MONDAY, MONDAY, FIXED_TODAY);
    expect(calendar[0].status).toBe('BLOCKED');
    expect(calendar[0].isOperatingDay).toBe(false);
  });

  it('ignores override status/capacity and derives from builder max', async () => {
    prisma.tourDateOverride.findMany.mockResolvedValue([
      { date: new Date(`${MONDAY}T00:00:00.000Z`), status: 'LIMITED', capacity: 3, timeSlotOverrides: null },
    ]);
    const calendar = await buildAvailabilityCalendar('t1', perPersonTour.schedulesAndPricing, MONDAY, MONDAY, FIXED_TODAY);
    expect(calendar[0].capacity).toBe(10);
    expect(calendar[0].status).toBe('AVAILABLE');
    expect(calendar[0].overrideStatus).toBe('LIMITED');
    expect(calendar[0].hasOverride).toBe(true);
  });

  it('reports groups for perGroup tours with unit-aware day capacity', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { selectedDate: new Date(`${MONDAY}T00:00:00.000Z`), selectedTime: '10:00', travelers: { adults: 4 } },
    ]);
    const calendar = await buildAvailabilityCalendar('t2', perGroupTour.schedulesAndPricing, MONDAY, MONDAY, FIXED_TODAY);
    const slot = calendar[0].timeSlots[0];
    expect(slot.groupsBooked).toBe(1);
    expect(slot.groupsRemaining).toBe(2);
    // Day-level numbers are GROUP slots, not people: 3 groups/slot × 1 slot.
    expect(calendar[0].capacityUnit).toBe('groups');
    expect(calendar[0].groupsPerSlot).toBe(3);
    expect(calendar[0].capacity).toBe(3);
    expect(calendar[0].booked).toBe(1);
    expect(calendar[0].remaining).toBe(2);
    expect(calendar[0].status).toBe('AVAILABLE');
  });

  it('computes the perGroup day status from group slots, not travelers', async () => {
    // 3 groups of 1 traveler each = every group slot taken. Under the old
    // traveler-based math this was 3/150 (Available); group-based it is FULL.
    prisma.booking.findMany.mockResolvedValue([
      { selectedDate: new Date(`${MONDAY}T00:00:00.000Z`), selectedTime: '10:00', travelers: { adults: 1 } },
      { selectedDate: new Date(`${MONDAY}T00:00:00.000Z`), selectedTime: '10:00', travelers: { adults: 1 } },
      { selectedDate: new Date(`${MONDAY}T00:00:00.000Z`), selectedTime: '10:00', travelers: { adults: 1 } },
    ]);
    const calendar = await buildAvailabilityCalendar('t2', perGroupTour.schedulesAndPricing, MONDAY, MONDAY, FIXED_TODAY);
    expect(calendar[0].booked).toBe(3);
    expect(calendar[0].capacity).toBe(3);
    expect(calendar[0].status).toBe('FULL');
  });

  it('keeps the per-person calendar in people units', async () => {
    const calendar = await buildAvailabilityCalendar('t1', perPersonTour.schedulesAndPricing, MONDAY, MONDAY, FIXED_TODAY);
    expect(calendar[0].capacityUnit).toBe('people');
    expect(calendar[0].capacity).toBe(10);
  });

  it('clamps past dates to PAST with zeroed capacity fields', async () => {
    const calendar = await buildAvailabilityCalendar(
      't1', perPersonTour.schedulesAndPricing, MONDAY, TUESDAY, new Date('2026-06-20')
    );
    expect(calendar).toHaveLength(2);
    expect(calendar[0].status).toBe('PAST');
    expect(calendar[0].isPast).toBe(true);
    expect(calendar[0].booked).toBe(0);
    expect(calendar[0].remaining).toBe(0);
    expect(calendar[0].timeSlots).toEqual([]);
    expect(calendar[1].status).toBe('PAST');
    expect(calendar[1].isPast).toBe(true);
  });

  it('keeps today and future dates bookable', async () => {
    const calendar = await buildAvailabilityCalendar('t1', perPersonTour.schedulesAndPricing, MONDAY, MONDAY, FIXED_TODAY);
    expect(calendar[0].status).toBe('AVAILABLE');
    expect(calendar[0].isPast).toBe(false);
  });
});

describe('resolveCutoffHours', () => {
  it('prefers cutoffMinutes and converts to hours', () => {
    expect(core.resolveCutoffHours({ cutoffMinutes: 20 }, 24)).toBeCloseTo(20 / 60, 5);
    expect(core.resolveCutoffHours({ cutoffMinutes: 90 }, 24)).toBeCloseTo(1.5, 5);
  });

  it('falls back to legacy minAdvanceBookingHours', () => {
    expect(core.resolveCutoffHours({ minAdvanceBookingHours: 12 }, 24)).toBe(12);
    expect(core.resolveCutoffHours({ cutoffMinutes: null, minAdvanceBookingHours: 6 }, 24)).toBe(6);
  });

  it('falls back to the system default when nothing is configured', () => {
    expect(core.resolveCutoffHours({}, 24)).toBe(24);
    expect(core.resolveCutoffHours({}, null)).toBe(24);
  });

  it('ignores garbage and negative values', () => {
    expect(core.resolveCutoffHours({ cutoffMinutes: 'abc' }, 24)).toBe(24);
    expect(core.resolveCutoffHours({ cutoffMinutes: -5 }, 24)).toBe(24);
  });
});

describe('cutoffLabel', () => {
  it('labels sub-hour cutoffs in minutes', () => {
    expect(core.cutoffLabel(20 / 60)).toBe('20 minutes');
  });

  it('labels hour cutoffs in hours', () => {
    expect(core.cutoffLabel(24)).toBe('24 hours');
    expect(core.cutoffLabel(12)).toBe('12 hours');
  });
});

describe('timezone helpers', () => {
  it('getTourTimezone reads the availability timezone with UTC fallback', () => {
    expect(core.getTourTimezone({ availability: { timezone: 'Pacific/Auckland' } })).toBe('Pacific/Auckland');
    expect(core.getTourTimezone({ timezone: 'America/New_York' })).toBe('America/New_York');
    expect(core.getTourTimezone({ availability: {} })).toBe('UTC');
    expect(core.getTourTimezone({ availability: { timezone: 'Not/AZone' } })).toBe('UTC');
  });

  it('weekdayInZone returns the tour-local weekday', () => {
    // 2026-06-14 (Sunday UTC) is Monday in Auckland (+12).
    expect(core.weekdayInZone(core.toUtcDate('2026-06-14'), 'Pacific/Auckland')).toBe('Monday');
    expect(core.weekdayInZone(core.toUtcDate('2026-06-15'), 'Pacific/Auckland')).toBe('Tuesday');
    expect(core.weekdayInZone(core.toUtcDate('2026-06-15'), 'UTC')).toBe('Monday');
  });

  it('zonedDateKey shifts the UTC day in positive-offset zones', () => {
    expect(core.zonedDateKey('2026-06-15', 'UTC')).toBe('2026-06-15');
    expect(core.zonedDateKey('2026-06-15', 'Pacific/Auckland')).toBe('2026-06-16');
  });

  it('zonedTimeToUtc converts a tour-local wall clock to the UTC instant', () => {
    // 10:00 in Auckland (+12, no DST in June) = 22:00 the prior UTC day.
    const utc = core.zonedTimeToUtc('2026-06-15 10:00', 'Pacific/Auckland');
    expect(utc.toISOString().slice(0, 16)).toBe('2026-06-14T22:00');
    // UTC zone maps through unchanged.
    expect(core.zonedTimeToUtc('2026-06-15 10:00', 'UTC').toISOString().slice(0, 16)).toBe('2026-06-15T10:00');
  });

  it('zonedTimeToUtc rejects malformed input', () => {
    expect(Number.isNaN(core.zonedTimeToUtc('garbage', 'UTC').getTime())).toBe(true);
    expect(Number.isNaN(core.zonedTimeToUtc('2026-06-15 25:00', 'UTC').getTime())).toBe(true);
  });

  it('isOperatingDay uses the tour timezone for the weekday', async () => {
    const parsed = { availability: { daysOfWeek: ['Monday'], timezone: 'Pacific/Auckland' } };
    // Sunday UTC = Monday in Auckland -> operating.
    expect(core.isOperatingDay(parsed, core.toUtcDate('2026-06-14'))).toBe(true);
    // Monday UTC = Tuesday in Auckland -> not operating.
    expect(core.isOperatingDay(parsed, core.toUtcDate('2026-06-15'))).toBe(false);
  });
});
