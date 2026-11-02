const {
  normalizePermissions,
  canGrantPermissions,
  permissionsForMember,
  notificationTypesForCategories,
  notificationCategoryForType,
  hasPermissionInSet,
} = require('../../config/permissions');

describe('custom role permissions', () => {
  it('expands dependencies so a capability cannot exist without its page', () => {
    const result = normalizePermissions(['bookings.manage']);
    expect(result.error).toBeUndefined();
    expect(result.permissions).toEqual(expect.arrayContaining(['bookings.manage', 'bookings.view']));
  });

  it('rejects unknown keys', () => {
    expect(normalizePermissions(['bookings.teleport']).error).toMatch(/Unknown permission/);
  });

  it('rejects the wildcard even for a custom role', () => {
    expect(normalizePermissions(['*']).error).toMatch(/wildcard/i);
  });

  it('rejects owner-only capabilities', () => {
    expect(normalizePermissions(['team.roles.manage']).error).toMatch(/owner/i);
  });

  it('lets the owner grant anything, and stops a delegated manager escalating', () => {
    expect(canGrantPermissions([], ['bookings.revenue.view'], { isOwner: true }).ok).toBe(true);
    expect(canGrantPermissions(['bookings.view'], ['bookings.revenue.view']).ok).toBe(false);
    expect(canGrantPermissions(['bookings.view', 'bookings.revenue.view'], ['bookings.revenue.view']).ok).toBe(true);
  });

  it('unions system roles and custom roles', () => {
    const permissions = permissionsForMember(['support'], [['bookings.revenue.view']]);
    expect(permissions).toEqual(expect.arrayContaining(['chat.view', 'bookings.revenue.view']));
  });

  it('recognises wildcard prefixes', () => {
    expect(hasPermissionInSet(['bookings.*'], 'bookings.revenue.view')).toBe(true);
    expect(hasPermissionInSet(['bookings.view'], 'bookings.revenue.view')).toBe(false);
  });

  it('maps notification types to categories and filters them', () => {
    expect(notificationCategoryForType('BOOKING_CONFIRMED')).toBe('bookings');
    expect(notificationCategoryForType('PAYOUT_APPROVED')).toBe('payouts');
    expect(notificationCategoryForType('NEW_MESSAGE')).toBe('messages');
    expect(notificationTypesForCategories(['bookings'])).toContain('BOOKING_CONFIRMED');
    expect(notificationTypesForCategories(['bookings'])).not.toContain('NEW_MESSAGE');
  });
});
