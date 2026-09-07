/**
 * Pure/unit coverage for the booking-modification service (party size / date /
 * time). Focuses on the deterministic helpers (target building, traveller merge,
 * eligibility, policy gating); the Stripe/webhook flows are covered by the
 * expedition integration tests and the policy suite in bookingHelpers.test.js.
 */
const { buildTarget, mergeTravelers, assertModifyEligible } = require('../../utils/bookingModify');

function baseBooking(overrides = {}) {
  return {
    id: 'b1',
    bookingNumber: 'EXP-1',
    customerId: 'cust1',
    tourId: 't1',
    source: 'EXPEDITION',
    status: 'CONFIRMED',
    paymentStatus: 'SUCCEEDED',
    paymentTiming: 'now',
    payoutStatus: 'PENDING',
    currency: 'USD',
    travelDate: new Date(Date.now() + 72 * 60 * 60 * 1000),
    selectedTime: '10:00',
    grossAmount: 100,
    travelers: { adults: 2, children: 0, phoneNumber: '+1', details: [{ name: 'A' }, { name: 'B' }] },
    tour: { bookingAndTickets: { cancellationPolicy: { type: 'standard', cancellationWindowHours: 24 } } },
    ...overrides,
  };
}

describe('bookingModify mergeTravelers', () => {
  it('merges requested counts over the existing mix and preserves meta keys', () => {
    const out = mergeTravelers(
      { adults: 2, children: 1, phoneNumber: '+123', details: [{ name: 'A' }] },
      { adults: 3 }
    );
    expect(out.adults).toBe(3);
    expect(out.children).toBe(1);
    expect(out.phoneNumber).toBe('+123');
  });

  it('drops traveller detail rows beyond the new headcount (tail)', () => {
    const out = mergeTravelers(
      { adults: 4, details: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] },
      { adults: 2 }
    );
    expect(out.details).toEqual([{ name: 'A' }, { name: 'B' }]);
  });

  it('caps requested category counts at the platform maximum (50)', () => {
    const out = mergeTravelers({ adults: 0 }, { adults: 999 });
    expect(out.adults).toBe(50);
  });
});

describe('bookingModify buildTarget', () => {
  const booking = baseBooking();

  it('flags a date change from YYYY-MM-DD', () => {
    const later = new Date(Date.now() + 96 * 60 * 60 * 1000);
    const ymd = `${later.getUTCFullYear()}-${String(later.getUTCMonth() + 1).padStart(2, '0')}-${String(later.getUTCDate()).padStart(2, '0')}`;
    const t = buildTarget(booking, { travelDate: ymd });
    expect(t.dateChanged).toBe(true);
    expect(t.partyChanged).toBe(false);
  });

  it('flags a party change and recomputes the headcount', () => {
    const t = buildTarget(booking, { travelers: { adults: 3, children: 1 } });
    expect(t.partyChanged).toBe(true);
    expect(t.travelerTotal).toBe(4);
  });

  it('rejects an empty no-op request', () => {
    expect(() => buildTarget(booking, {})).toThrow(/No changes were requested/);
  });

  it('requires at least one traveller after a change', () => {
    expect(() => buildTarget(booking, { travelers: { adults: 0, children: 0 } })).toThrow(
      /At least one traveller/
    );
  });

  it('treats an explicit null selectedTime as a time clear', () => {
    const t = buildTarget(booking, { selectedTime: null });
    expect(t.timeChanged).toBe(true);
    expect(t.time).toBeNull();
  });
});

describe('bookingModify assertModifyEligible', () => {
  it('allows an editable, paid, future booking', () => {
    expect(() => assertModifyEligible(baseBooking())).not.toThrow();
  });

  it('rejects terminal bookings', () => {
    expect(() => assertModifyEligible(baseBooking({ status: 'CANCELLED' }))).toThrow(
      /cannot be modified/
    );
  });

  it('rejects bookings already inside a payout lifecycle', () => {
    expect(() => assertModifyEligible(baseBooking({ payoutStatus: 'ELIGIBLE' }))).toThrow(
      /payout/
    );
  });

  it('rejects tours that are all-sales-final', () => {
    const booking = baseBooking();
    booking.tour = {
      bookingAndTickets: { cancellationPolicy: { type: 'all_sales_final' } },
    };
    expect(() => assertModifyEligible(booking)).toThrow(/not available/);
  });

  it('rejects tours with changes disabled', () => {
    const booking = baseBooking();
    booking.tour = { bookingAndTickets: { changesAllowed: false } };
    expect(() => assertModifyEligible(booking)).toThrow(/not available/);
  });

  it('rejects bookings whose activity starts inside the cutoff window', () => {
    expect(() =>
      assertModifyEligible(baseBooking({ travelDate: new Date(Date.now() + 3 * 60 * 60 * 1000) }))
    ).toThrow(/not allowed within/);
  });
});
