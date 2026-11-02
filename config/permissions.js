/**
 * Permission catalog for supplier team access.
 *
 * This is the single source of truth for:
 *   - what a custom role may contain (keys, dependencies, owner-only rules)
 *   - what the role builder renders (groups, labels, descriptions)
 *   - what the API enforces (requireTeamPermission)
 *   - what notification categories a role may see
 *
 * System role definitions stay in config/teamPermissions.js for backwards
 * compatibility. Custom roles are stored as TeamRole rows and are validated
 * against this catalog before they are written.
 */

const { TEAM_ROLE_PERMISSIONS, permissionsForRoles, toRoleArray } = require('./teamPermissions');

const OWNER_ONLY_PERMISSIONS = new Set(['team.roles.manage']);

/**
 * Permission groups are presentation metadata. `kind` tells the role builder
 * how to render the toggle, and `requires` auto-selects the minimum access a
 * capability needs to work at all.
 */
const PERMISSION_GROUPS = [
  { key: 'dashboard', label: 'Dashboard', description: 'The business overview and its widgets.' },
  { key: 'bookings', label: 'Bookings', description: 'Reservations, customer contact, money and exports.' },
  { key: 'pickup', label: 'Pickup planner', description: 'Pickup runs, stops and traveller contact details.' },
  { key: 'availability', label: 'Availability', description: 'Calendars, capacity and date overrides.' },
  { key: 'catalogue', label: 'Products', description: 'Tours, listings and special offers.' },
  { key: 'customers', label: 'Customers and chat', description: 'Customer conversations and replies.' },
  { key: 'reviews', label: 'Reviews', description: 'Public feedback and replies.' },
  { key: 'finance', label: 'Finance', description: 'Earnings, payouts, invoices and refunds.' },
  { key: 'analytics', label: 'Analytics', description: 'Business performance reporting.' },
  { key: 'settings', label: 'Settings', description: 'Business profile, notifications, tax and booking rules.' },
  { key: 'verification', label: 'Verification', description: 'KYC documents, fleet and guides.' },
  { key: 'cancellation', label: 'Cancellations', description: 'Cancellation rate and customer requests.' },
  { key: 'team', label: 'Team', description: 'Team members, roles and access.' },
  { key: 'notifications', label: 'Notifications', description: 'The member inbox and its categories.' },
  { key: 'stays', label: 'Stays', description: 'Accommodation workspace.' },
];

