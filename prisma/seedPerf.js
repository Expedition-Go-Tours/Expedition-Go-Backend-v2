const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const prisma = new PrismaClient();

const uuid = (seed) => {
  const hex = crypto.createHash('md5').update(seed).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
};

const SUPER_ADMIN_ROLE_NAME = 'super_admin';

const SUPPLIER_ID = uuid('perf-supplier');
const CUSTOMER_ID = uuid('perf-customer');
const ADMIN_ID = uuid('perf-admin');
const TOUR_ID = uuid('perf-tour');
const STRIKE_CUSTOMER_ID = 'cus_perf_customer';
const TEST_PASSWORD = 'Password123!';

async function seedPerf() {
  console.log('=== Performance Test Seed ===\n');

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  // ── Super admin role ──────────────────────────────────────────────
  const superAdminRole = await prisma.adminRole.findUnique({
    where: { name: SUPER_ADMIN_ROLE_NAME },
  });
  if (!superAdminRole) {
    throw new Error(`"${SUPER_ADMIN_ROLE_NAME}" role not found — run node prisma/seed.js first`);
  }

  // ── Supplier user (password-based for login) ──────────────────────
  const supplier = await prisma.user.upsert({
    where: { id: SUPPLIER_ID },
    update: {},
    create: {
      id: SUPPLIER_ID,
      name: 'Perf Supplier',
      email: 'perf-supplier@test.com',
      passwordHash,
      authProvider: 'local',
      roles: ['supplier'],
      active: true,
      stripeCustomerId: 'cus_perf_supplier',
    },
  });
  console.log(`  Supplier: ${supplier.id}`);

  // ── Supplier profile (ACTIVE) ─────────────────────────────────────
  await prisma.supplierProfile.upsert({
    where: { userId: SUPPLIER_ID },
    update: {},
    create: {
      userId: SUPPLIER_ID,
      status: 'ACTIVE',
      businessInfo: {
        businessName: 'Perf Supplier Ltd',
        description: 'Performance test supplier',
        country: 'Kenya',
        city: 'Nairobi',
      },
      operatingInfo: {
        hours: { monday: '09:00-17:00', tuesday: '09:00-17:00', wednesday: '09:00-17:00', thursday: '09:00-17:00', friday: '09:00-17:00', saturday: 'closed', sunday: 'closed' },
        regions: ['East Africa'],
        capacity: { maxGroupSize: 30, monthlyBookings: 100 },
        languages: ['English'],
        serviceArea: 'Local & Regional',
        destinations: ['Nairobi', 'Masai Mara', 'Amboseli'],
        operatingSince: '2020',
      },
      representativeInfo: {
        fullName: 'Perf Supplier',
        email: 'perf-supplier@test.com',
        phone: '+254700000001',
        address: 'Nairobi, Kenya',
      },
      businessDocuments: {},
      payoutInfo: {
        method: 'bank_transfer',
        bankName: 'Test Bank',
        accountName: 'Perf Supplier',
        accountNumber: '0000000001',
      },
      compliance: {
        termsAccepted: true,
        privacyAccepted: true,
        termsAcceptedAt: new Date().toISOString(),
      },
      totalEarnings: 0,
      totalBookings: 0,
      averageRating: 0,
    },
  });
  console.log('  Supplier profile: ACTIVE');

  // ── Tour (ACTIVE) ─────────────────────────────────────────────────
  await prisma.tour.upsert({
    where: { id: TOUR_ID },
    update: {},
    create: {
      id: TOUR_ID,
      supplierId: SUPPLIER_ID,
      title: 'Perf Safari Adventure',
      slug: 'perf-safari-adventure',
      description: 'A performance test safari tour for benchmarking',
      status: 'ACTIVE',
      category: 'Adventure',
      city: 'Nairobi',
      country: 'Kenya',
      durationMinutes: 480,
      totalBookings: 0,
      totalRevenue: 0,
      reviewCount: 0,
      viewCount: 0,
      categorization: {
        type: 'safari',
        duration: { hours: 8, days: 1 },
        intensity: 'moderate',
        groupSize: { min: 1, max: 15 },
      },
      theme: { primary: 'Nature & Wildlife', secondary: [] },
      productContent: {
        highlights: ['Game drive', 'Lunch', 'Park fees'],
        includes: ['Park fees', 'Guide', 'Lunch'],
        excludes: ['Drinks', 'Tips'],
        location: { city: 'Nairobi', country: 'Kenya', region: 'East Africa' },
        whatToBring: ['Camera', 'Binoculars', 'Comfortable shoes'],
      },
      schedulesAndPricing: {
        pricingModel: 'perPerson',
        travelerDetails: {
          maxTravelersPerBooking: 15,
          ageGroups: [
            { label: 'Adult', minAge: 13, maxAge: 99 },
            { label: 'Child', minAge: 6, maxAge: 12 },
            { label: 'Infant', minAge: 0, maxAge: 5 },
          ],
        },
        pricingSchedules: {
          currency: 'USD',
          schedules: [{
            startDate: '2026-01-01',
            endDate: '2027-12-31',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            prices: [
              { ageGroup: 'Adult', retailPrice: 200, ourPrice: 180 },
              { ageGroup: 'Child', retailPrice: 100, ourPrice: 90 },
              { ageGroup: 'Infant', retailPrice: 0, ourPrice: 0 },
            ],
          }],
        },
      },
      bookingAndTickets: {
        confirmationMode: 'instant',
        ticketType: 'e-ticket',
        cancellationPolicy: { freeCancellationHours: 48, refundRate: 100 },
      },
    },
  });
  console.log(`  Tour: ${TOUR_ID} (perf-safari-adventure)`);

  // ── Customer user ─────────────────────────────────────────────────
  await prisma.user.upsert({
    where: { id: CUSTOMER_ID },
    update: {},
    create: {
      id: CUSTOMER_ID,
      name: 'Perf Customer',
      email: 'perf-customer@test.com',
      passwordHash,
      authProvider: 'local',
      roles: ['customer'],
      active: true,
      emailVerified: true,
      stripeCustomerId: STRIKE_CUSTOMER_ID,
    },
  });
  console.log(`  Customer: ${CUSTOMER_ID} (perf-customer@test.com / ${TEST_PASSWORD})`);

  // ── Admin user ────────────────────────────────────────────────────
  await prisma.user.upsert({
    where: { id: ADMIN_ID },
    update: {},
    create: {
      id: ADMIN_ID,
      name: 'Perf Admin',
      email: 'perf-admin@test.com',
      passwordHash,
      authProvider: 'local',
      roles: ['admin'],
      active: true,
      adminRoleId: superAdminRole.id,
    },
  });
  console.log(`  Admin: ${ADMIN_ID} (perf-admin@test.com / ${TEST_PASSWORD})`);

  // ── ExpeditionTour link ────────────────────────────────────────────
  await prisma.expeditionTour.upsert({
    where: { tourId: TOUR_ID },
    update: {},
    create: {
      tourId: TOUR_ID,
      displayOrder: 1,
      isFeatured: true,
      isActive: true,
      addedById: ADMIN_ID,
    },
  });
  console.log('  ExpeditionTour: linked');

  console.log('\nDone.');
}

seedPerf()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
