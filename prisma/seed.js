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
  { key: 'cancellations.approve', name: 'Approve Cancellations', description: 'Approve or reject supplier cancellation requests', category: 'Bookings' },
  { key: 'reviews.view', name: 'View Reviews', description: 'View pending reviews for moderation', category: 'Reviews' },
  { key: 'reviews.moderate', name: 'Moderate Reviews', description: 'Approve or reject customer reviews', category: 'Reviews' },
  { key: 'payouts.view', name: 'View Payouts', description: 'View payout list and summary', category: 'Finance' },
  { key: 'payouts.export', name: 'Export Payouts', description: 'Export payout data to CSV/Excel', category: 'Finance' },
  { key: 'payouts.approve', name: 'Approve Payouts', description: 'Approve and release supplier payouts', category: 'Finance' },
  { key: 'payouts.request', name: 'Request Payouts', description: 'Supplier-side: request payouts during withdrawal windows', category: 'Finance' },
  { key: 'disputes.view', name: 'View Disputes', description: 'View customer disputes queue', category: 'Finance' },
  { key: 'disputes.resolve', name: 'Resolve Disputes', description: 'Resolve or dismiss customer disputes', category: 'Finance' },
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
      'dashboard.*', 'dashboard.bookings', 'dashboard.revenue', 'analytics.view',
      'suppliers.view', 'suppliers.approve', 'suppliers.suspend', 'tours.view',
      'tours.approve', 'bookings.view', 'bookings.confirm-payment', 'cancellations.approve', 'reviews.view', 'reviews.moderate',
      'chat.suppliers', 'chat.customers', 'chat.expedition', 'notifications.view',
    ],
  },
  {
    name: 'finance_admin',
    description: 'Finance operations: payouts, payout methods, analytics',
    isSystem: false,
    permissionKeys: [
      'dashboard.*', 'dashboard.revenue', 'analytics.view', 'bookings.view',
      'bookings.confirm-payment', 'payouts.view', 'payouts.export', 'payouts.approve',
      'payouts.request', 'disputes.view', 'disputes.resolve',
      'payout-methods.view', 'payout-methods.verify', 'notifications.view',
    ],
  },
  {
    name: 'support_admin',
    description: 'Customer support: chats, reviews, user lookup',
    isSystem: false,
    permissionKeys: [
      'dashboard.*', 'users.view', 'bookings.view', 'reviews.view',
      'reviews.moderate', 'chat.suppliers', 'chat.customers', 'chat.expedition', 'notifications.view',
    ],
  },
  {
    name: 'analytics_viewer',
    description: 'Read-only access to analytics dashboards',
    isSystem: false,
    permissionKeys: [
      'dashboard.*', 'dashboard.bookings', 'dashboard.revenue', 'analytics.view',
      'users.view', 'tours.view', 'bookings.view', 'suppliers.view',
      'reviews.view', 'payouts.view', 'payout-methods.view', 'notifications.view',
    ],
  },
  {
    name: 'content_editor',
    description: 'Blog content management: create, edit, publish, archive articles',
    isSystem: false,
    permissionKeys: [
      'dashboard.*', 'blog.manage', 'reviews.view', 'notifications.view',
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

  const CLOUD = process.env.CLOUDINARY_CLOUD_NAME || 'dfpagrtoy';
  const DEFAULT_AVATAR = `https://res.cloudinary.com/${CLOUD}/image/upload/v1780670572/user-photos/vdrxzjwlzxhqs091mg5a.png`;
  const DEFAULT_DOCS = {
    insurance: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/seed/insurance.pdf`,
    identification: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/seed/id.pdf`,
    taxCertificate: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/seed/tax.pdf`,
    certificateOfRegistration: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/seed/registration.pdf`,
  };

  const admin = await prisma.user.upsert({
    where: { firebaseUid: '8KOrbaTJQsfxdxNKenCaCl4IXxv1' },
    update: {
      name: 'Peter Mensah',
      email: 'expeditiongoltd@gmail.com',
      photoURL: DEFAULT_AVATAR,
      roles: ['admin'],
      active: true,
      adminRoleId: superAdminRole.id,
    },
    create: {
      firebaseUid: '8KOrbaTJQsfxdxNKenCaCl4IXxv1',
      name: 'Peter Mensah',
      email: 'expeditiongoltd@gmail.com',
      photoURL: DEFAULT_AVATAR,
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
      logoUrl: DEFAULT_AVATAR,
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
      logoUrl: DEFAULT_AVATAR,
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
      businessDocuments: DEFAULT_DOCS,
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
      businessDocuments: DEFAULT_DOCS,
      payoutInfo: { method: 'bank_transfer', bankCode: '013', bankName: 'GCB Bank', currency: 'GHS', accountName: 'Gideon Wilson', accountNumber: '1234567890123' },
      compliance: { termsAccepted: true, privacyAccepted: true, termsAcceptedAt: '2026-01-15T00:00:00.000Z', marketingConsent: true, codeOfConductAccepted: true, dataProcessingAccepted: true },
      totalEarnings: 48750.00,
      totalBookings: 47,
      averageRating: 4.70,
    },
  });
  console.log(`  Supplier: ${supplier.name} (${supplier.email}) — profile ACTIVE`);

  // Dev user — EXP Developer
  const existingByEmail = await prisma.user.findUnique({ where: { email: 'expdeveloper2@gmail.com' } });
  if (existingByEmail && existingByEmail.firebaseUid !== 'aIQDqPPv97hN5QtqLCd5MLpgoJD3') {
    await prisma.user.update({
      where: { id: existingByEmail.id },
      data: { firebaseUid: 'aIQDqPPv97hN5QtqLCd5MLpgoJD3' },
    });
  }
  const devUser = await prisma.user.upsert({
    where: { firebaseUid: 'aIQDqPPv97hN5QtqLCd5MLpgoJD3' },
    update: {
      name: 'EXP Developer',
      email: 'expdeveloper2@gmail.com',
      photoURL: 'https://lh3.googleusercontent.com/a/ACg8ocJzg5iseoK0zFHT0mHSFX3_VBxmac4LDz9OiFnVz5bGS23NRag=s96-c',
      roles: ['customer', 'admin'],
      language: 'en',
      timezone: 'UTC',
      active: true,
      emailVerified: false,
      lastLoginAt: new Date('2026-07-13T11:34:46.070Z'),
      adminRoleId: superAdminRole.id,
      authProvider: 'local',
      refreshToken: '1865bb253b2cc5715d0bc2d788bfa66a93cb5e8056fa9023d5606f54c3f00c27',
    },
    create: {
      firebaseUid: 'aIQDqPPv97hN5QtqLCd5MLpgoJD3',
      name: 'EXP Developer',
      email: 'expdeveloper2@gmail.com',
      photoURL: 'https://lh3.googleusercontent.com/a/ACg8ocJzg5iseoK0zFHT0mHSFX3_VBxmac4LDz9OiFnVz5bGS23NRag=s96-c',
      roles: ['customer', 'admin'],
      language: 'en',
      timezone: 'UTC',
      active: true,
      emailVerified: false,
      lastLoginAt: new Date('2026-07-13T11:34:46.070Z'),
      adminRoleId: superAdminRole.id,
      authProvider: 'local',
      refreshToken: '1865bb253b2cc5715d0bc2d788bfa66a93cb5e8056fa9023d5606f54c3f00c27',
    },
  });
  console.log(`  Dev: ${devUser.name} (${devUser.email})`);
}

/**
 * A small but real catalogue.
 *
 * `__tests__/api/tours.test.js` asserts `Array.isArray(res.body.data.tours)`,
 * which passes against an empty table — the test was green without ever
 * reading a row. Seeding ACTIVE tours gives it something to return, and gives
 * `buildTourFilters` real values to filter on.
 *
 * The scalar columns matter: `buildTourFilters` and the filter-options
 * endpoint query `category`/`subcategory`/`city`/`region` directly, so a seed
 * that only populated the `categorization` JSON would still look empty to them.
 *
 * Each tour also gets an `ExpeditionTour` row. Brand-scoped queries join on it
 * (`JOIN "ExpeditionTour" et ON et."tourId" = t.id AND et."isActive" = true`),
 * so a Tour without one is invisible to `expeditionOnly` scopes — which is why
 * the region-fallback tests always fell through their guards and passed
 * without asserting anything.
 *
 * Idempotent: upserted by slug, so repeated seeds (CI, local) never duplicate.
 */
async function seedTours() {
  console.log('Seeding tours...');

  const supplier = await prisma.user.findFirst({
    where: { roles: { has: 'supplier' }, email: 'rxsieon@gmail.com' },
    select: { id: true },
  });
  if (!supplier) {
    console.log('  Skipping (supplier user not found)');
    return;
  }

  const IMG = (n) => `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dfpagrtoy'}/image/upload/v1/seed/tour-${n}.jpg`;

  const base = {
    status: 'ACTIVE',
    country: 'Ghana',
    photos: [IMG('a'), IMG('b')],
    coverPhoto: IMG('cover'),
    schedulesAndPricing: {},
    bookingAndTickets: {},
    aiProcessingStatus: 'PENDING',
  };

  const CATALOGUE = [
    {
      slug: 'cape-coast-castle-day-trip',
      title: 'Cape Coast Castle Day Trip',
      description: 'Guided tour of Cape Coast Castle and the Cape Coast township, with lunch at a local restaurant.',
      category: 'Cultural', subcategory: 'Historical Sites', activityType: 'Guided Tour',
      primaryTheme: 'History & Culture',
      city: 'Cape Coast', region: 'Central',
      latitude: 5.1053, longitude: -1.2466,
      tags: ['castle', 'history', 'guided'],
      categorization: { category: 'Cultural', subcategory: 'Historical Sites', activityType: 'Guided Tour' },
      theme: { primary: 'History & Culture' },
      productContent: { location: { city: 'Cape Coast', country: 'Ghana' }, duration: 'Full day' },
      itineraryRegions: ['Central Region'],
    },
    {
      slug: 'kakum-canopy-walk-adventure',
      title: 'Kakum Canopy Walk Adventure',
      description: 'Rainforest canopy walkway with a guided nature trail through Kakum National Park.',
      category: 'Adventure', subcategory: 'Nature & Wildlife', activityType: 'Half-Day Tour',
      primaryTheme: 'Nature & Outdoors',
      city: 'Cape Coast', region: 'Central',
      latitude: 5.3566, longitude: -1.3376,
      tags: ['forest', 'canopy', 'hiking'],
      categorization: { category: 'Adventure', subcategory: 'Nature & Wildlife', activityType: 'Half-Day Tour' },
      theme: { primary: 'Nature & Outdoors' },
      productContent: { location: { city: 'Cape Coast', country: 'Ghana' }, duration: 'Half day' },
      itineraryRegions: ['Central Region'],
    },
    {
      slug: 'accra-city-highlights-tour',
      title: 'Accra City Highlights Tour',
      description: 'Independence Square, Makola Market and Jamestown lighthouse in one day.',
      category: 'City Tour', subcategory: 'Urban Exploration', activityType: 'Full-Day Tour',
      primaryTheme: 'Urban Exploration',
      city: 'Accra', region: 'Greater Accra',
      latitude: 5.6037, longitude: -0.1870,
      tags: ['city', 'culture', 'photography'],
      categorization: { category: 'City Tour', subcategory: 'Urban Exploration', activityType: 'Full-Day Tour' },
      theme: { primary: 'Urban Exploration' },
      productContent: { location: { city: 'Accra', country: 'Ghana' }, duration: 'Full day' },
      itineraryRegions: ['Greater Accra Region'],
    },
    {
      slug: 'aburi-botanical-gardens-escape',
      title: 'Aburi Botanical Gardens Escape',
      description: 'A slow day in the Aburi hills: botanical gardens, craft market and mountain views.',
      category: 'Nature', subcategory: 'Gardens', activityType: 'Half-Day Tour',
      primaryTheme: 'Relaxation',
      city: 'Aburi', region: 'Eastern',
      latitude: 5.8500, longitude: -0.1771,
      tags: ['gardens', 'relaxation', 'hills'],
      categorization: { category: 'Nature', subcategory: 'Gardens', activityType: 'Half-Day Tour' },
      theme: { primary: 'Relaxation' },
      productContent: { location: { city: 'Aburi', country: 'Ghana' }, duration: 'Half day' },
      itineraryRegions: ['Eastern Region'],
    },
    {
      slug: 'volta-waterfall-hike',
      title: 'Volta Waterfall Hike',
      description: 'Full-day hike to Wli Waterfalls through the Volta hills, with a local guide.',
      category: 'Adventure', subcategory: 'Hiking', activityType: 'Full-Day Tour',
      primaryTheme: 'Nature & Outdoors',
      city: 'Hohoe', region: 'Volta',
      latitude: 7.1500, longitude: 0.4700,
      tags: ['hiking', 'waterfall', 'volta'],
      categorization: { category: 'Adventure', subcategory: 'Hiking', activityType: 'Full-Day Tour' },
      theme: { primary: 'Nature & Outdoors' },
      productContent: { location: { city: 'Hohoe', country: 'Ghana' }, duration: 'Full day' },
      itineraryRegions: ['Volta Region'],
    },
    {
      slug: 'kumasi-cultural-weekend',
      title: 'Kumasi Cultural Weekend',
      description: 'Manhyia Palace Museum, Kejetia Market and the Ashanti cultural centre.',
      category: 'Cultural', subcategory: 'Museums', activityType: 'Weekend Tour',
      primaryTheme: 'History & Culture',
      city: 'Kumasi', region: 'Ashanti',
      latitude: 6.6885, longitude: -1.6244,
      tags: ['ashanti', 'museum', 'market'],
      categorization: { category: 'Cultural', subcategory: 'Museums', activityType: 'Weekend Tour' },
      theme: { primary: 'History & Culture' },
      productContent: { location: { city: 'Kumasi', country: 'Ghana' }, duration: '2 days' },
      itineraryRegions: ['Ashanti Region'],
    },
  ];

  for (const entry of CATALOGUE) {
    const data = { ...base, ...entry, supplierId: supplier.id };
    const tour = await prisma.tour.upsert({
      where: { slug: entry.slug },
      update: data,
      create: data,
    });
    // Brand visibility: without this row the tour is invisible to every
    // `expeditionOnly` query even though it is ACTIVE.
    await prisma.expeditionTour.upsert({
      where: { tourId: tour.id },
      update: { isActive: true },
      create: { tourId: tour.id, isActive: true },
    });
  }

  console.log(`  ${CATALOGUE.length} ACTIVE tours (+ ExpeditionTour rows)`);
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
  console.log();
  await seedTours();
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