const PERMISSIONS = [
  // Dashboard
  { key: 'dashboard.view', group: 'dashboard', label: 'Open the dashboard', description: 'See the business overview page.', kind: 'page' },
  { key: 'dashboard.revenue.view', group: 'dashboard', label: 'Revenue chart', description: 'See gross revenue trends and monthly totals.', kind: 'data', requires: ['dashboard.view'], sensitive: true },

  // Bookings
  { key: 'bookings.view', group: 'bookings', label: 'View bookings', description: 'Open the bookings list and booking detail.', kind: 'page' },
  { key: 'bookings.manage', group: 'bookings', label: 'Manage bookings', description: 'Create, reschedule, confirm and change booking status.', kind: 'action', requires: ['bookings.view'] },
  { key: 'bookings.revenue.view', group: 'bookings', label: 'Booking revenue', description: 'See booking value, commission, payout and revenue cards.', kind: 'data', requires: ['bookings.view'], sensitive: true },
  { key: 'bookings.contact.view', group: 'bookings', label: 'Customer contact', description: 'See customer and lead-traveller email and phone.', kind: 'data', requires: ['bookings.view'], sensitive: true },
  { key: 'bookings.export', group: 'bookings', label: 'Export bookings', description: 'Download the filtered bookings CSV.', kind: 'action', requires: ['bookings.view'], sensitive: true },
  { key: 'bookings.refund.request', group: 'bookings', label: 'Request refunds', description: 'Request a customer refund on a delivered booking.', kind: 'action', requires: ['bookings.view'], sensitive: true },

  // Pickup
  { key: 'pickup.view', group: 'pickup', label: 'View pickup planner', description: 'Open pickup runs and stop lists.', kind: 'page', requires: ['bookings.view'] },
  { key: 'pickup.manage', group: 'pickup', label: 'Manage pickups', description: 'Update pickup details, reorder stops and mark pickups complete.', kind: 'action', requires: ['pickup.view'] },
  { key: 'pickup.contact.view', group: 'pickup', label: 'Pickup contact details', description: 'See traveller phone and address on pickup stops.', kind: 'data', requires: ['pickup.view'], sensitive: true },

  // Availability
  { key: 'availability.view', group: 'availability', label: 'View availability', description: 'Open the availability calendar.', kind: 'page', requires: ['tours.view'] },
  { key: 'availability.manage', group: 'availability', label: 'Manage availability', description: 'Change capacity, close dates and add overrides.', kind: 'action', requires: ['availability.view'] },

  // Catalogue
  { key: 'tours.view', group: 'catalogue', label: 'View products', description: 'Open the product list and product detail.', kind: 'page' },
  { key: 'tours.create', group: 'catalogue', label: 'Create products', description: 'Create a new tour or listing.', kind: 'action', requires: ['tours.view'] },
  { key: 'tours.update', group: 'catalogue', label: 'Edit products', description: 'Edit product content, photos and availability.', kind: 'action', requires: ['tours.view'] },
  { key: 'tours.delete', group: 'catalogue', label: 'Delete products', description: 'Delete a product.', kind: 'action', requires: ['tours.view'], sensitive: true },
  { key: 'tours.submit', group: 'catalogue', label: 'Submit for review', description: 'Submit or withdraw a product for admin review.', kind: 'action', requires: ['tours.view'] },
  { key: 'products.update', group: 'catalogue', label: 'Special offers', description: 'Create and edit special offers and promos.', kind: 'action', requires: ['tours.view'] },

  // Customers / chat
  { key: 'chat.view', group: 'customers', label: 'Open customer chat', description: 'Open the customer inbox and read conversations.', kind: 'page' },
  { key: 'chat.respond', group: 'customers', label: 'Reply to customers', description: 'Send messages in customer conversations.', kind: 'action', requires: ['chat.view'] },
  { key: 'chat.assign', group: 'customers', label: 'Assign conversations', description: 'Assign or reassign conversations to team members.', kind: 'action', requires: ['chat.view'] },

  // Reviews
  { key: 'reviews.view', group: 'reviews', label: 'View reviews', description: 'Open the reviews page.', kind: 'page' },
  { key: 'reviews.respond', group: 'reviews', label: 'Reply to reviews', description: 'Publish a supplier response to a review.', kind: 'action', requires: ['reviews.view'] },

  // Finance
  { key: 'finance.view', group: 'finance', label: 'Open finance', description: 'Open the finance hub.', kind: 'page' },
  { key: 'earnings.view', group: 'finance', label: 'View earnings', description: 'See earnings, commission and payout totals.', kind: 'data', requires: ['finance.view'], sensitive: true },
  { key: 'payouts.view', group: 'finance', label: 'View payouts', description: 'See payout requests, schedules and history.', kind: 'data', requires: ['finance.view'], sensitive: true },
  { key: 'payouts.request', group: 'finance', label: 'Request payouts', description: 'Create or cancel a payout request.', kind: 'action', requires: ['payouts.view'], sensitive: true },
  { key: 'payout-methods.view', group: 'finance', label: 'View payout methods', description: 'See saved bank, mobile money and PayPal destinations.', kind: 'data', requires: ['finance.view'], sensitive: true },
  { key: 'payout-methods.manage', group: 'finance', label: 'Manage payout methods', description: 'Add, edit or remove payout destinations.', kind: 'action', requires: ['payout-methods.view'], sensitive: true },
  { key: 'invoices.view', group: 'finance', label: 'View invoices', description: 'Open invoices and download invoice PDFs.', kind: 'data', requires: ['finance.view'], sensitive: true },
  { key: 'charges.view', group: 'finance', label: 'View charges', description: 'See supplier charges and deductions.', kind: 'data', requires: ['finance.view'], sensitive: true },
  { key: 'disputes.view', group: 'finance', label: 'View disputes', description: 'See refund disputes and their status.', kind: 'data', requires: ['finance.view'], sensitive: true },
  { key: 'refund-claims.view', group: 'finance', label: 'View refund claims', description: 'See customer refund claims.', kind: 'data', requires: ['finance.view'], sensitive: true },

  // Analytics
  { key: 'analytics.view', group: 'analytics', label: 'View analytics', description: 'Open business performance reporting.', kind: 'page' },
  { key: 'analytics.revenue.view', group: 'analytics', label: 'Analytics revenue', description: 'See revenue and money metrics in analytics.', kind: 'data', requires: ['analytics.view'], sensitive: true },

  // Settings
  { key: 'settings.access', group: 'settings', label: 'Open settings', description: 'Open the settings page.', kind: 'page' },
  { key: 'settings.profile', group: 'settings', label: 'Personal profile', description: 'Change their own name, password and session.', kind: 'action' },
  { key: 'settings.business', group: 'settings', label: 'Business profile', description: 'Edit the business name, description, logo and public details.', kind: 'action', requires: ['settings.access'] },
  { key: 'settings.notifications', group: 'settings', label: 'Own notification preferences', description: 'Change their own email and push preferences.', kind: 'action' },
  { key: 'settings.notifications.manage', group: 'settings', label: 'Business notification routing', description: 'Manage additional notification email recipients.', kind: 'action', requires: ['settings.access'], sensitive: true },
  { key: 'settings.tax', group: 'settings', label: 'Tax information', description: 'View and edit tax and compliance information.', kind: 'action', requires: ['settings.access'], sensitive: true },
  { key: 'settings.bookings', group: 'settings', label: 'Booking rules', description: 'Edit booking cutoffs and rules.', kind: 'action', requires: ['settings.access'] },

  // Verification
  { key: 'verification.view', group: 'verification', label: 'View verification', description: 'Open verification and compliance records.', kind: 'page', requires: ['settings.access'] },
  { key: 'verification.manage', group: 'verification', label: 'Manage verification', description: 'Upload documents, vehicles and guides.', kind: 'action', requires: ['verification.view'], sensitive: true },

  // Cancellation
  { key: 'cancellation.view', group: 'cancellation', label: 'View cancellations', description: 'See the cancellation rate and records.', kind: 'page' },
  { key: 'cancellation.request', group: 'cancellation', label: 'Request cancellations', description: 'Submit a cancellation request for a booking.', kind: 'action', requires: ['cancellation.view'] },

  // Team
  { key: 'team.view', group: 'team', label: 'View team', description: 'See team members and their roles.', kind: 'page', requires: ['settings.access'] },
  { key: 'team.manage', group: 'team', label: 'Manage team', description: 'Invite, remove and reassign team members.', kind: 'action', requires: ['team.view'], sensitive: true },
  { key: 'team.roles.assign', group: 'team', label: 'Assign roles', description: 'Assign existing roles to team members.', kind: 'action', requires: ['team.manage'], sensitive: true },
  { key: 'team.roles.manage', group: 'team', label: 'Manage roles', description: 'Create, edit and archive custom roles. Owner only.', kind: 'action', requires: ['team.view'], ownerOnly: true, sensitive: true },

  // Notifications
  { key: 'notifications.view', group: 'notifications', label: 'Open notifications', description: 'See their own notification inbox.', kind: 'page' },

  // Stays (existing workspace)
  { key: 'stays.view', group: 'stays', label: 'View stays', description: 'Open the accommodation workspace.', kind: 'page' },
  { key: 'stays.manage', group: 'stays', label: 'Manage stays', description: 'Create and edit accommodation properties.', kind: 'action', requires: ['stays.view'] },
  { key: 'stays.bookings', group: 'stays', label: 'Stays bookings', description: 'Manage accommodation bookings.', kind: 'action', requires: ['stays.view'] },
  { key: 'stays.availability', group: 'stays', label: 'Stays availability', description: 'Manage accommodation availability.', kind: 'action', requires: ['stays.view'] },
  { key: 'stays.rates', group: 'stays', label: 'Stays rates', description: 'Manage accommodation rates.', kind: 'action', requires: ['stays.view'] },
  { key: 'stays.offers', group: 'stays', label: 'Stays offers', description: 'Manage accommodation offers.', kind: 'action', requires: ['stays.view'] },
  { key: 'stays.reviews', group: 'stays', label: 'Stays reviews', description: 'Manage accommodation reviews.', kind: 'action', requires: ['stays.view'] },
  { key: 'stays.analytics', group: 'stays', label: 'Stays analytics', description: 'See accommodation analytics.', kind: 'data', requires: ['stays.view'], sensitive: true },
];

