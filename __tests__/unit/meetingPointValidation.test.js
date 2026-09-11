/**
 * Unit tests for the meeting-point handling that unblocked submit-for-review:
 * the builder stores `meetingPoints[]` (plural) while legacy payloads use the
 * singular `meetingPoint`.
 */

const { firstMeetingPoint } = require('../../utils/productToTour');
const { validateTourForReview } = require('../../controllers/tourController');

const validPoint = { name: 'Tamale Airport, Airport Road', address: 'Tamale Airport, Airport Road, Yilonayili, Ghana' };

function baseTour(overrides = {}) {
  return {
    title: 'The North Safari',
    description: 'A sufficiently long description for validation.',
    photos: ['https://example.com/a.png'],
    categorization: { category: 'tour' },
    productContent: {
      writingLanguage: 'English',
      highlights: ['One'],
      locations: [{ name: 'Mole National Park' }],
      meetingMode: 'meeting_point',
    },
    schedulesAndPricing: {
      pricingSchedules: {
        currency: 'USD',
        schedules: [{ name: 'Default', prices: [{ ageGroup: 'Adult', retailPrice: 100 }] }],
      },
    },
    ...overrides,
  };
}

describe('firstMeetingPoint', () => {
  it('prefers the singular when present', () => {
    expect(firstMeetingPoint({ meetingPoint: validPoint, meetingPoints: [] })).toEqual(validPoint);
  });

  it('falls back to the first valid plural entry', () => {
    expect(firstMeetingPoint({ meetingPoint: null, meetingPoints: [{ name: '', address: '' }, validPoint] })).toEqual(validPoint);
  });

  it('returns null when nothing usable exists', () => {
    expect(firstMeetingPoint({ meetingPoint: null, meetingPoints: [] })).toBeNull();
    expect(firstMeetingPoint({})).toBeNull();
    expect(firstMeetingPoint(null)).toBeNull();
  });
});

describe('validateTourForReview meeting point', () => {
  it('accepts a meeting point supplied only via bookingAndTickets.meetingPoints[]', () => {
    const tour = baseTour({
      bookingAndTickets: { meetingPoints: [validPoint] },
    });
    const errors = validateTourForReview(tour);
    expect(errors).not.toContain('A meeting point (name and address) is required');
  });

  it('accepts a meeting point supplied only via productContent.meetingPoints[]', () => {
    const tour = baseTour();
    tour.productContent.meetingPoints = [validPoint];
    const errors = validateTourForReview(tour);
    expect(errors).not.toContain('A meeting point (name and address) is required');
  });

  it('accepts the legacy singular meetingPoint', () => {
    const tour = baseTour({ bookingAndTickets: { meetingPoint: validPoint } });
    const errors = validateTourForReview(tour);
    expect(errors).not.toContain('A meeting point (name and address) is required');
  });

  it('still rejects when meetingMode is meeting_point but no point exists', () => {
    const errors = validateTourForReview(baseTour({ bookingAndTickets: { meetingPoints: [] } }));
    expect(errors).toContain('A meeting point (name and address) is required');
  });

  it('does not require a meeting point for pickup/none modes', () => {
    const pickup = baseTour();
    pickup.productContent.meetingMode = 'pickup';
    expect(validateTourForReview(pickup)).not.toContain('A meeting point (name and address) is required');

    const none = baseTour();
    none.productContent.meetingMode = 'none';
    expect(validateTourForReview(none)).not.toContain('A meeting point (name and address) is required');
  });
});
