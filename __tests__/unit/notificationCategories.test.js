const { CATEGORY_BY_TYPE, categoryForType } = require('../../src/core/services/notificationCategories');

describe('notificationCategories', () => {
  const CATEGORIES = ['bookings', 'reviews', 'payments', 'systemAlerts'];

  it('maps every entry to a known category', () => {
    for (const [type, category] of Object.entries(CATEGORY_BY_TYPE)) {
      expect(CATEGORIES).toContain(category);
      expect(type).toBe(type.toUpperCase());
    }
  });

  it('routes the headline notification types correctly', () => {
    expect(categoryForType('BOOKING_CONFIRMED')).toBe('bookings');
    expect(categoryForType('REVIEW_RECEIVED')).toBe('reviews');
    expect(categoryForType('PAYOUT_COMPLETED')).toBe('payments');
    expect(categoryForType('SUPPLIER_APPROVED')).toBe('systemAlerts');
  });

  it('falls back to systemAlerts for unknown types', () => {
    expect(categoryForType('SOMETHING_NEW')).toBe('systemAlerts');
    expect(categoryForType(undefined)).toBe('systemAlerts');
  });
});
