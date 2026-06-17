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
  { key: 'suppliers.view', name: 'View Suppliers', description: 'View supplier applications and profiles', category: 'Suppliers' },
  { key: 'suppliers.approve', name: 'Approve Suppliers', description: 'Approve or reject supplier applications', category: 'Suppliers' },
  { key: 'suppliers.suspend', name: 'Suspend Suppliers', description: 'Suspend or activate supplier accounts', category: 'Suppliers' },
  { key: 'reviews.view', name: 'View Reviews', description: 'View pending reviews for moderation', category: 'Reviews' },
  { key: 'reviews.moderate', name: 'Moderate Reviews', description: 'Approve or reject customer reviews', category: 'Reviews' },
  { key: 'payouts.view', name: 'View Payouts', description: 'View payout list and summary', category: 'Finance' },
  { key: 'payouts.export', name: 'Export Payouts', description: 'Export payout data to CSV/Excel', category: 'Finance' },
  { key: 'payouts.approve', name: 'Approve Payouts', description: 'Approve and release supplier payouts', category: 'Finance' },
  { key: 'payout-methods.view', name: 'View Payout Methods', description: 'View supplier payout methods', category: 'Finance' },
  { key: 'payout-methods.verify', name: 'Verify Payout Methods', description: 'Verify supplier payout method details', category: 'Finance' },
  { key: 'chat.suppliers', name: 'Chat — Suppliers', description: 'Access supplier chat conversations', category: 'Chat' },
  { key: 'chat.customers', name: 'Chat — Customers', description: 'Access customer chat conversations', category: 'Chat' },
  { key: 'settings.access', name: 'Access Settings', description: 'View platform settings page', category: 'Settings' },
  { key: 'roles.manage', name: 'Manage Roles', description: 'Create, edit, and delete admin roles', category: 'Admin' },
  { key: 'audit.view', name: 'View Audit Log', description: 'View and export system audit logs', category: 'Admin' },
  { key: 'notifications.view', name: 'View Notifications', description: 'View, acknowledge, and manage admin notification feed', category: 'Notifications' },
];

const ROLE_DEFINITIONS = [
  {
    name: 'super_admin',
    description: 'Full system access — all permissions granted',
    isSystem: true,
    permissionKeys: PERMISSIONS.map((p) => p.key),
  },
  {
    name: 'operations_admin',
    description: 'Day-to-day platform operations: suppliers, tours, reviews',
    isSystem: false,
    permissionKeys: [
      'dashboard.*',
      'dashboard.bookings',
      'dashboard.revenue',
      'analytics.view',
      'suppliers.view',
      'suppliers.approve',
      'suppliers.suspend',
      'tours.view',
      'reviews.view',
      'reviews.moderate',
      'chat.suppliers',
      'chat.customers',
      'notifications.view',
    ],
  },
  {
    name: 'finance_admin',
    description: 'Finance operations: payouts, payout methods, analytics',
    isSystem: false,
    permissionKeys: [
      'dashboard.*',
      'dashboard.revenue',
      'analytics.view',
      'payouts.view',
      'payouts.export',
      'payouts.approve',
      'payout-methods.view',
      'payout-methods.verify',
      'notifications.view',
    ],
  },
  {
    name: 'support_admin',
    description: 'Customer support: chats, reviews, user lookup',
    isSystem: false,
    permissionKeys: [
      'dashboard.*',
      'users.view',
      'reviews.view',
      'reviews.moderate',
      'chat.suppliers',
      'chat.customers',
      'notifications.view',
    ],
  },
  {
    name: 'analytics_viewer',
    description: 'Read-only access to analytics dashboards',
    isSystem: false,
    permissionKeys: [
      'dashboard.*',
      'dashboard.bookings',
      'dashboard.revenue',
      'analytics.view',
      'users.view',
      'tours.view',
      'suppliers.view',
      'reviews.view',
      'payouts.view',
      'payout-methods.view',
      'notifications.view',
    ],
  },
];

async function seedPermissions() {
  console.log('Seeding permissions...');

  const validKeys = PERMISSIONS.map(p => p.key);
  const stale = await prisma.adminPermission.findMany({
    where: { key: { notIn: validKeys } },
  });
  if (stale.length > 0) {
    console.log(`  Removing ${stale.length} stale permission(s)...`);
    const staleIds = stale.map(s => s.id);
    await prisma.adminRolePermission.deleteMany({
      where: { permissionId: { in: staleIds } },
    });
    await prisma.adminPermission.deleteMany({
      where: { id: { in: staleIds } },
    });
  }

  let count = 0;
  for (const perm of PERMISSIONS) {
    await prisma.adminPermission.upsert({
      where: { key: perm.key },
      update: { name: perm.name, description: perm.description, category: perm.category },
      create: { key: perm.key, name: perm.name, description: perm.description, category: perm.category, isSystem: false },
    });
    count++;
  }
  console.log(`  ${count} permissions synced`);
}

