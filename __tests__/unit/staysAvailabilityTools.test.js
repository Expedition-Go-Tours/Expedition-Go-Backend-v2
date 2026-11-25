/**
 * Unit coverage for the availability-tool helpers. The HTTP/database behaviour
 * lives in the DB-gated API suite; these tests pin the planning and validation
 * rules that are easy to regress (copy semantics, rule effects, weekdays).
 */

jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/chatService', () => ({
  findOrCreateConversation: jest.fn(() => Promise.resolve()),
}));

const availability = require('../../src/brands/ghana/staysAvailabilityController');
const bookings = require('../../src/brands/ghana/staysBookingsController');

const DATE = (value) => new Date(`${value}T00:00:00.000Z`);

describe('availability date helpers', () => {
  it('counts inclusive days and rejects reversed ranges', () => {
    expect(availability._private.inclusiveDays(DATE('2027-01-01'), DATE('2027-01-01'))).toBe(1);
    expect(availability._private.inclusiveDays(DATE('2027-01-01'), DATE('2027-01-10'))).toBe(10);
    expect(() => availability._private.parseRange('2027-01-10', '2027-01-01')).toThrow(
      /before start/,
    );
  });

  it('caps very large calendar ranges', () => {
    expect(() => availability._private.parseRange('2027-01-01', '2030-01-01')).toThrow(
      /731 days or fewer/,
    );
  });
});

describe('planRateCopy', () => {
  const sourceRows = [
    {
      roomId: 'r1',
      date: DATE('2027-01-01'),
      price: 100,
      count: 2,
      minStay: 3,
      closed: false,
    },
    {
      roomId: 'r1',
      date: DATE('2027-01-02'),
      price: null,
      count: null,
      minStay: null,
      closed: true,
    },
  ];

  it('copies only the requested fields onto future dates', () => {
    const plan = availability._private.planRateCopy({
      sourceRows,
      targetRows: [],
      roomIds: ['r1'],
      sourceFrom: DATE('2027-01-01'),
      sourceDays: 2,
      targetStart: DATE('2027-02-01'),
      fields: ['price', 'count'],
      overwrite: false,
    });

    // The second source night has no price/count and a closed flag that was not
    // requested, so it contributes nothing.
    expect(plan.operations).toEqual([
      { roomId: 'r1', date: DATE('2027-02-01'), data: { price: 100, count: 2 } },
    ]);
    expect(plan.skipped).toBe(0);
    expect(plan.considered).toBe(1);
  });

  it('keeps an existing target value unless overwrite is enabled', () => {
    const targetRows = [
      { roomId: 'r1', date: DATE('2027-02-01'), price: 999, count: 4, minStay: null, closed: false },
    ];

    const safe = availability._private.planRateCopy({
      sourceRows,
      targetRows,
      roomIds: ['r1'],
      sourceFrom: DATE('2027-01-01'),
      sourceDays: 2,
      targetStart: DATE('2027-02-01'),
      fields: ['price', 'count'],
      overwrite: false,
    });
    expect(safe.operations).toEqual([]);
    expect(safe.skipped).toBe(1);

    const forced = availability._private.planRateCopy({
      sourceRows,
      targetRows,
      roomIds: ['r1'],
      sourceFrom: DATE('2027-01-01'),
      sourceDays: 2,
      targetStart: DATE('2027-02-01'),
      fields: ['price', 'count'],
      overwrite: true,
    });
    expect(forced.operations).toEqual([
      { roomId: 'r1', date: DATE('2027-02-01'), data: { price: 100, count: 2 } },
    ]);
  });

  it('copies closed nights but never copies an open flag', () => {
    const plan = availability._private.planRateCopy({
      sourceRows,
      targetRows: [],
      roomIds: ['r1'],
      sourceFrom: DATE('2027-01-01'),
      sourceDays: 2,
      targetStart: DATE('2027-02-01'),
      fields: ['closed'],
      overwrite: false,
    });

    expect(plan.operations).toEqual([
      { roomId: 'r1', date: DATE('2027-02-02'), data: { closed: true } },
    ]);
  });
});

