const { formatTravelers } = require('../../src/core/services/emailFormatting');

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
