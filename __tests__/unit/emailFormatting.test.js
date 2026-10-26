const { formatTravelers, getBookingTypeLabel, formatCompactDate, formatDateTime, formatCardBrand, formatPaymentMethodLabel, emailPhotoUrl, HERO_TRANSFORM, CARD_TRANSFORM } = require('../../src/core/services/emailFormatting');

/**
 * formatCompactDate — the "Reserved 9 Oct 2026" reference-bar form.
 * Fixed day-month-year order regardless of host locale.
 */
describe('formatCompactDate', () => {
  it('renders day month-abbrev year', () => {
    expect(formatCompactDate(new Date('2026-10-09T12:00:00Z'))).toBe('9 Oct 2026');
  });

  it('does not zero-pad the day', () => {
    expect(formatCompactDate(new Date('2026-01-05T00:00:00Z'))).toBe('5 Jan 2026');
  });

  it('renders the UTC day for a late-UTC timestamp', () => {
    expect(formatCompactDate(new Date('2026-10-09T23:30:00Z'))).toBe('9 Oct 2026');
  });

  it('returns empty for missing or invalid input', () => {
    expect(formatCompactDate(null)).toBe('');
    expect(formatCompactDate(undefined)).toBe('');
    expect(formatCompactDate('nonsense')).toBe('');
  });
});

describe('formatCardBrand', () => {
  it('uses the names customers recognise', () => {
    expect(formatCardBrand('visa')).toBe('Visa');
    expect(formatCardBrand('mastercard')).toBe('Mastercard');
    expect(formatCardBrand('amex')).toBe('American Express');
    expect(formatCardBrand('diners')).toBe('Diners Club');
  });

  it('title-cases an unknown brand rather than dropping it', () => {
    expect(formatCardBrand('brand_new')).toBe('Brand New');
  });

  it('returns empty for nothing', () => {
    expect(formatCardBrand(null)).toBe('');
    expect(formatCardBrand(undefined)).toBe('');
  });
});

describe('formatPaymentMethodLabel', () => {
  it('renders the statement-line form from brand + last4', () => {
    expect(formatPaymentMethodLabel({ brand: 'visa', last4: '4242' })).toBe('Visa •••• 4242');
  });

  it('degrades to last4 only when the brand is unknown', () => {
    expect(formatPaymentMethodLabel({ brand: null, last4: '4242' })).toBe('•••• 4242');
  });

  it('degrades to brand only when last4 is missing', () => {
    expect(formatPaymentMethodLabel({ brand: 'mastercard', last4: null })).toBe('Mastercard');
  });

  it('returns empty when neither half is known (templates hide the row)', () => {
    expect(formatPaymentMethodLabel({})).toBe('');
    expect(formatPaymentMethodLabel()).toBe('');
  });
});

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

/**
 * emailPhotoUrl — delivery sizing for photos embedded in emails.
 *
 * Cover photos are unoptimized uploads (measured 100KB-4MB, PNG included) and
 * mail clients download full bytes on open (Gmail app on mobile over
 * cellular), so every photo must request only the box it renders in. These
 * rules pin the wire format; the send-path behaviour is asserted in
 * bookingConfirmedEmail.test.js.
 */
describe('emailPhotoUrl', () => {
  const T = 'c_fill,g_auto,w_240,h_240,f_jpg,q_auto';

  it('inserts the transform after /upload/ on a versioned Cloudinary source', () => {
    expect(
      emailPhotoUrl('https://res.cloudinary.com/dfpagrtoy/image/upload/v1790968229/user-photos/a.jpg', T),
    ).toBe('https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,g_auto,w_240,h_240,f_jpg,q_auto/v1790968229/user-photos/a.jpg');
  });

  it('transforms version-less Cloudinary folder URLs too', () => {
    expect(
      emailPhotoUrl('https://res.cloudinary.com/dfpagrtoy/image/upload/user-photos/a.jpg', T),
    ).toBe('https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,g_auto,w_240,h_240,f_jpg,q_auto/user-photos/a.jpg');
  });

  it('leaves a URL that already carries a transformation untouched', () => {
    const src = 'https://res.cloudinary.com/dfpagrtoy/image/upload/w_100,c_fill/v1/x.jpg';
    expect(emailPhotoUrl(src, T)).toBe(src);
  });

  it('leaves signed (query-string) URLs untouched', () => {
    const src = 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1/x.jpg?s=abc123';
    expect(emailPhotoUrl(src, T)).toBe(src);
  });

  it('passes non-Cloudinary hosts through untouched', () => {
    const src = 'https://firebasestorage.googleapis.com/v0/b/x/o/img.png?alt=media';
    expect(emailPhotoUrl(src, T)).toBe(src);
    const google = 'https://lh3.googleusercontent.com/a/x=s96-c';
    expect(emailPhotoUrl(google, T)).toBe(google);
  });

  it('passes a Cloudinary URL without the upload marker through untouched', () => {
    const src = 'https://res.cloudinary.com/dfpagrtoy/demo/other/x.jpg';
    expect(emailPhotoUrl(src, T)).toBe(src);
  });

  it('returns empty for missing or non-string input', () => {
    expect(emailPhotoUrl('', T)).toBe('');
    expect(emailPhotoUrl(null, T)).toBe('');
    expect(emailPhotoUrl(undefined, T)).toBe('');
    expect(emailPhotoUrl(42, T)).toBe('');
    expect(emailPhotoUrl('   ', T)).toBe('');
  });

  it('requests a universal, quality-adapted encoding in both email specs', () => {
    // f_jpg (never f_auto): WebP breaks in Outlook and in proxy caches.
    // q_auto: Cloudinary's fixed default quality ships multi-MB PNG heroes.
    for (const spec of [HERO_TRANSFORM, CARD_TRANSFORM]) {
      expect(spec).toContain('f_jpg');
      expect(spec).toContain('q_auto');
      expect(spec).not.toContain('f_auto');
      expect(spec).toContain('c_fill');
      expect(spec).toContain('g_auto');
    }
  });
});

/**
 * formatDateTime - the deadline label customers read to the minute.
 * The zone is part of the value: every caller formats in UTC, and a customer
 * in Amsterdam reading "11:38 AM" is an hour away from her real cutoff.
 */
describe('formatDateTime', () => {
  it('labels the zone so a deadline is never an hour out', () => {
    expect(formatDateTime(new Date('2026-10-27T11:38:00Z'))).toBe(
      'October 27, 2026 at 11:38 AM UTC'
    );
  });

  it('keeps a caller-supplied zone explicit', () => {
    expect(formatDateTime(new Date('2026-10-27T11:38:00Z'), 'Africa/Accra')).toBe(
      'October 27, 2026 at 11:38 AM Africa/Accra'
    );
  });

  it('renders the UTC evening, not the host locale day', () => {
    expect(formatDateTime(new Date('2026-10-27T23:30:00Z'))).toBe(
      'October 27, 2026 at 11:30 PM UTC'
    );
  });

  it('returns empty for missing or invalid input', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime('nonsense')).toBe('');
  });
});