async function seedRoles() {
  console.log('Seeding roles...');

  for (const def of ROLE_DEFINITIONS) {
    const permissionIds = await Promise.all(
      def.permissionKeys.map(async (key) => {
        const perm = await prisma.adminPermission.findUnique({ where: { key } });
        if (!perm) throw new Error(`Permission "${key}" not found — did you forget to add it to PERMISSIONS?`);
        return perm.id;
      }),
    );

    const role = await prisma.adminRole.upsert({
      where: { name: def.name },
      update: { description: def.description },
      create: {
        name: def.name,
        description: def.description,
        isSystem: def.isSystem,
      },
    });

    const existingLinks = await prisma.adminRolePermission.findMany({
      where: { roleId: role.id },
    });
    const existingPermIds = existingLinks.map((l) => l.permissionId);

    const toAdd = permissionIds.filter((pid) => !existingPermIds.includes(pid));
    if (toAdd.length > 0) {
      await prisma.adminRolePermission.createMany({
        data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })),
      });
    }

    const toRemove = existingPermIds.filter((pid) => !permissionIds.includes(pid));
    if (toRemove.length > 0) {
      await prisma.adminRolePermission.deleteMany({
        where: { roleId: role.id, permissionId: { in: toRemove } },
      });
    }

    console.log(`  ${def.name}: ${def.permissionKeys.length} permissions (${toAdd.length} added, ${toRemove.length} removed)`);
  }
}

async function seedDefaultRoleAssignment() {
  const defaultRole = await prisma.adminRole.findFirst({ where: { isDefault: true } });
  if (defaultRole) {
    console.log(`  Default role: ${defaultRole.name}`);
  } else {
    console.log('  No default role configured.');
  }
}

