/**
 * Admin-notification visibility: the feed/unread-badge/stats where-clause must
 * include every AdminNotificationType enum value that admins should see, gated
 * by role. Regression guard for the REFUND_CLAIM + BOOKING_MODIFIED bells being
 * silently filtered because they were missing from ADMIN_NOTIFICATION_TYPES.
 */

const { buildPermissionWhere } = require('../../controllers/adminNotificationController');

function visibleTypes(permissionKeys) {
  const where = buildPermissionWhere(permissionKeys);
  const types = new Set();
  for (const clause of where.OR || []) {
    if (clause.type && typeof clause.type === 'string') types.add(clause.type);
    else if (clause.type && Array.isArray(clause.type.in)) {
      for (const t of clause.type.in) types.add(t);
    }
  }
  return types;
}

describe('adminNotificationController.buildPermissionWhere', () => {
  it('shows REFUND_CLAIM to finance admins (payouts.view)', () => {
    const types = visibleTypes(['notifications.view', 'payouts.view', 'payouts.approve']);
    expect(types.has('REFUND_CLAIM')).toBe(true);
  });

  it('hides REFUND_CLAIM from admins without finance permissions', () => {
    const types = visibleTypes(['notifications.view', 'suppliers.view', 'suppliers.approve']);
    expect(types.has('REFUND_CLAIM')).toBe(false);
  });

  it('shows BOOKING_MODIFIED to booking-scoped admins', () => {
    const types = visibleTypes(['bookings.view', 'dashboard.*']);
    expect(types.has('BOOKING_MODIFIED')).toBe(true);
  });

  it('keeps ungated REFUND_REQUEST visible to every admin', () => {
    const types = visibleTypes([]);
    expect(types.has('REFUND_REQUEST')).toBe(true);
  });

  it('shows only ungated system types to a role with unrelated permissions', () => {
    const types = visibleTypes(['users.view']);
    expect(types.has('SYSTEM_ALERT')).toBe(true);
    expect(types.has('REFUND_CLAIM')).toBe(false);
    expect(types.has('BOOKING_MODIFIED')).toBe(false);
    expect(types.has('PAYOUT_NEEDS_APPROVAL')).toBe(false);
  });
});