const PERMISSION_BY_KEY = new Map(PERMISSIONS.map((permission) => [permission.key, permission]));

const PERMISSION_KEYS = PERMISSIONS.map((permission) => permission.key);

function isKnownPermission(key) {
  return key === '*' || PERMISSION_BY_KEY.has(key);
}

function permissionMeta(key) {
  return PERMISSION_BY_KEY.get(key) || null;
}

/**
 * Expand `requires` transitively so a role can never contain a capability
 * without the page it depends on.
 */
function expandDependencies(keys) {
  const result = new Set();
  const queue = [...keys];
  while (queue.length) {
    const key = queue.shift();
    if (!key || result.has(key)) continue;
    if (!isKnownPermission(key)) continue;
    result.add(key);
    const meta = permissionMeta(key);
    for (const required of meta?.requires || []) queue.push(required);
  }
  return result;
}

/**
 * Validate and normalise a custom role permission set.
 * Returns { permissions, error }. Owner-only keys are rejected unless the
 * actor is the owner; the caller passes `allowOwnerOnly`.
 */
function normalizePermissions(input, { allowOwnerOnly = false } = {}) {
  const list = Array.isArray(input) ? input : [];
  const deduped = Array.from(new Set(list.filter((key) => typeof key === 'string').map((key) => key.trim()).filter(Boolean)));

  if (deduped.includes('*')) {
    return { error: 'The wildcard permission can only be held by the account owner' };
  }

  const unknown = deduped.filter((key) => !PERMISSION_BY_KEY.has(key));
  if (unknown.length) {
    return { error: `Unknown permission: ${unknown.join(', ')}` };
  }

  if (!allowOwnerOnly) {
    const forbidden = deduped.filter((key) => OWNER_ONLY_PERMISSIONS.has(key) || PERMISSION_BY_KEY.get(key)?.ownerOnly);
    if (forbidden.length) {
      return { error: `Only the account owner can grant: ${forbidden.join(', ')}` };
    }
  }

  return { permissions: Array.from(expandDependencies(deduped)) };
}

