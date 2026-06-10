/**
 * Seed Script — Admin Roles, Permissions & System Configuration
 *
 * Creates default admin permissions, roles, and system config values.
 * Run: node scripts/seedAdminConfig.js
 *
 * Safe to run multiple times — uses upsert for all operations.
 */

const prisma = require('../utils/prismaClient');

const PERMISSIONS = [
  // Dashboard — each section is individually controllable
  { key: 'dashboard.revenue', name: 'Revenue KPIs', category: 'Dashboard', description: 'View revenue today and period comparison cards' },
  { key: 'dashboard.bookings', name: 'Booking KPIs & Chart', category: 'Dashboard', description: 'View bookings today KPI and booking status pie chart' },
  { key: 'dashboard.users', name: 'User KPIs', category: 'Dashboard', description: 'View new signups and active users KPIs' },
  { key: 'dashboard.top_suppliers', name: 'Top Suppliers', category: 'Dashboard', description: 'View top suppliers by revenue' },
  { key: 'dashboard.top_tours', name: 'Top Tours', category: 'Dashboard', description: 'View top tours by revenue' },
  { key: 'dashboard.recent_activity', name: 'Recent Activity', category: 'Dashboard', description: 'View recent platform activity feed' },
  { key: 'dashboard.payout_summary', name: 'Payout Summary', category: 'Dashboard', description: 'View pending payouts KPI and payout summary section' },
  // Analytics
  { key: 'analytics.view', name: 'View Analytics', category: 'Analytics', description: 'View revenue, user growth, funnel, and CLV charts' },
  // Suppliers
  { key: 'suppliers.view', name: 'View Suppliers', category: 'Suppliers', description: 'View supplier list and details' },
  { key: 'suppliers.approve', name: 'Approve/Reject Applications', category: 'Suppliers', description: 'Review and approve/reject supplier applications' },
  { key: 'suppliers.suspend', name: 'Suspend/Reactivate', category: 'Suppliers', description: 'Suspend or reactivate suppliers' },
  { key: 'suppliers.delete', name: 'Delete Suppliers', category: 'Suppliers', description: 'Delete supplier accounts' },
  // Payouts
  { key: 'payouts.view', name: 'View Payouts', category: 'Finance', description: 'View payout list and summaries' },
  { key: 'payouts.approve', name: 'Approve/Release Payouts', category: 'Finance', description: 'Approve, release, or fail payouts' },
  { key: 'payouts.export', name: 'Export Payouts', category: 'Finance', description: 'Export payout data to CSV' },
  { key: 'payout-methods.view', name: 'View Payout Methods', category: 'Finance', description: 'View supplier payout methods' },
  { key: 'payout-methods.verify', name: 'Verify Payout Methods', category: 'Finance', description: 'Verify supplier payout methods' },
  // Reviews
  { key: 'reviews.view', name: 'View Reviews', category: 'Reviews', description: 'View all reviews' },
  { key: 'reviews.moderate', name: 'Moderate Reviews', category: 'Reviews', description: 'Approve, reject, or flag reviews' },
  // Tours
  { key: 'tours.view', name: 'View Tours', category: 'Tours', description: 'View tour list and details' },
  { key: 'tours.manage', name: 'Manage Tours', category: 'Tours', description: 'Edit, archive, or delete tours' },
  // Users
  { key: 'users.view', name: 'View Users', category: 'Users', description: 'View platform users' },
  { key: 'users.delete', name: 'Delete Users', category: 'Users', description: 'Delete user accounts' },
  // Chat
  { key: 'chat.suppliers', name: 'Supplier Messages', category: 'Chat', description: 'Access supplier chat conversations' },
  { key: 'chat.customers', name: 'Customer Support', category: 'Chat', description: 'Access customer support conversations' },
  // Settings
  { key: 'settings.access', name: 'Access Settings', category: 'Settings', description: 'Access the admin settings page' },
  { key: 'settings.manage', name: 'Manage Settings', category: 'Settings', description: 'Update platform-wide settings' },
  { key: 'roles.manage', name: 'Manage Roles & Permissions', category: 'Settings', description: 'Create, edit, and delete admin roles and permissions' },
];

