/**
 * Team roles and the permissions they grant.
 *
 * A team member can hold up to MAX_TEAM_ROLES roles at once; the effective
 * permissions are the union of them (so Editor + Finance can manage tours *and*
 * see payouts). `admin` already implies every permission, so combining it with
 * anything else is rejected rather than silently redundant.
 *
 * Permission families:
 *   tours.*, bookings.*, products.*  the catalogue and the bookings
 *   chat.*, reviews.*                 customer conversations and feedback
 *   earnings.*, payouts.*, payout-methods.*  money
 *   analytics.view                    business performance reporting
 *   settings.business                 business profile + logo (admin, editor)
 *   settings.tax                      tax information (admin, finance)
 *   settings.manage                   team, notification routing and KYC
 *                                    documents (admin only)
 *
 * This module is the single source of truth: the middleware, the controllers,
 * the invite email and the dashboards all read from here.
 */

const TEAM_ROLE_PERMISSIONS = {
  admin: {
    label: 'Admin',
    description: 'Full access to all supplier features',
    summary: 'Full access — team, tours, bookings, payouts and settings',
    permissions: ['*'],
  },
  editor: {
    label: 'Editor',
    description: 'Manage tours, bookings, and products',
    summary: 'Manage tours, bookings and products',
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
      'analytics.view',
      'settings.business',
    ],
  },
  finance: {
    label: 'Finance',
    description: 'View earnings and manage payouts',
    summary: 'See earnings, payouts and payout methods',
    permissions: [
      'earnings.view',
      'payouts.view',
      'payouts.request',
      'payout-methods.view',
      'payout-methods.manage',
      'analytics.view',
      'settings.tax',
    ],
  },
  support: {
    label: 'Support',
    description: 'Handle chat and reviews',
    summary: 'Handle customer chat and reviews',
    permissions: [
      'chat.view',
      'chat.respond',
      'reviews.view',
      'reviews.respond',
    ],
  },
};

const VALID_TEAM_ROLES = Object.keys(TEAM_ROLE_PERMISSIONS);

/** How many roles one team member may hold at the same time. */
const MAX_TEAM_ROLES = parseInt(process.env.MAX_TEAM_ROLES, 10) || 2;

const TEAM_ROLE_LABELS = Object.fromEntries(
  VALID_TEAM_ROLES.map((role) => [role, TEAM_ROLE_PERMISSIONS[role].label]),
);

const TEAM_ROLE_SUMMARIES = Object.fromEntries(
  VALID_TEAM_ROLES.map((role) => [role, TEAM_ROLE_PERMISSIONS[role].summary]),
);

/** Normalise anything role-shaped into an array of valid roles. */
function toRoleArray(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  return list
    .filter((role) => typeof role === 'string')
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Validate a member's roles.
 *
 * Accepts the new `roles` array and the legacy `role` string so older clients
 * keep working. Returns { roles } or { error } with a user-facing message.
 */
function normalizeTeamRoles({ roles, role } = {}) {
  const list = toRoleArray(roles !== undefined && roles !== null ? roles : role);
  const unique = Array.from(new Set(list));

  if (unique.length === 0) {
    return { error: 'Select at least one role' };
  }

  const invalid = unique.filter((value) => !VALID_TEAM_ROLES.includes(value));
  if (invalid.length) {
    return { error: `Invalid role. Must be one of: ${VALID_TEAM_ROLES.join(', ')}` };
  }

  if (unique.length > MAX_TEAM_ROLES) {
    return { error: `A team member can hold at most ${MAX_TEAM_ROLES} roles` };
  }

  if (unique.includes('admin') && unique.length > 1) {
    return { error: 'Admin already includes every permission, so it cannot be combined with other roles' };
  }

  // Keep a stable, predictable order (admin > editor > finance > support).
  const ordered = VALID_TEAM_ROLES.filter((value) => unique.includes(value));
  return { roles: ordered };
}

/** Union of the permissions granted by every role in the list. */
function permissionsForRoles(roles) {
  const list = toRoleArray(roles);
  const permissions = new Set();
  let wildcard = false;

  for (const role of list) {
    const config = TEAM_ROLE_PERMISSIONS[role];
    if (!config) continue;
    for (const permission of config.permissions) {
      if (permission === '*') wildcard = true;
      else permissions.add(permission);
    }
  }

  return wildcard ? ['*'] : Array.from(permissions);
}

/**
 * Permission check that understands one role or several.
 * `hasTeamPermission(['editor','finance'], 'payouts.view') === true`
 */
function hasTeamPermission(rolesOrRole, permission) {
  const list = toRoleArray(rolesOrRole);
  for (const role of list) {
    const roleConfig = TEAM_ROLE_PERMISSIONS[role];
    if (!roleConfig) continue;
    if (roleConfig.permissions.includes('*')) return true;
    if (roleConfig.permissions.includes(permission)) return true;
    const prefix = permission.split('.')[0];
    if (roleConfig.permissions.some((p) => p.endsWith('*') && p.startsWith(prefix))) return true;
  }
  return false;
}

/** "Editor + Finance" — used in emails, notifications and audit metadata. */
function describeRoles(roles) {
  return toRoleArray(roles)
    .map((role) => TEAM_ROLE_LABELS[role] || role)
    .join(' + ');
}

module.exports = {
  TEAM_ROLE_PERMISSIONS,
  TEAM_ROLE_LABELS,
  TEAM_ROLE_SUMMARIES,
  VALID_TEAM_ROLES,
  MAX_TEAM_ROLES,
  permissionsForRoles,
  hasTeamPermission,
  describeRoles,
  normalizeTeamRoles,
  toRoleArray,
};