function hasPermissionInSet(permissions, key) {
  const list = Array.isArray(permissions) ? permissions : [];
  if (list.includes('*')) return true;
  if (list.includes(key)) return true;
  const prefix = String(key).split('.')[0];
  return list.some((permission) => permission.endsWith('*') && permission.startsWith(`${prefix}.`));
}

/**
 * A delegated manager may only assign access they already hold. The owner
 * bypasses this. This is the main privilege-escalation guard.
 */
function canGrantPermissions(actorPermissions, requestedPermissions, { isOwner = false } = {}) {
  if (isOwner) return { ok: true };
  for (const key of requestedPermissions || []) {
    if (OWNER_ONLY_PERMISSIONS.has(key) || PERMISSION_BY_KEY.get(key)?.ownerOnly) {
      return { ok: false, error: `Only the account owner can grant ${key}` };
    }
    if (!hasPermissionInSet(actorPermissions, key)) {
      return { ok: false, error: `You cannot grant ${key} because you do not have it yourself` };
    }
  }
  return { ok: true };
}

/**
 * Effective permissions for a member: system roles plus custom roles.
 * Archived custom roles are ignored by the caller before this is called.
 */
function permissionsForMember(systemRoles, customRolePermissions = []) {
  const system = permissionsForRoles(toRoleArray(systemRoles));
  if (system.includes('*')) return ['*'];
  const union = new Set(system);
  for (const list of customRolePermissions) {
    for (const key of list || []) union.add(key);
  }
  return Array.from(union);
}