async function seedDevUsers() {
  console.log('Seeding dev users...');

  const superAdminRole = await prisma.adminRole.findUnique({ where: { name: 'super_admin' } });

  if (!superAdminRole) {
    console.log('  Skipping (super_admin role not found)');
    return;
  }

  // Admin user — Peter Mensah
  const admin = await prisma.user.upsert({
    where: { firebaseUid: '8KOrbaTJQsfxdxNKenCaCl4IXxv1' },
    update: {
      name: 'Peter Mensah',
      email: 'expeditiongoltd@gmail.com',
      photoURL: 'https://res.cloudinary.com/dfpagrtoy/image/upload/w_80,q_80,f_auto/v1780670572/user-photos/vdrxzjwlzxhqs091mg5a.png',
      roles: ['admin'],
      active: true,
      adminRoleId: superAdminRole.id,
    },
    create: {
      firebaseUid: '8KOrbaTJQsfxdxNKenCaCl4IXxv1',
      name: 'Peter Mensah',
      email: 'expeditiongoltd@gmail.com',
      photoURL: 'https://res.cloudinary.com/dfpagrtoy/image/upload/w_80,q_80,f_auto/v1780670572/user-photos/vdrxzjwlzxhqs091mg5a.png',
      roles: ['admin'],
      active: true,
      adminRoleId: superAdminRole.id,
    },
  });
  console.log(`  Admin: ${admin.name} (${admin.email})`);

  // Supplier user — Gideon Wilson
  const supplier = await prisma.user.upsert({
    where: { firebaseUid: 'nkf2QYbJ5TXAGT6ZnDniPeEV5jF3' },
    update: {
      name: 'Gideon Wilson',
      email: 'rxsieon@gmail.com',
      photoURL: 'https://lh3.googleusercontent.com/a/ACg8ocJn1eM8pG9xWvmkEFOh4WYanf_sdeGDguVKchZ-R-_HagiVueRA=s96-c',
      phone: '0256674138',
      roles: ['supplier'],
      active: true,
      lastLoginAt: new Date('2026-06-16T17:03:36.515Z'),
      logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1780670572/user-photos/vdrxzjwlzxhqs091mg5a.png',
      notificationPreferences: {
        pushNotifications: { reviews: true, bookings: true, payments: true, systemAlerts: true },
        emailNotifications: { reviews: true, bookings: true, payments: true, systemAlerts: true },
      },
    },
    create: {
      firebaseUid: 'nkf2QYbJ5TXAGT6ZnDniPeEV5jF3',
      name: 'Gideon Wilson',
      email: 'rxsieon@gmail.com',
      photoURL: 'https://lh3.googleusercontent.com/a/ACg8ocJn1eM8pG9xWvmkEFOh4WYanf_sdeGDguVKchZ-R-_HagiVueRA=s96-c',
      phone: '0256674138',
      roles: ['supplier'],
      active: true,
      lastLoginAt: new Date('2026-06-16T17:03:36.515Z'),
      logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1780670572/user-photos/vdrxzjwlzxhqs091mg5a.png',
      notificationPreferences: {
        pushNotifications: { reviews: true, bookings: true, payments: true, systemAlerts: true },
        emailNotifications: { reviews: true, bookings: true, payments: true, systemAlerts: true },
      },
    },
  });

  await prisma.supplierProfile.upsert({
    where: { userId: supplier.id },
    update: {
      status: 'ACTIVE',
      businessInfo: { city: 'Accra', phone: '+233501234567', state: 'Greater Accra', taxId: 'TIN-GH-98765432', address: '42 Liberation Road, Accra', country: 'Ghana', website: 'https://gideonexpeditions.com', description: 'Premier tour operator specializing in authentic Ghanaian cultural experiences, wildlife safaris, and coastal adventures.', businessName: 'Gideon Expeditions', businessType: 'Individual', registrationNumber: 'CS1234567890' },
      operatingInfo: { hours: { friday: '08:00-18:00', monday: '08:00-18:00', sunday: 'closed', tuesday: '08:00-18:00', saturday: '09:00-15:00', thursday: '08:00-18:00', wednesday: '08:00-18:00' }, regions: ['West Africa', 'Ghana'], capacity: { maxGroupSize: 25, monthlyBookings: 80 }, languages: ['English', 'Twi', 'Ga'], serviceArea: 'Local & Regional', destinations: ['Accra', 'Kumasi', 'Cape Coast', 'Kakum', 'Elmina', 'Ada', 'Volta Region'], operatingSince: '2018' },
      representativeInfo: { email: 'rxsieon@gmail.com', phone: '+233501234567', idType: 'Passport', address: '42 Liberation Road, Accra, Ghana', fullName: 'Gideon Wilson', idNumber: 'GH-PP-87654321', position: 'Owner & Lead Guide' },
      businessDocuments: { insurance: 'https://cloudinary.com/gideon/insurance.pdf', identification: 'https://cloudinary.com/gideon/id.pdf', taxCertificate: 'https://cloudinary.com/gideon/tax.pdf', certificateOfRegistration: 'https://cloudinary.com/gideon/registration.pdf' },
      payoutInfo: { method: 'bank_transfer', bankCode: '013', bankName: 'GCB Bank', currency: 'GHS', accountName: 'Gideon Wilson', accountNumber: '1234567890123' },
      compliance: { termsAccepted: true, privacyAccepted: true, termsAcceptedAt: '2026-01-15T00:00:00.000Z', marketingConsent: true, codeOfConductAccepted: true, dataProcessingAccepted: true },
      totalEarnings: 48750.00,
      totalBookings: 47,
      averageRating: 4.70,
    },
    create: {
      userId: supplier.id,
      status: 'ACTIVE',
      businessInfo: { city: 'Accra', phone: '+233501234567', state: 'Greater Accra', taxId: 'TIN-GH-98765432', address: '42 Liberation Road, Accra', country: 'Ghana', website: 'https://gideonexpeditions.com', description: 'Premier tour operator specializing in authentic Ghanaian cultural experiences, wildlife safaris, and coastal adventures.', businessName: 'Gideon Expeditions', businessType: 'Individual', registrationNumber: 'CS1234567890' },
      operatingInfo: { hours: { friday: '08:00-18:00', monday: '08:00-18:00', sunday: 'closed', tuesday: '08:00-18:00', saturday: '09:00-15:00', thursday: '08:00-18:00', wednesday: '08:00-18:00' }, regions: ['West Africa', 'Ghana'], capacity: { maxGroupSize: 25, monthlyBookings: 80 }, languages: ['English', 'Twi', 'Ga'], serviceArea: 'Local & Regional', destinations: ['Accra', 'Kumasi', 'Cape Coast', 'Kakum', 'Elmina', 'Ada', 'Volta Region'], operatingSince: '2018' },
      representativeInfo: { email: 'rxsieon@gmail.com', phone: '+233501234567', idType: 'Passport', address: '42 Liberation Road, Accra, Ghana', fullName: 'Gideon Wilson', idNumber: 'GH-PP-87654321', position: 'Owner & Lead Guide' },
      businessDocuments: { insurance: 'https://cloudinary.com/gideon/insurance.pdf', identification: 'https://cloudinary.com/gideon/id.pdf', taxCertificate: 'https://cloudinary.com/gideon/tax.pdf', certificateOfRegistration: 'https://cloudinary.com/gideon/registration.pdf' },
      payoutInfo: { method: 'bank_transfer', bankCode: '013', bankName: 'GCB Bank', currency: 'GHS', accountName: 'Gideon Wilson', accountNumber: '1234567890123' },
      compliance: { termsAccepted: true, privacyAccepted: true, termsAcceptedAt: '2026-01-15T00:00:00.000Z', marketingConsent: true, codeOfConductAccepted: true, dataProcessingAccepted: true },
      totalEarnings: 48750.00,
      totalBookings: 47,
      averageRating: 4.70,
    },
  });
  console.log(`  Supplier: ${supplier.name} (${supplier.email}) — profile ACTIVE`);
}

async function main() {
  console.log('=== Admin RBAC Seed ===\n');
  await seedPermissions();
  console.log();
  await seedRoles();
  console.log();
  await seedDefaultRoleAssignment();
  console.log();
  await seedDevUsers();
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
