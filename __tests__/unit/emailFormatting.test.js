const { formatTravelers, getBookingTypeLabel } = require('../../src/core/services/emailFormatting');

/**
 * Precedence regressions for the "Travellers" row in every booking email.
 *
 * The supplier email for EXP-06460320-2026-52 claimed "1 adult" while the
 * dashboard said 2: the booking stored `adults: 2` alongside a single named
 * participant, and the formatter read `details` first.
 */
describe('formatTravelers', () => {
  // Verbatim from the production record that reported the bug.
  const realBooking = {
    adults: 2,
    details: [{ name: 'Julien Maingé', ageGroup: 'adult' }],
    infants: 0,
    children: 0,
    location: 'First Atlantic Bank, 9 Mission Street, Accra, Ghana',
    phoneNumber: '+33608659887',
  };

  it('reports the counts, not the number of named travellers', () => {
    const out = formatTravelers(realBooking);
    expect(out.adults).toBe(2);
    expect(out.total).toBe(2);
    expect(out.label).toBe('2 adults');
  });

  it('matches what the dashboard shows for the same payload', () => {
    // storefront.js and the ghana controller both sum the counts directly.
    const dashboardTotal =
      (realBooking.adults || 0) + (realBooking.children || 0) + (realBooking.infants || 0);
    expect(formatTravelers(realBooking).total).toBe(dashboardTotal);
  });

  it('uses details only when the booking carries no counts', () => {
    const out = formatTravelers({
      details: [{ ageGroup: 'adult' }, { ageGroup: 'child' }],
    });
    expect(out.adults).toBe(1);
    expect(out.children).toBe(1);
    expect(out.label).toBe('1 adult, 1 child');
  });

  it('honours an explicit per-entry count in details', () => {
    const out = formatTravelers({ details: [{ ageGroup: 'adult', count: 3 }] });
    expect(out.adults).toBe(3);
    expect(out.label).toBe('3 adults');
  });

  it('never lets phone numbers or locations inflate the headcount', () => {
    const out = formatTravelers({
      phoneNumber: '+33608659887',
      location: 'Cantonments, La',
    });
    expect(out.total).toBe(1);
    expect(out.label).toBe('1 adult');
  });

  it('floors an empty payload at one traveller', () => {
    const out = formatTravelers({});
    expect(out.total).toBe(1);
    expect(out.label).toBe('1 adult');
  });

  it('treats a missing or malformed payload as a single traveller', () => {
    expect(formatTravelers(null).label).toBe('1 traveler');
    expect(formatTravelers(undefined).label).toBe('1 traveler');
    expect(formatTravelers('not-an-object').label).toBe('1 traveler');
  });

  it('combines every age group into one label', () => {
    const out = formatTravelers({ adults: 2, children: 1, infants: 1 });
    expect(out.label).toBe('2 adults, 1 child, 1 infant');
    expect(out.total).toBe(4);
  });

  it('does not inflate on an unrecognised age group in details', () => {
    // Nothing matches, so the single-traveller floor applies rather than the
    // entry being silently counted as an adult.
    const out = formatTravelers({ details: [{ ageGroup: 'senior' }] });
    expect(out.total).toBe(1);
    expect(out.label).toBe('1 adult');
  });
});

/**
 * The "Booking type" row in every booking email.
 *
 * The supplier dashboard's "Is this a private activity?" pill (Step12Options)
 * writes `productContent.options[].isPrivate`, but getBookingTypeLabel used to
 * read `bookingAndTickets.privateTour` — written by nothing — so it always
 * returned the 'Shared' default and the toggle had no effect on email.
 */
describe('getBookingTypeLabel', () => {
  // Verbatim structure of the tour behind EXP-06460320-2026-52.
  const capeCoast = {
    bookingAndTickets: { timezone: 'Africa/Accra', pickupType: 'area', instantConfirmation: true },
    productContent: {
      isPrivateActivity: false,
      options: [{ id: 'opt_default', title: 'Akosombo Ticket', refCode: 'default', isPrivate: false }],
    },
  };

  it("returns 'Shared' for the tour that reported the bug", () => {
    // bookingAndTickets carries neither legacy key, and optionId was null.
    expect(capeCoast.bookingAndTickets).not.toHaveProperty('privateTour');
    expect(getBookingTypeLabel(capeCoast, { optionId: null })).toBe('Shared');
    expect(getBookingTypeLabel(capeCoast)).toBe('Shared');
  });

  it("returns 'Private' when the dashboard's private pill is set", () => {
    const tour = {
      ...capeCoast,
      productContent: {
        isPrivateActivity: false,
        options: [{ id: 'opt_1', title: 'Private charter', isPrivate: true }],
      },
    };
    expect(getBookingTypeLabel(tour, { optionId: null })).toBe('Private');
  });

  it('reads the option the customer actually booked', () => {
    const tour = {
      productContent: {
        options: [
          { id: 'opt_shared', title: 'Seat in coach', isPrivate: false },
          { id: 'opt_priv', title: 'Private charter', isPrivate: true },
        ],
      },
    };
    expect(getBookingTypeLabel(tour, { optionId: 'opt_priv' })).toBe('Private');
    expect(getBookingTypeLabel(tour, { optionId: 'opt_shared' })).toBe('Shared');
  });

  it('falls back to the product-level flag when several options leave it ambiguous', () => {
    const tour = {
      productContent: {
        isPrivateActivity: true,
        options: [
          { id: 'a', isPrivate: false },
          { id: 'b', isPrivate: false },
        ],
      },
    };
    expect(getBookingTypeLabel(tour, { optionId: null })).toBe('Private');
    // Nothing resolves and the product-level flag is off → safe default.
    expect(getBookingTypeLabel({ productContent: { options: [] } })).toBe('Shared');
  });

  it('keeps legacy bookingAndTickets values authoritative', () => {
    expect(getBookingTypeLabel({ bookingAndTickets: { privateTour: true } })).toBe('Private');
    expect(getBookingTypeLabel({ bookingAndTickets: { privateTour: false } })).toBe('Shared');
    expect(
      getBookingTypeLabel({ bookingAndTickets: { bookingType: 'Reserve now, pay later' } })
    ).toBe('Reserve now, pay later');
  });

  it('survives a tour with no productContent at all', () => {
    expect(getBookingTypeLabel({})).toBe('Shared');
    expect(getBookingTypeLabel(undefined)).toBe('Shared');
    expect(getBookingTypeLabel({ bookingAndTickets: {} })).toBe('Shared');
  });
});