function roleNamesForMember(systemRoles, customRoles = []) {
  const names = toRoleArray(systemRoles).map((role) => {
    const config = TEAM_ROLE_PERMISSIONS[role];
    return config?.label || role;
  });
  for (const role of customRoles || []) {
    if (role?.name) names.push(role.name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Notification categories
// ---------------------------------------------------------------------------

const NOTIFICATION_CATEGORIES = [
  { key: 'bookings', label: 'Bookings' },
  { key: 'payments', label: 'Payments' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'messages', label: 'Messages' },
  { key: 'cancellations', label: 'Cancellations' },
  { key: 'documents', label: 'Documents' },
  { key: 'team', label: 'Team' },
  { key: 'system', label: 'System' },
];

const NOTIFICATION_CATEGORY_KEYS = NOTIFICATION_CATEGORIES.map((category) => category.key);

// Explicit lists keep the Prisma query a simple `type: { in: [...] }`.
const NOTIFICATION_TYPES_BY_CATEGORY = {
  bookings: [
    'BOOKING_CONFIRMED', 'BOOKING_CREATED_BY_SUPPLIER', 'BOOKING_CANCELLED',
    'BOOKING_STATUS_UPDATED', 'BOOKING_MODIFIED', 'BOOKING_AWAITING_CONFIRMATION',
    'PICKUP_UPDATED',
  ],
  payments: [
    'PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'PAYMENT_COMPLETED', 'PAYMENT_ACTION_REQUIRED',
    'BOOKING_PAYMENT_FAILED', 'REFUND_ISSUED', 'REFUND_CLAIM', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED',
  ],
  payouts: [
    'PAYOUT_PROCESSED', 'PAYOUT_APPROVED', 'PAYOUT_COMPLETED', 'PAYOUT_REQUEST_SUBMITTED',
    'PAYOUT_REQUEST_APPROVED', 'PAYOUT_REQUEST_REJECTED', 'PAYOUT_SCHEDULE_UPDATED',
    'PAYOUT_REQUEST_WINDOW_OPEN',
  ],
  reviews: ['REVIEW_RECEIVED', 'REVIEW_REQUEST'],
  messages: ['NEW_MESSAGE'],
  cancellations: [
    'CANCELLATION_RATE_ALERT', 'CANCELLATION_CHOICE_REQUIRED',
    'CANCELLATION_REQUEST_APPROVED', 'CANCELLATION_REQUEST_REJECTED',
  ],
  documents: ['DOCUMENT_REJECTED', 'DOCUMENT_EXPIRY_REMINDER', 'DOCUMENT_EXPIRED', 'DOCUMENTATION_WINDOW_REMINDER'],
  team: ['TEAM_INVITE_ACCEPTED'],
  system: ['SYSTEM_ALERT', 'SUPPLIER_APPROVED', 'SUPPLIER_REJECTED', 'TOUR_SUBMITTED', 'TOUR_APPROVED', 'TOUR_FLAGGED'],
};

function notificationCategoryForType(type) {
  for (const [category, types] of Object.entries(NOTIFICATION_TYPES_BY_CATEGORY)) {
    if (types.includes(type)) return category;
  }
  return 'system';
}

function notificationTypesForCategories(categories) {
  const allowed = Array.isArray(categories) && categories.length
    ? categories.filter((category) => NOTIFICATION_CATEGORY_KEYS.includes(category))
    : NOTIFICATION_CATEGORY_KEYS;
  return allowed.flatMap((category) => NOTIFICATION_TYPES_BY_CATEGORY[category] || []);
}

function normalizeNotificationCategories(input) {
  const list = Array.isArray(input) ? input : [];
  return Array.from(new Set(list.filter((category) => NOTIFICATION_CATEGORY_KEYS.includes(category))));
}

module.exports = {
  PERMISSIONS,
  PERMISSION_BY_KEY,
  PERMISSION_KEYS,
  PERMISSION_GROUPS,
  OWNER_ONLY_PERMISSIONS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_KEYS,
  NOTIFICATION_TYPES_BY_CATEGORY,
  normalizePermissions,
  normalizeNotificationCategories,
  notificationCategoryForType,
  notificationTypesForCategories,
  hasPermissionInSet,
  canGrantPermissions,
  permissionsForMember,
  roleNamesForMember,
  expandDependencies,
  isKnownPermission,
  permissionMeta,
};