describe('restriction rule validation', () => {
  const rooms = [{ id: 'r1' }, { id: 'r2' }];

  it('requires at least one restriction effect', () => {
    expect(() => availability._private.buildRestrictionRuleData(
      { startDate: '2027-01-01', endDate: '2027-01-31' },
      rooms,
    )).toThrow(/at least one restriction/i);
  });

  it('normalises weekdays and validates room ids', () => {
    const data = availability._private.buildRestrictionRuleData({
      weekdays: ['Monday', 'monday', 'Sunday'],
      roomIds: ['r1'],
      stopSell: true,
    }, rooms);

    expect(data.weekdays).toEqual(['monday', 'sunday']);
    expect(data.roomIds).toEqual(['r1']);
    expect(() => availability._private.buildRestrictionRuleData({
      roomIds: ['missing'],
      stopSell: true,
    }, rooms)).toThrow(/Room not found/);
  });

  it('treats an empty room list as every room', () => {
    const data = availability._private.buildRestrictionRuleData({
      roomIds: [],
      minStay: 2,
    }, rooms);
    expect(data.roomIds).toEqual([]);
  });

  it('rejects a maximum below the minimum', () => {
    expect(() => availability._private.buildRestrictionRuleData({
      minStay: 4,
      maxStay: 2,
    }, rooms)).toThrow(/Maximum stay cannot be less/);
  });

  it('rejects a reversed date range', () => {
    expect(() => availability._private.buildRestrictionRuleData({
      startDate: '2027-02-01',
      endDate: '2027-01-01',
      stopSell: true,
    }, rooms)).toThrow(/end date cannot be before/);
  });

  it('serializes dates as calendar keys', () => {
    const row = availability._private.serializeRestrictionRule({
      id: 'rule-1',
      propertyId: 'sp-1',
      name: 'Peak weekend',
      startDate: DATE('2027-01-01'),
      endDate: DATE('2027-01-31'),
      weekdays: ['friday'],
      roomIds: [],
      minStay: 2,
      maxStay: null,
      stopSell: true,
      closedToArrival: false,
      closedToDeparture: false,
      isActive: true,
      createdAt: DATE('2026-11-01'),
      updatedAt: DATE('2026-11-01'),
    });

    expect(row).toEqual(expect.objectContaining({
      startDate: '2027-01-01',
      endDate: '2027-01-31',
      minStay: 2,
      stopSell: true,
    }));
  });
});

describe('value add validation', () => {
  it('requires a name and a non-negative price', () => {
    expect(() => availability._private.buildValueAddData({ price: 20 })).toThrow(/name is required/);
    expect(() => availability._private.buildValueAddData({ name: 'Breakfast' })).toThrow(
      /price is required/,
    );
    expect(() => availability._private.buildValueAddData({ name: 'Breakfast', price: -1 })).toThrow(
      /zero or more/,
    );
  });

  it('defaults the unit and normalises the payload', () => {
    const data = availability._private.buildValueAddData({
      name: '  Airport pickup ',
      price: '150.50',
      description: '  One way  ',
    });

    expect(data).toEqual({
      name: 'Airport pickup',
      description: 'One way',
      price: 150.5,
      unit: 'PER_STAY',
      isActive: true,
      sortOrder: 0,
    });
  });

  it('serializes a decimal price as a number', () => {
    const row = availability._private.serializeValueAdd({
      id: 'add-1',
      propertyId: 'sp-1',
      name: 'Breakfast',
      description: null,
      price: '45.00',
      unit: 'PER_PERSON',
      isActive: true,
      sortOrder: 1,
      createdAt: DATE('2026-11-01'),
      updatedAt: DATE('2026-11-01'),
    });

    expect(row.price).toBe(45);
    expect(row.description).toBe('');
    expect(row.unit).toBe('PER_PERSON');
  });
});

describe('booking rule matching', () => {
  it('matches weekdays in UTC', () => {
    // 2027-01-01 is a Friday.
    const fridayRule = { startDate: null, endDate: null, weekdays: ['friday'] };
    expect(bookings._private.ruleAppliesToDate(fridayRule, DATE('2027-01-01'))).toBe(true);
    expect(bookings._private.ruleAppliesToDate(fridayRule, DATE('2027-01-02'))).toBe(false);
  });

  it('matches a date range inclusively', () => {
    const rule = {
      startDate: DATE('2027-01-05'),
      endDate: DATE('2027-01-10'),
      weekdays: [],
    };
    expect(bookings._private.ruleAppliesToDate(rule, DATE('2027-01-05'))).toBe(true);
    expect(bookings._private.ruleAppliesToDate(rule, DATE('2027-01-10'))).toBe(true);
    expect(bookings._private.ruleAppliesToDate(rule, DATE('2027-01-11'))).toBe(false);
  });

  it('treats an empty room list as every room', () => {
    expect(bookings._private.ruleAppliesToRoom({ roomIds: [] }, 'r1')).toBe(true);
    expect(bookings._private.ruleAppliesToRoom({ roomIds: ['r2'] }, 'r1')).toBe(false);
    expect(bookings._private.ruleAppliesToRoom({ roomIds: ['r1'] }, 'r1')).toBe(true);
  });
});
