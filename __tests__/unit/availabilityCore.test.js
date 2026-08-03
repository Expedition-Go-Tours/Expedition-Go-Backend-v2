jest.mock('../../utils/getConfig', () => jest.fn().mockResolvedValue('50'));

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
  it('prefers override capacity', () => {
    expect(core.getEffectiveCapacity({ travelerDetails: { maxParticipants: 10 } }, { capacity: 5 }, 50)).toBe(5);
  });

  it('falls back to maxParticipants', () => {
    expect(core.getEffectiveCapacity({ travelerDetails: { maxParticipants: 8 } }, null, 50)).toBe(8);
  });

  it('falls back to the system value', () => {
    expect(core.getEffectiveCapacity({}, null, 50)).toBe(50);
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

  it('honors override BLOCKED and FULL', () => {
    expect(core.computeStatus(0, 10, 'BLOCKED', true)).toBe('BLOCKED');
    expect(core.computeStatus(0, 10, 'FULL', true)).toBe('FULL');
  });

  it('computes FULL/LIMITED from the occupancy ratio', () => {
    expect(core.computeStatus(10, 10, null, true)).toBe('FULL');
    expect(core.computeStatus(8, 10, null, true)).toBe('LIMITED');
    expect(core.computeStatus(2, 10, null, true)).toBe('AVAILABLE');
  });

  it('honors override LIMITED', () => {
    expect(core.computeStatus(1, 10, 'LIMITED', true)).toBe('LIMITED');
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

  it('rejects BLOCKED and FULL overrides', async () => {
    const blocked = await core.evaluateBookingAvailability(
      makeDb({ override: { status: 'BLOCKED', capacity: 10, timeSlotOverrides: null } }),
      perPersonTour, MONDAY, '10:00', { adults: 1 }
    );
    expect(blocked.reason).toBe('Date is blocked');

    const full = await core.evaluateBookingAvailability(
      makeDb({ override: { status: 'FULL', capacity: 10, timeSlotOverrides: null } }),
      perPersonTour, MONDAY, '10:00', { adults: 1 }
    );
    expect(full.reason).toBe('Date is fully booked');
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
    const calendar = await buildAvailabilityCalendar('t1', perPersonTour.schedulesAndPricing, MONDAY, WEDNESDAY);
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
    const calendar = await buildAvailabilityCalendar('t1', perPersonTour.schedulesAndPricing, MONDAY, MONDAY);
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
    const calendar = await buildAvailabilityCalendar('t1', parsed, MONDAY, MONDAY);
    expect(calendar[0].status).toBe('BLOCKED');
    expect(calendar[0].isOperatingDay).toBe(false);
  });

  it('uses override capacity for the day', async () => {
    prisma.tourDateOverride.findMany.mockResolvedValue([
      { date: new Date(`${MONDAY}T00:00:00.000Z`), status: 'LIMITED', capacity: 3, timeSlotOverrides: null },
    ]);
    const calendar = await buildAvailabilityCalendar('t1', perPersonTour.schedulesAndPricing, MONDAY, MONDAY);
    expect(calendar[0].capacity).toBe(3);
    expect(calendar[0].status).toBe('LIMITED');
    expect(calendar[0].hasOverride).toBe(true);
  });

  it('reports groups for perGroup tours', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { selectedDate: new Date(`${MONDAY}T00:00:00.000Z`), selectedTime: '10:00', travelers: { adults: 4 } },
    ]);
    const calendar = await buildAvailabilityCalendar('t2', perGroupTour.schedulesAndPricing, MONDAY, MONDAY);
    const slot = calendar[0].timeSlots[0];
    expect(slot.groupsBooked).toBe(1);
    expect(slot.groupsRemaining).toBe(2);
  });
});
