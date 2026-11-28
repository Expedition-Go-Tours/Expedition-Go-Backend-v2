jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/chatService', () => ({
  findOrCreateConversation: jest.fn(() => Promise.resolve()),
}));

const bookings = require('../../src/brands/ghana/staysBookingsController');

describe('parseTravellers', () => {
  it('keeps legacy guests as adults', () => {
    expect(bookings._private.parseTravellers({ guests: 3 })).toEqual({
      adults: 3,
      childAges: [],
      totalGuests: 3,
    });
  });

  it('splits adults and children with ages', () => {
    expect(
      bookings._private.parseTravellers({ adults: 2, children: 2, childAges: [4, 9] }),
    ).toEqual({ adults: 2, childAges: [4, 9], totalGuests: 4 });
  });

  it('derives adults from the total when only guests is supplied', () => {
    expect(bookings._private.parseTravellers({ guests: 4, children: 1, childAges: [7] })).toEqual({
      adults: 3,
      childAges: [7],
      totalGuests: 4,
    });
  });
});

describe('occupancyPricing', () => {
  const room = { id: 'r1', adults: 2, children: 1, count: 2 };

  it('adds extra adults above the base occupancy', () => {
    const result = bookings._private.occupancyPricing({
      base: 100,
      plan: { baseGuests: 2, extraAdult: 30, extraChild: 15 },
      room,
      property: {},
      travellers: { adults: 3, childAges: [], totalGuests: 3 },
      childGroups: [],
    });
    expect(result.price).toBe(130);
    expect(result.adjustment).toBe(30);
  });

  it('applies a percentage discount for a lower occupancy', () => {
    const result = bookings._private.occupancyPricing({
      base: 200,
      plan: {
        baseGuests: 2,
        occupancyDiscounts: [{ occupancy: 1, value: 10, unit: 'percent', enabled: true }],
        singleGuestDiscount: 50,
      },
      room,
      property: {},
      travellers: { adults: 1, childAges: [], totalGuests: 1 },
      childGroups: [],
    });
    expect(result.price).toBe(180);
    expect(result.adjustment).toBe(-20);
  });

  it('falls back to singleGuestDiscount when no occupancy row exists', () => {
    const result = bookings._private.occupancyPricing({
      base: 200,
      plan: { baseGuests: 2, singleGuestDiscount: 50 },
      room,
      property: {},
      travellers: { adults: 1, childAges: [], totalGuests: 1 },
      childGroups: [],
    });
    expect(result.price).toBe(150);
  });

  it('rejects guests above the plan limit', () => {
    expect(() =>
      bookings._private.occupancyPricing({
        base: 100,
        plan: { baseGuests: 2, maxGuests: 2 },
        room,
        property: {},
        travellers: { adults: 3, childAges: [], totalGuests: 3 },
        childGroups: [],
      }),
    ).toThrow(/up to 2 guests/);
  });
});

describe('childRateCharges', () => {
  const property = {
    childRateGroups: [
      { minAge: 0, maxAge: 2, rateType: 'free', value: 0, unit: 'night' },
      { minAge: 3, maxAge: 12, rateType: 'fixed', value: 20, unit: 'night' },
      { minAge: 13, maxAge: 17, rateType: 'percentage', value: 25, unit: 'night' },
    ],
  };

  it('charges free, fixed and percentage groups correctly', () => {
    const result = bookings._private.childRateCharges(property, {}, [1, 7, 15], 100);
    expect(result.perNight).toBe(45);
    expect(result.perStay).toBe(0);
  });

  it('charges a per-stay fixed group once', () => {
    const result = bookings._private.childRateCharges(
      { childRateGroups: [{ minAge: 3, maxAge: 12, rateType: 'fixed', value: 40, unit: 'stay' }] },
      {},
      [7],
      100,
    );
    expect(result.perNight).toBe(0);
    expect(result.perStay).toBe(40);
  });

  it('falls back to extraChild when no group matches', () => {
    const result = bookings._private.childRateCharges({ childRateGroups: [] }, { extraChild: 12 }, [7], 100);
    expect(result.perNight).toBe(12);
  });
});

describe('valueAddCharges', () => {
  const property = {
    valueAdds: [
      { id: 'night', price: 10, unit: 'night', active: true },
      { id: 'stay', price: 50, unit: 'stay', active: true },
      { id: 'guest', price: 5, unit: 'guest', active: true },
    ],
  };

  it('splits nightly and one-off charges', () => {
    const result = bookings._private.valueAddCharges(property, {}, ['night', 'stay', 'guest'], 3);
    expect(result.perNight).toBe(10);
    expect(result.once).toBe(65);
  });

  it('rejects an unknown value add', () => {
    expect(() => bookings._private.valueAddCharges(property, {}, ['missing'], 2)).toThrow(
      /not available/,
    );
  });

  it('rejects a value add the rate plan does not allow', () => {
    expect(() =>
      bookings._private.valueAddCharges(property, { valueAddIds: ['stay'] }, ['night'], 2),
    ).toThrow(/not available on this rate plan/);
  });
});

describe('applyPriceChange', () => {
  it('applies percentage and fixed changes', () => {
    expect(
      bookings._private.applyPriceChange(100, { mode: 'increase', unit: 'percent', value: 10 }),
    ).toBe(110);
    expect(
      bookings._private.applyPriceChange(100, { mode: 'decrease', unit: 'amount', value: 25 }),
    ).toBe(75);
    expect(bookings._private.applyPriceChange(100, { mode: 'none' })).toBe(100);
  });
});
