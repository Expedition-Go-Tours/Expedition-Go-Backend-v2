const TEAM_ROLE_PERMISSIONS = {
  admin: {
    description: 'Full access to all supplier features',
    permissions: ['*'],
  },
  editor: {
    description: 'Manage tours, bookings, and products',
    permissions: [
      'tours.view',
      'tours.create',
      'tours.update',
      'tours.delete',
      'bookings.view',
      'bookings.manage',
      'products.view',
      'products.create',
      'products.update',
      'products.delete',
    ],
  },
  finance: {
    description: 'View earnings and manage payouts',
    permissions: [
      'earnings.view',
      'payouts.view',
      'payouts.request',
      'payout-methods.view',
      'payout-methods.manage',
    ],
  },
  support: {
    description: 'Handle chat and reviews',
    permissions: [
      'chat.view',
      'chat.respond',
      'reviews.view',
      'reviews.respond',
    ],
  },
};

const VALID_TEAM_ROLES = Object.keys(TEAM_ROLE_PERMISSIONS);

function hasTeamPermission(role, permission) {
  const roleConfig = TEAM_ROLE_PERMISSIONS[role];
  if (!roleConfig) return false;
  if (roleConfig.permissions.includes('*')) return true;
  if (roleConfig.permissions.includes(permission)) return true;
  const prefix = permission.split('.')[0];
  return roleConfig.permissions.some((p) => p.endsWith('*') && p.startsWith(prefix));
}

module.exports = { TEAM_ROLE_PERMISSIONS, VALID_TEAM_ROLES, hasTeamPermission };