const ROLES = {
  super_admin: {
    name: 'super_admin',
    description: 'Full access to all platform features and settings',
    isSystem: true,
    isDefault: false,
    permissions: PERMISSIONS.map((p) => p.key),
  },
  finance_admin: {
    name: 'finance_admin',
    description: 'Manage payouts, commission settings, and financial reports',
    isSystem: false,
    isDefault: false,
    permissions: [
      'dashboard.revenue',
      'dashboard.bookings',
      'dashboard.users',
      'dashboard.payout_summary',
      'analytics.view',
      'payouts.view',
      'payouts.approve',
      'payouts.export',
      'payout-methods.view',
      'payout-methods.verify',
      'settings.access',
    ],
  },
  support_admin: {
    name: 'support_admin',
    description: 'Handle supplier applications, reviews, and customer inquiries',
    isSystem: false,
    isDefault: false,
    permissions: [
      'dashboard.bookings',
      'dashboard.users',
      'dashboard.top_suppliers',
      'dashboard.recent_activity',
      'suppliers.view',
      'suppliers.approve',
      'reviews.view',
      'reviews.moderate',
      'chat.suppliers',
      'chat.customers',
      'users.view',
      'tours.view',
    ],
  },
  content_admin: {
    name: 'content_admin',
    description: 'Manage tours, reviews, and content moderation',
    isSystem: false,
    isDefault: false,
    permissions: [
      'dashboard.bookings',
      'dashboard.users',
      'dashboard.top_tours',
      'dashboard.recent_activity',
      'analytics.view',
      'tours.view',
      'tours.manage',
      'reviews.view',
      'reviews.moderate',
    ],
  },
  read_only_admin: {
    name: 'read_only_admin',
    description: 'View-only access to all platform data',
    isSystem: false,
    isDefault: false,
    permissions: [
      'dashboard.revenue',
      'dashboard.bookings',
      'dashboard.users',
      'dashboard.top_suppliers',
      'dashboard.top_tours',
      'dashboard.recent_activity',
      'dashboard.payout_summary',
      'analytics.view',
      'suppliers.view',
      'tours.view',
      'reviews.view',
      'payouts.view',
      'users.view',
    ],
  },
};

const SYSTEM_CONFIG = {
  'platform.name': { value: 'TravioAfrica', description: 'Platform display name' },
  'platform.support_email': { value: 'support@travioafrica.com', description: 'Support email address' },
  'platform.support_phone': { value: '', description: 'Support phone number' },
  'platform.currency': { value: 'USD', description: 'Default platform currency' },
  'platform.timezone': { value: 'UTC', description: 'Default platform timezone' },
  'commission.default_rate': { value: 15.0, description: 'Default commission percentage for bookings' },
  'commission.platform_fee': { value: 2.50, description: 'Fixed platform fee per booking' },
  'payout.min_threshold': { value: 50.00, description: 'Minimum payout threshold in platform currency' },
  'payout.schedule': { value: 'weekly', description: 'Payout processing schedule: weekly, biweekly, monthly' },
  'booking.min_advance_hours': { value: 24, description: 'Minimum hours before tour to allow booking' },
  'booking.max_advance_days': { value: 365, description: 'Maximum days in advance for booking' },
  'booking.auto_cancel_hours': { value: 48, description: 'Hours after which pending bookings auto-cancel' },
  'booking.max_travelers': { value: 50, description: 'Maximum travelers per booking' },
  'system.maintenance_mode': { value: false, description: 'Enable/disable platform-wide maintenance mode' },
};

async function seed() {
  console.log('Seeding admin permissions...');
  const permissionMap = {};
  for (const perm of PERMISSIONS) {
    const created = await prisma.adminPermission.upsert({
      where: { key: perm.key },
      update: { name: perm.name, description: perm.description, category: perm.category },
      create: { ...perm, isSystem: false },
    });
    permissionMap[perm.key] = created.id;
  }

  console.log('Seeding admin roles...');
  for (const [key, roleDef] of Object.entries(ROLES)) {
    const permissionIds = roleDef.permissions.map((pk) => permissionMap[pk]).filter(Boolean);

    const role = await prisma.adminRole.upsert({
      where: { name: key },
      update: {
        description: roleDef.description,
        isSystem: roleDef.isSystem,
        isDefault: roleDef.isDefault,
      },
      create: {
        name: key,
        description: roleDef.description,
        isSystem: roleDef.isSystem,
        isDefault: roleDef.isDefault,
      },
    });

    await prisma.adminRolePermission.deleteMany({ where: { roleId: role.id } });
    if (permissionIds.length > 0) {
      await prisma.adminRolePermission.createMany({
        data: permissionIds.map((pid) => ({
          roleId: role.id,
          permissionId: pid,
        })),
        skipDuplicates: true,
      });
    }

    console.log(`  Role "${key}" — ${permissionIds.length} permissions`);
  }

  console.log('Seeding system config...');
  for (const [key, config] of Object.entries(SYSTEM_CONFIG)) {
    await prisma.systemConfig.upsert({
      where: { key },
      update: { value: config.value, description: config.description },
      create: {
        key,
        value: config.value,
        description: config.description,
        updatedBy: 'seed-script',
      },
    });
  }

  const existingAdmins = await prisma.user.findMany({
    where: { roles: { has: 'admin' }, adminRoleId: null },
  });

  if (existingAdmins.length > 0) {
    const superRole = await prisma.adminRole.findUnique({ where: { name: 'super_admin' } });
    if (superRole) {
      console.log(`Assigning super_admin role to ${existingAdmins.length} existing admin(s)...`);
      for (const admin of existingAdmins) {
        await prisma.user.update({
          where: { id: admin.id },
          data: { adminRoleId: superRole.id },
        });
      }
    }
  }

  console.log('Seed complete!');
  console.log(`  Permissions: ${PERMISSIONS.length}`);
  console.log(`  Roles: ${Object.keys(ROLES).length}`);
  console.log(`  System Config: ${Object.keys(SYSTEM_CONFIG).length}`);
}

seed()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
