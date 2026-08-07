/**
 * Sync Admin RBAC permissions to the database.
 *
 * ADD-ONLY: creates missing permissions and grants missing role → permission
 * links. It never removes permissions or links, and it never touches users,
 * roles themselves, or any non-RBAC data. Safe to run against production.
 *
 * Permission keys / role definitions mirror prisma/seed.js so the two stay
 * consistent. Roles listed here that don't exist yet are skipped (they are
 * NOT created) to keep the script purely additive.
 *
 * Usage (set DATABASE_URL first):
 *   $env:DATABASE_URL="postgresql://..." ; node scripts/syncAdminPermissions.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const PERMISSIONS = [
  { key: 'dashboard.*', name: 'Full Dashboard Access', description: 'Access to dashboard overview and notifications', category: 'Dashboard' },
  { key: 'dashboard.bookings', name: 'Dashboard Bookings', description: 'View dashboard booking widgets', category: 'Dashboard' },
  { key: 'dashboard.revenue', name: 'Dashboard Revenue', description: 'View dashboard revenue widgets', category: 'Dashboard' },
  { key: 'analytics.view', name: 'View Analytics', description: 'View revenue, search, and cart analytics pages', category: 'Analytics' },
  { key: 'users.view', name: 'View Users', description: 'View user growth, CLV, and conversion funnel', category: 'Users' },
  { key: 'users.delete', name: 'Delete Users', description: 'Permanently delete user accounts', category: 'Users' },
  { key: 'tours.view', name: 'View Tours', description: 'View tour performance and details', category: 'Tours' },
  { key: 'tours.approve', name: 'Approve Tours', description: 'Approve or flag tour submissions in the moderation queue', category: 'Tours' },
  { key: 'suppliers.view', name: 'View Suppliers', description: 'View supplier applications and profiles', category: 'Suppliers' },
  { key: 'suppliers.approve', name: 'Approve Suppliers', description: 'Approve or reject supplier applications', category: 'Suppliers' },
  { key: 'suppliers.suspend', name: 'Suspend Suppliers', description: 'Suspend or activate supplier accounts', category: 'Suppliers' },
  { key: 'bookings.view', name: 'View Bookings', description: 'View booking list and details', category: 'Bookings' },
  { key: 'bookings.confirm-payment', name: 'Confirm Payment', description: 'Manually confirm payment for a booking', category: 'Bookings' },
  { key: 'reviews.view', name: 'View Reviews', description: 'View pending reviews for moderation', category: 'Reviews' },
  { key: 'reviews.moderate', name: 'Moderate Reviews', description: 'Approve or reject customer reviews', category: 'Reviews' },
  { key: 'payouts.view', name: 'View Payouts', description: 'View payout list and summary', category: 'Finance' },
  { key: 'payouts.export', name: 'Export Payouts', description: 'Export payout data to CSV/Excel', category: 'Finance' },
  { key: 'payouts.approve', name: 'Approve Payouts', description: 'Approve and release supplier payouts', category: 'Finance' },
  { key: 'payout-methods.view', name: 'View Payout Methods', description: 'View supplier payout methods', category: 'Finance' },
  { key: 'payout-methods.verify', name: 'Verify Payout Methods', description: 'Verify supplier payout method details', category: 'Finance' },
  { key: 'chat.suppliers', name: 'Chat — Suppliers', description: 'Access supplier chat conversations', category: 'Chat' },
  { key: 'chat.customers', name: 'Chat — Customers', description: 'Access customer chat conversations', category: 'Chat' },
  { key: 'chat.expedition', name: 'Chat — Expedition', description: 'Access expedition chat conversations', category: 'Chat' },
  { key: 'settings.access', name: 'Access Settings', description: 'View platform settings page', category: 'Settings' },
  { key: 'roles.manage', name: 'Manage Roles', description: 'Create, edit, and delete admin roles', category: 'Admin' },
  { key: 'audit.view', name: 'View Audit Log', description: 'View and export system audit logs', category: 'Admin' },
  { key: 'notifications.view', name: 'View Notifications', description: 'View, acknowledge, and manage admin notification feed', category: 'Notifications' },
  { key: 'blog.manage', name: 'Manage Blog', description: 'Create, edit, publish, and delete blog articles', category: 'Blog' },
];

const ROLE_DEFINITIONS = [
  { name: 'super_admin', permissionKeys: PERMISSIONS.map((p) => p.key) },
  {
    name: 'operations_admin',
    permissionKeys: [
      'dashboard.*', 'dashboard.bookings', 'dashboard.revenue', 'analytics.view',
      'suppliers.view', 'suppliers.approve', 'suppliers.suspend', 'tours.view',
      'tours.approve', 'bookings.view', 'bookings.confirm-payment', 'reviews.view', 'reviews.moderate',
      'chat.suppliers', 'chat.customers', 'chat.expedition', 'notifications.view',
    ],
  },
  {
    name: 'finance_admin',
    permissionKeys: [
      'dashboard.*', 'dashboard.revenue', 'analytics.view', 'bookings.view',
      'bookings.confirm-payment', 'payouts.view', 'payouts.export', 'payouts.approve',
      'payout-methods.view', 'payout-methods.verify', 'notifications.view',
    ],
  },
  {
    name: 'support_admin',
    permissionKeys: [
      'dashboard.*', 'users.view', 'bookings.view', 'reviews.view',
      'reviews.moderate', 'chat.suppliers', 'chat.customers', 'chat.expedition', 'notifications.view',
    ],
  },
  {
    name: 'analytics_viewer',
    permissionKeys: [
      'dashboard.*', 'dashboard.bookings', 'dashboard.revenue', 'analytics.view',
      'users.view', 'tours.view', 'bookings.view', 'suppliers.view',
      'reviews.view', 'payouts.view', 'payout-methods.view', 'notifications.view',
    ],
  },
  {
    name: 'content_editor',
    permissionKeys: [
      'dashboard.*', 'blog.manage', 'reviews.view', 'notifications.view',
    ],
  },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required — set it before running this script.');
  }

  console.log('=== Admin RBAC permission sync (add-only) ===\n');

  let addedPerms = 0;
  for (const perm of PERMISSIONS) {
    await prisma.adminPermission.upsert({
      where: { key: perm.key },
      update: { name: perm.name, description: perm.description, category: perm.category },
      create: { key: perm.key, name: perm.name, description: perm.description, category: perm.category },
    });
    addedPerms++;
  }
  console.log(`Permissions: ${addedPerms}/${PERMISSIONS.length} ensured`);

  for (const def of ROLE_DEFINITIONS) {
    const role = await prisma.adminRole.findUnique({ where: { name: def.name } });
    if (!role) {
      console.log(`  Role "${def.name}": skipped (does not exist)`);
      continue;
    }

    const perms = await prisma.adminPermission.findMany({
      where: { key: { in: def.permissionKeys } },
    });
    const wantIds = new Set(perms.map((p) => p.id));

    const existing = await prisma.adminRolePermission.findMany({
      where: { roleId: role.id },
    });
    const haveIds = new Set(existing.map((l) => l.permissionId));

    const toAdd = [...wantIds].filter((pid) => !haveIds.has(pid));
    if (toAdd.length > 0) {
      await prisma.adminRolePermission.createMany({
        data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })),
      });
    }
    console.log(`  ${def.name}: ${haveIds.size} → ${haveIds.size + toAdd.length} permissions (+${toAdd.length})`);
  }

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
